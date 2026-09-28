import 'server-only';

import { randomInt } from 'node:crypto';

import type { Prisma, ScanEntity } from '@prisma/client';

import { audit } from '@/lib/audit';
import { can } from '@/lib/auth/rbac';
import type { Permission } from '@/lib/auth/permissions';
import type { SessionUser } from '@/lib/auth/session';
import { isUniqueConstraintError, prisma, toNumber } from '@/lib/db';
import { ConflictError, NotFoundError } from '@/lib/errors';
import {
  CODE_ALPHABET,
  CODE_LAENGE,
  internerInhalt,
  scanAnzeige,
  scanEinordnen,
  type ScanEingabe,
} from '@/lib/scan/kennung';
import {
  einsatzRegeln,
  geraetRegeln,
  materialRegeln,
  rechnungRegeln,
  type ScanAktionSchluessel,
  type ScanVerweis,
} from '@/lib/scan/regeln';
import { formatCurrency } from '@/lib/utils';
import { propertyVisibilityWhere } from '@/server/services/property.service';

/**
 * Scanplattform (2026-09-26): aus einem gescannten Text einen Datensatz
 * machen — oder ausdrücklich keinen.
 *
 * ---------------------------------------------------------------------------
 *  Der Weg, und wo jede Prüfung sitzt
 * ---------------------------------------------------------------------------
 *
 *   SCAN → EINORDNEN → PRÜFEN → AUFLÖSEN → BERECHTIGEN → ZEIGEN
 *        → MENSCH WÄHLT → SERVER PRÜFT ERNEUT
 *
 *  • **Einordnen und Prüfen** macht `scanEinordnen` (rein, ohne Datenbank).
 *  • **Auflösen und Berechtigen** geschieht hier *in einem Schritt*: Jede
 *    Abfrage trägt `organizationId` und die Sichtbarkeitsbedingung der Rolle
 *    im `where`. Ein Datensatz, den die Rolle nicht lesen darf, wird gar nicht
 *    erst geladen — nicht geladen und dann ausgeblendet.
 *  • **Zeigen**: Die Antwort nennt Treffer mit Link und die *Schlüssel* der
 *    Schnellaktionen, die die Rolle ausführen dürfte. Sie führt nichts aus.
 *  • **Ausführen** läuft über die bestehenden Endpunkte (`/api/materials/…/
 *    movements`, `/api/equipment/…/status`, `/api/time/clock-in`, …) mit
 *    ihren eigenen Rechten, Schemas, Sperren und Protokolleinträgen. Die
 *    Scanplattform hat **keinen** eigenen Schreibweg für Fachdaten — ein
 *    zweiter Weg wäre eine zweite Sicherheitsstufe (dieselbe Begründung wie
 *    „keine Server Actions für Schreibzugriffe", `docs/ARCHITECTURE.md`).
 *
 * ---------------------------------------------------------------------------
 *  Was bewusst gleich aussieht
 * ---------------------------------------------------------------------------
 *
 * „Unbekannt", „fremde Organisation", „kein Leserecht" und „gelöscht" geben
 * dieselbe Antwort: keine Treffer. Unterschiedliche Antworten würden verraten,
 * dass es hinter einem Code etwas gibt — genau die Auskunft, die jemand mit
 * einem gefundenen Etikett und ohne Recht nicht bekommen soll. Einzig ein
 * **gesperrter eigener Code** bekommt einen Hinweis, und zwar erst *nachdem*
 * das Leserecht für den Datensatz feststeht: Wer das Gerät ohnehin sehen darf,
 * soll wissen, dass der Aufkleber ersetzt werden muss.
 *
 * Aufgelöste Scans werden nicht protokolliert — ein Scan liest nur, und ein
 * Protokoll jeder Kamerabewegung wäre Rauschen, das die wichtigen Einträge
 * verdeckt. Protokolliert wird, was danach *geändert* wird (von den
 * Endpunkten, die es ändern), sowie Erzeugen und Sperren eines Codes.
 * Kamerabilder verlassen das Gerät nie: Erkannt wird im Browser, gesendet
 * wird nur der erkannte Text.
 */

export type ScanTrefferArt = 'MATERIAL' | 'GERAET' | 'EINSATZ' | 'RECHNUNG' | 'KUNDSCHAFT' | 'OBJEKT' | 'VERTRAG';

export interface ScanAktion {
  schluessel: ScanAktionSchluessel;
  label: string;
  /** Auswahl für die Maske — nur „Zuteilen" (aktive Personen). */
  optionen?: { value: string; label: string }[];
}

export interface ScanTreffer {
  art: ScanTrefferArt;
  id: string;
  titel: string;
  untertitel: string | null;
  /** Detailseite im Bereich der Rolle — `null`, wenn es dort keine gibt. */
  link: string | null;
  merkmale: { label: string; wert: string }[];
  aktionen: ScanAktion[];
  /**
   * Weitere Ziele zum *Lesen* (PDF, Rapport) — seit 2026-09-28. Nie ein
   * Schreibweg; jedes Ziel prüft beim Abruf selbst (`src/lib/scan/regeln.ts`).
   */
  verweise: ScanVerweis[];
  /** Etikettseite, wenn die Rolle den Datensatz pflegen darf. */
  etikett: string | null;
}

export interface ScanErgebnis {
  eingabe: { art: ScanEingabe['art']; anzeige: string; format: string | null };
  treffer: ScanTreffer[];
  hinweis: string | null;
  /** Unbekannter Herstellerstrichcode, und die Rolle darf Material anlegen. */
  neuerArtikel: { barcode: string; format: string } | null;
}

const HOECHSTENS = 5;

/** Welches Recht braucht, wer ein Etikett für diese Art erzeugt oder sperrt. */
export const ETIKETT_RECHT: Record<ScanEntity, Permission> = {
  MATERIAL: 'inventory:manage',
  EQUIPMENT: 'equipment:manage',
  PROPERTY: 'property:update',
  JOB: 'job:update',
};

const GERAET_STATUS: Record<string, string> = {
  AVAILABLE: 'verfügbar',
  IN_USE: 'im Einsatz',
  MAINTENANCE: 'in Wartung',
  RETIRED: 'ausgemustert',
};

interface Kontext {
  org: string;
  session: SessionUser;
  darf: (p: Permission) => boolean;
  /** Büro (Administration) oder Aussendienst (Portal) — entscheidet Links und Umfang. */
  buero: boolean;
}

function kontext(organizationId: string, session: SessionUser): Kontext {
  return {
    org: organizationId,
    session,
    darf: (p) => can(session.role, p),
    // Dieselbe Linie wie `propertyVisibilityWhere`: Mitarbeitende halten
    // `customer:read` für den Einsatzrapport, nicht für die Kundenakte.
    buero: session.role !== 'EMPLOYEE',
  };
}

// ---------------------------------------------------------------------------
//  Auflösen je Art — jede Funktion lädt nur, was die Rolle lesen darf
// ---------------------------------------------------------------------------

async function materialTreffer(k: Kontext, where: Prisma.MaterialWhereInput): Promise<ScanTreffer[]> {
  if (!k.darf('inventory:read')) return [];
  const materialien = await prisma.material.findMany({ where: { ...where, organizationId: k.org }, take: HOECHSTENS, orderBy: { name: 'asc' } });
  if (materialien.length === 0) return [];
  const summen = await prisma.stockMovement.groupBy({
    by: ['materialId'],
    where: { organizationId: k.org, materialId: { in: materialien.map((m) => m.id) } },
    _sum: { quantity: true },
  });
  const bestand = new Map(summen.map((s) => [s.materialId, toNumber(s._sum.quantity)]));
  const pflegen = k.darf('inventory:manage');
  return materialien.map((m) => {
    const b = bestand.get(m.id) ?? 0;
    const melde = toNumber(m.minStock);
    return {
      art: 'MATERIAL' as const,
      id: m.id,
      titel: m.name,
      untertitel: m.sku,
      // Material hat keine Detailseite; der Anker springt zur Zeile in der
      // Liste. Inaktive Artikel stehen dort nicht — dann kein Link.
      link: m.active ? `/admin/material#material-${m.id}` : null,
      merkmale: [
        { label: 'Bestand', wert: `${b.toLocaleString('de-CH')} ${m.unit}` },
        { label: 'Meldebestand', wert: `${melde.toLocaleString('de-CH')} ${m.unit}` },
        ...(melde > 0 && b <= melde ? [{ label: 'Hinweis', wert: 'Am oder unter dem Meldebestand — nachbestellen.' }] : []),
        ...(m.barcode ? [{ label: 'Strichcode', wert: m.barcode }] : []),
        ...(m.active ? [] : [{ label: 'Status', wert: 'inaktiv' }]),
      ],
      // Ein inaktiver Artikel wird nicht mehr bewegt; die Liste blendet ihn
      // aus, der Scan zeigt ihn — ohne Buchungsknöpfe (`materialRegeln`).
      ...materialRegeln({ darf: k.darf, aktiv: m.active }),
      etikett: pflegen ? `/admin/etikett/MATERIAL/${m.id}` : null,
    };
  });
}

/**
 * Die Personen für „Zuteilen" — nur geladen, wenn ein Treffer die Aktion
 * tatsächlich anbietet. Derselbe Kreis wie in der Geräteliste und in
 * `assignEquipment` (aktiv, eigene Organisation); der Endpunkt prüft ihn beim
 * Senden noch einmal, eine inzwischen ausgetretene Person ergibt dort 404.
 */
async function zuteilbarePersonen(org: string): Promise<{ value: string; label: string }[]> {
  const personal = await prisma.employee.findMany({
    where: { organizationId: org, active: true },
    select: { id: true, employeeNumber: true, user: { select: { firstName: true, lastName: true } } },
    orderBy: { employeeNumber: 'asc' },
  });
  return personal.map((p) => ({ value: p.id, label: `${p.user.firstName} ${p.user.lastName} (${p.employeeNumber})` }));
}

async function geraetTreffer(k: Kontext, where: Prisma.EquipmentWhereInput): Promise<ScanTreffer[]> {
  if (!k.darf('equipment:read')) return [];
  const geraete = await prisma.equipment.findMany({
    where: { ...where, organizationId: k.org },
    take: HOECHSTENS,
    orderBy: { inventoryNumber: 'asc' },
    include: { assignedEmployee: { select: { user: { select: { firstName: true, lastName: true } } } } },
  });
  const pflegen = k.darf('equipment:manage');
  const regeln = geraete.map((g) => geraetRegeln({ darf: k.darf, status: g.status, zugeteilt: Boolean(g.assignedEmployeeId) }));
  const personen = regeln.some((r) => r.aktionen.some((a) => a.schluessel === 'geraet.zuteilen')) ? await zuteilbarePersonen(k.org) : [];
  return geraete.map((g, i) => {
    const { aktionen: regelAktionen, verweise } = regeln[i]!;
    const aktionen: ScanAktion[] = regelAktionen.map((a) => (a.schluessel === 'geraet.zuteilen' ? { ...a, optionen: personen } : a));
    const person = g.assignedEmployee?.user;
    return {
      art: 'GERAET' as const,
      id: g.id,
      titel: g.name,
      untertitel: g.inventoryNumber,
      link: `/admin/geraete#geraet-${g.id}`,
      merkmale: [
        { label: 'Status', wert: GERAET_STATUS[g.status] ?? g.status },
        ...(person ? [{ label: 'Zugeteilt', wert: `${person.firstName} ${person.lastName}` }] : []),
        ...(g.nextMaintenanceOn ? [{ label: 'Nächste Wartung', wert: g.nextMaintenanceOn.toISOString().slice(0, 10).split('-').reverse().join('.') }] : []),
      ],
      aktionen,
      verweise,
      etikett: pflegen ? `/admin/etikett/EQUIPMENT/${g.id}` : null,
    };
  });
}

async function einsatzTreffer(k: Kontext, where: Prisma.JobWhereInput): Promise<ScanTreffer[]> {
  // Büro: alle Einsätze mit `job:read`. Aussendienst: nur die eigenen — die
  // Zuteilung steht in der Abfrage, nicht in der Anzeige.
  let sicht: Prisma.JobWhereInput;
  if (k.darf('job:read') && k.buero) sicht = {};
  else if (k.darf('job:read_assigned')) sicht = { assignments: { some: { employeeId: k.session.profileId ?? '__keines__' } } };
  else return [];

  const einsaetze = await prisma.job.findMany({
    where: { AND: [where, sicht, { organizationId: k.org, deletedAt: null }] },
    take: HOECHSTENS,
    orderBy: { scheduledStart: 'desc' },
    select: { id: true, number: true, title: true, status: true, scheduledStart: true, assignments: { select: { employeeId: true } } },
  });
  const zeit = new Intl.DateTimeFormat('de-CH', { timeZone: 'Europe/Zurich', dateStyle: 'medium', timeStyle: 'short' });
  /*
    Läuft die *eigene* Zeit auf einem dieser Einsätze? Dann bietet der Treffer
    „Ausstempeln" statt „Einstempeln" (`einsatzRegeln`). Gefragt wird nur mit
    eigenem Profil und Stempelrecht, und nur nach der eigenen Person — fremde
    Zeiterfassungen verraten sich so nicht, auch nicht dem Büro.
  */
  const laufend =
    k.session.profileId && k.darf('timetracking:own') && einsaetze.length > 0
      ? new Set(
          (
            await prisma.timeEntry.findMany({
              where: { employeeId: k.session.profileId, endedAt: null, jobId: { in: einsaetze.map((j) => j.id) } },
              select: { jobId: true },
            })
          ).map((t) => t.jobId),
        )
      : new Set<string | null>();
  return einsaetze.map((j) => {
    const zugeteilt = Boolean(k.session.profileId) && j.assignments.some((a) => a.employeeId === k.session.profileId);
    return {
      art: 'EINSATZ' as const,
      id: j.id,
      titel: `${j.number} — ${j.title}`,
      untertitel: zeit.format(j.scheduledStart),
      link: k.buero ? `/admin/einsaetze/${j.id}` : `/portal/einsaetze/${j.id}`,
      merkmale: [{ label: 'Status', wert: j.status }],
      ...einsatzRegeln({ darf: k.darf, buero: k.buero, id: j.id, status: j.status, zugeteilt, laeuftHier: laufend.has(j.id) }),
      etikett: k.darf('job:update') && k.buero ? `/admin/etikett/JOB/${j.id}` : null,
    };
  });
}

async function rechnungTreffer(k: Kontext, where: Prisma.InvoiceWhereInput): Promise<ScanTreffer[]> {
  if (!k.buero || !k.darf('invoice:read')) return [];
  const rechnungen = await prisma.invoice.findMany({
    where: { ...where, organizationId: k.org, deletedAt: null },
    take: HOECHSTENS,
    orderBy: { createdAt: 'desc' },
    select: { id: true, number: true, status: true, billToName: true, billToCompany: true, grossTotal: true, balance: true },
  });
  return rechnungen.map((r) => ({
    art: 'RECHNUNG' as const,
    id: r.id,
    titel: r.number,
    untertitel: r.billToCompany ?? r.billToName,
    link: `/admin/rechnungen/${r.id}`,
    merkmale: [
      { label: 'Status', wert: r.status },
      { label: 'Betrag', wert: formatCurrency(toNumber(r.grossTotal)) },
      { label: 'Offen', wert: formatCurrency(toNumber(r.balance)) },
    ],
    ...rechnungRegeln({ darf: k.darf, id: r.id, status: r.status }),
    etikett: null,
  }));
}

/**
 * Vertrag über seine Nummer (seit 2026-09-28) — wer einen ausgedruckten
 * Vertrag oder eine Vertragsrechnung in der Hand hat, tippt oder scannt die
 * Nummer (Code 128 eines Handscanners ist Text). Nur im Büro und nur mit
 * `contract:read`: Mitarbeitende halten das Recht nicht, die Kundschaft hat
 * keinen Scanner. Ein Entwurf hat noch keine Nummer und ist darum nie ein
 * Treffer — die Nummer vergibt erst das Aktivieren.
 *
 * Keine Schnellaktion: Jeder Schritt am Vertrag (Pausieren, Kündigen, neue
 * Fassung) verlangt eine Begründung und einen Blick auf Laufzeit und
 * Konditionen, also die Vertragsseite — nicht eine Maske im Scandialog.
 */
async function vertragTreffer(k: Kontext, where: Prisma.ContractWhereInput): Promise<ScanTreffer[]> {
  if (!k.buero || !k.darf('contract:read')) return [];
  const vertraege = await prisma.contract.findMany({
    where: { AND: [where, { organizationId: k.org, deletedAt: null, number: { not: null } }] },
    take: HOECHSTENS,
    orderBy: { createdAt: 'desc' },
    select: { id: true, number: true, title: true, status: true, customer: { select: { companyName: true, firstName: true, lastName: true } } },
  });
  return vertraege.map((v) => ({
    art: 'VERTRAG' as const,
    id: v.id,
    titel: `${v.number} — ${v.title}`,
    untertitel: v.customer.companyName ?? `${v.customer.firstName} ${v.customer.lastName}`,
    link: `/admin/vertraege/${v.id}`,
    merkmale: [{ label: 'Status', wert: v.status }],
    aktionen: [],
    verweise: [],
    etikett: null,
  }));
}

async function kundschaftTreffer(k: Kontext, where: Prisma.CustomerWhereInput): Promise<ScanTreffer[]> {
  if (!k.buero || !k.darf('customer:read')) return [];
  const kunden = await prisma.customer.findMany({
    where: { ...where, organizationId: k.org, deletedAt: null },
    take: HOECHSTENS,
    select: { id: true, number: true, firstName: true, lastName: true, companyName: true },
  });
  return kunden.map((c) => ({
    art: 'KUNDSCHAFT' as const,
    id: c.id,
    titel: c.companyName ?? `${c.firstName} ${c.lastName}`,
    untertitel: c.number,
    link: `/admin/kunden/${c.id}`,
    merkmale: [],
    aktionen: [],
    verweise: [],
    etikett: null,
  }));
}

async function objektTreffer(k: Kontext, where: Prisma.PropertyWhereInput): Promise<ScanTreffer[]> {
  if (!k.darf('property:read')) return [];
  const objekte = await prisma.property.findMany({
    where: { AND: [propertyVisibilityWhere(k.session, k.org), where] },
    take: HOECHSTENS,
    select: {
      id: true,
      label: true,
      customerId: true,
      address: { select: { street: true, streetNo: true, postalCode: true, city: true } },
      customer: { select: { companyName: true, firstName: true, lastName: true } },
    },
  });
  // Im Aussendienst gibt es keine Objektseite; der nächste eigene Einsatz am
  // Objekt ist das, was man vor der Tür eines Hauses braucht.
  const naechste = k.buero
    ? new Map<string, string>()
    : new Map(
        (
          await prisma.job.findMany({
            where: {
              organizationId: k.org,
              deletedAt: null,
              propertyId: { in: objekte.map((o) => o.id) },
              assignments: { some: { employeeId: k.session.profileId ?? '__keines__' } },
              scheduledEnd: { gte: new Date(Date.now() - 12 * 3600_000) },
            },
            orderBy: { scheduledStart: 'asc' },
            select: { id: true, propertyId: true },
          })
        )
          .reverse()
          .map((j) => [j.propertyId!, j.id]),
      );
  return objekte.map((o) => ({
    art: 'OBJEKT' as const,
    id: o.id,
    titel: `${o.customer.companyName ?? `${o.customer.firstName} ${o.customer.lastName}`} — ${o.label}`,
    untertitel: o.address ? `${`${o.address.street} ${o.address.streetNo ?? ''}`.trim()}, ${o.address.postalCode} ${o.address.city}` : null,
    link: k.buero ? `/admin/kunden/${o.customerId}` : naechste.has(o.id) ? `/portal/einsaetze/${naechste.get(o.id)}` : null,
    merkmale: [],
    aktionen: [],
    verweise: [],
    etikett: k.buero && k.darf('property:update') ? `/admin/etikett/PROPERTY/${o.id}` : null,
  }));
}

/**
 * Exakte Nummern — kein `contains`. Die globale Suche findet Teilwörter; ein
 * Scan meint genau einen Gegenstand, und „RE-2026-0001" darf nicht
 * „RE-2026-00012" liefern.
 */
async function nachNummer(k: Kontext, text: string): Promise<ScanTreffer[]> {
  const gleich = { equals: text, mode: 'insensitive' as const };
  const gruppen = await Promise.all([
    materialTreffer(k, { OR: [{ sku: gleich }, { barcode: text }] }),
    geraetTreffer(k, { OR: [{ inventoryNumber: gleich }, { serialNumber: gleich }] }),
    einsatzTreffer(k, { number: gleich }),
    rechnungTreffer(k, { number: gleich }),
    kundschaftTreffer(k, { number: gleich }),
    vertragTreffer(k, { number: gleich }),
  ]);
  return gruppen.flat();
}

async function nachInternemCode(k: Kontext, code: string): Promise<{ treffer: ScanTreffer[]; gesperrt: boolean }> {
  const eintrag = await prisma.scanCode.findFirst({ where: { code, organizationId: k.org } });
  if (!eintrag) return { treffer: [], gesperrt: false };
  const id = eintrag.entityId;
  const treffer =
    eintrag.entityType === 'MATERIAL'
      ? await materialTreffer(k, { id })
      : eintrag.entityType === 'EQUIPMENT'
        ? await geraetTreffer(k, { id })
        : eintrag.entityType === 'JOB'
          ? await einsatzTreffer(k, { id })
          : await objektTreffer(k, { id });
  // Gesperrt, aber lesbar: zeigen, *dass* der Aufkleber ungültig ist, und den
  // Datensatz ohne Schnellaktionen — wer damit arbeitet, soll das neue
  // Etikett benutzen, nicht das alte weiter.
  if (eintrag.revokedAt) {
    return { treffer: treffer.map((t) => ({ ...t, aktionen: [] })), gesperrt: treffer.length > 0 };
  }
  return { treffer, gesperrt: false };
}

export async function scanAufloesen(params: { organizationId: string; session: SessionUser; text: string }): Promise<ScanErgebnis> {
  const k = kontext(params.organizationId, params.session);
  const eingabe = scanEinordnen(params.text);
  const kopf = (format: string | null = null) => ({ art: eingabe.art, anzeige: scanAnzeige(params.text), format });
  const leer = (hinweis: string | null, format: string | null = null): ScanErgebnis => ({ eingabe: kopf(format), treffer: [], hinweis, neuerArtikel: null });

  switch (eingabe.art) {
    case 'UNGUELTIG':
      return leer(`Nicht lesbar: ${eingabe.grund}`);
    case 'ADRESSE':
      // Keine Auflösung, kein Link. Die Adresse wird nicht einmal angezeigt
      // ausser als gekürzter Text in `anzeige`.
      return leer('Der Code enthält eine Adresse. Clenaris öffnet gescannte Adressen nicht — sie könnten auf eine fremde Seite führen.');
    case 'INTERN': {
      const { treffer, gesperrt } = await nachInternemCode(k, eingabe.code);
      return {
        eingabe: kopf('Clenaris-Etikett'),
        treffer,
        hinweis: gesperrt ? 'Dieses Etikett ist gesperrt. Bitte ein neues drucken und das alte entfernen.' : treffer.length === 0 ? 'Kein Datensatz zu diesem Etikett.' : null,
        neuerArtikel: null,
      };
    }
    case 'GTIN': {
      const treffer = [...(await materialTreffer(k, { barcode: eingabe.gtin }))];
      // Eine achtstellige Artikelnummer kann zufällig eine gültige
      // Prüfziffer haben — dann zusätzlich als Nummer suchen.
      const weitere = (await nachNummer(k, params.text.trim())).filter((t) => !treffer.some((x) => x.id === t.id));
      const alle = [...treffer, ...weitere];
      const anlegen = alle.length === 0 && k.darf('inventory:manage');
      return {
        eingabe: kopf(eingabe.format.replace('_', '-')),
        treffer: alle,
        hinweis: alle.length === 0 ? 'Artikel nicht gefunden.' : null,
        neuerArtikel: anlegen ? { barcode: eingabe.gtin, format: eingabe.format } : null,
      };
    }
    case 'QR_RECHNUNG':
    case 'QR_REFERENZ': {
      /*
        Zwei Formen der eigenen QR-Referenz sind im Umlauf (`buildQrReference`
        in `src/lib/pdf/swiss-qr.ts`): bis 2026-09-27 nur die laufende Nummer,
        mit sechs führenden Nullen; seither Jahr und laufende Nummer. Gesucht
        wird darum **nicht** nach einem nachgerechneten Aufbau, sondern genau
        nach der gespeicherten Referenz — sie ist, was auf dem ausgestellten
        (unveränderlichen) Beleg steht und was die Bank zurückmeldet. So findet
        der Scan beide Formen, ohne dass jemand die alte je umrechnen müsste.
      */
      const referenz = eingabe.referenz;
      const nummer = eingabe.art === 'QR_RECHNUNG' ? eingabe.rechnungsnummer : null;
      const bedingungen: Prisma.InvoiceWhereInput[] = [];
      if (referenz) bedingungen.push({ qrReference: referenz });
      if (nummer) bedingungen.push({ number: nummer });
      const treffer = bedingungen.length ? await rechnungTreffer(k, { OR: bedingungen }) : [];
      return {
        eingabe: kopf('QR-Rechnung'),
        treffer,
        hinweis: treffer.length === 0 ? 'Keine eigene Rechnung zu diesem Zahlteil.' : null,
        neuerArtikel: null,
      };
    }
    case 'TEXT': {
      const treffer = await nachNummer(k, eingabe.text);
      return { eingabe: kopf(), treffer, hinweis: treffer.length === 0 ? 'Nichts gefunden.' : null, neuerArtikel: null };
    }
  }
}

// ---------------------------------------------------------------------------
//  Etikettcodes
// ---------------------------------------------------------------------------

function zufallscode(): string {
  let s = '';
  for (let i = 0; i < CODE_LAENGE; i += 1) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

/** Gibt es den Datensatz in dieser Organisation? Sonst 404 — auch für fremde IDs. */
async function datensatzPruefen(organizationId: string, art: ScanEntity, id: string): Promise<string> {
  const titel =
    art === 'MATERIAL'
      ? (await prisma.material.findFirst({ where: { id, organizationId }, select: { name: true, sku: true } }).then((m) => m && `${m.name} · ${m.sku}`))
      : art === 'EQUIPMENT'
        ? (await prisma.equipment.findFirst({ where: { id, organizationId }, select: { name: true, inventoryNumber: true } }).then((g) => g && `${g.name} · ${g.inventoryNumber}`))
        : art === 'JOB'
          ? (await prisma.job.findFirst({ where: { id, organizationId, deletedAt: null }, select: { number: true } }).then((j) => j?.number ?? null))
          : (await prisma.property.findFirst({ where: { id, deletedAt: null, customer: { organizationId } }, select: { label: true } }).then((p) => p?.label ?? null));
  if (!titel) throw new NotFoundError('Datensatz');
  return titel;
}

export async function aktiverCode(organizationId: string, art: ScanEntity, id: string) {
  return prisma.scanCode.findFirst({ where: { organizationId, entityType: art, entityId: id, revokedAt: null } });
}

export async function etikettDaten(organizationId: string, art: ScanEntity, id: string) {
  const titel = await datensatzPruefen(organizationId, art, id);
  const code = await aktiverCode(organizationId, art, id);
  const gesperrt = await prisma.scanCode.count({ where: { organizationId, entityType: art, entityId: id, revokedAt: { not: null } } });
  return { titel, code: code ? { id: code.id, code: code.code, inhalt: internerInhalt(code.code), erzeugtAm: code.createdAt } : null, gesperrt };
}

/**
 * Den aktiven Code eines Datensatzes liefern oder einen erzeugen.
 * Idempotent: Ein zweiter Aufruf gibt denselben Code zurück (200 statt 201),
 * und zwei gleichzeitige erzeugen dank Teilindex nicht zwei.
 */
export async function codeErzeugen(params: { organizationId: string; actorId: string; ip?: string | null; art: ScanEntity; id: string }) {
  const titel = await datensatzPruefen(params.organizationId, params.art, params.id);
  const vorhanden = await aktiverCode(params.organizationId, params.art, params.id);
  if (vorhanden) return { code: vorhanden, neu: false };
  for (let versuch = 0; versuch < 3; versuch += 1) {
    try {
      const code = await prisma.scanCode.create({
        data: { organizationId: params.organizationId, entityType: params.art, entityId: params.id, code: zufallscode(), createdById: params.actorId },
      });
      await audit.created({
        organizationId: params.organizationId,
        userId: params.actorId,
        entity: 'ScanCode',
        entityId: code.id,
        // Der Code selbst gehört nicht ins Protokoll: Wer das Protokoll lesen
        // darf, soll damit kein Etikett nachdrucken können.
        summary: `Etikett für ${params.art} „${titel}" erzeugt`,
        ip: params.ip,
      });
      return { code, neu: true };
    } catch (fehler) {
      if (!isUniqueConstraintError(fehler)) throw fehler;
      // Entweder hat eine gleichzeitige Anfrage gewonnen (dann gibt es jetzt
      // einen aktiven Code), oder der Zufall hat einen vorhandenen Code
      // getroffen (bei 100 Bit praktisch nie) — dann neu würfeln.
      const gewinner = await aktiverCode(params.organizationId, params.art, params.id);
      if (gewinner) return { code: gewinner, neu: false };
    }
  }
  throw new ConflictError('Es konnte kein Etikettcode erzeugt werden. Bitte erneut versuchen.');
}

/** Einen Code sperren — das Etikett ist verloren, beschädigt oder ersetzt. Endgültig. */
export async function codeSperren(params: { organizationId: string; actorId: string; ip?: string | null; codeId: string; darf: (art: ScanEntity) => boolean }) {
  const code = await prisma.scanCode.findFirst({ where: { id: params.codeId, organizationId: params.organizationId } });
  // Ohne Recht auf die Art des Datensatzes: nicht gefunden, wie eine fremde ID.
  if (!code || !params.darf(code.entityType)) throw new NotFoundError('Etikett');
  if (code.revokedAt) return code;
  const gesperrt = await prisma.scanCode.update({ where: { id: code.id }, data: { revokedAt: new Date(), revokedById: params.actorId } });
  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'ScanCode',
    entityId: code.id,
    summary: `Etikett für ${code.entityType} gesperrt`,
    ip: params.ip,
  });
  return gesperrt;
}
