import 'server-only';

import { can } from '@/lib/auth/rbac';
import type { SessionUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { documentVisibilityWhere } from '@/server/services/document.service';
import { propertyVisibilityWhere } from '@/server/services/property.service';
import { scanAufloesen, type ScanTrefferArt } from '@/server/services/scan.service';
import { scanEinordnen } from '@/lib/scan/kennung';

/**
 * Globale Suche (Wave 17, 2026-09-23).
 *
 * ---------------------------------------------------------------------------
 *  Die Regeln
 * ---------------------------------------------------------------------------
 *
 *  • **Jeder Bereich nur mit seiner Leseberechtigung.** Die Suche ist kein
 *    zweiter Weg zu Daten: Wer Rechnungen nicht lesen darf, findet auch keine
 *    Rechnungsnummer. Die Prüfung ist dieselbe `can()` wie auf den Seiten.
 *  • **Organisation in jeder Abfrage** — `organizationId` im `where`, wie
 *    überall. Eine Suche, die quer über Mandanten träfe, wäre das Leck mit der
 *    grössten Reichweite.
 *  • **Keine sensiblen Felder als Treffergrund.** Gesucht wird in Namen,
 *    Nummern, Titeln, E-Mail-Adressen der Kundschaft — nie in Lohn, IBAN,
 *    AHV-Nummer, Notizen oder Nachrichtentexten. Eine Suche nach einer
 *    AHV-Nummer, die eine Person findet, verriete die Nummer.
 *  • **Fünf Treffer je Bereich in der Kopfzeile**, neueste zuerst — dort ist
 *    die Suche ein Sprung. Die Vollansicht („Alle Treffer anzeigen") zeigt
 *    mehr und blättert je Bereich (`bereich`, `seite`). Bis 2026-09-27 lief
 *    sie durch dieselbe Grenze von fünf: „Alle Treffer" zeigte genau so viele
 *    wie die Vorschau, und wer den sechsten Müller suchte, fand ihn nirgends.
 *    Ob ein Bereich mehr hat, sagt `mehr` — ermittelt mit einer Zeile über
 *    die Seite hinaus, nicht mit einer zweiten Zählabfrage je Bereich.
 *  • **Datensatzbezogene Rechte brauchen ihre Sichtbarkeitsbedingung.**
 *    `property:read` besitzen Büro, Mitarbeitende *und* Kundschaft; welche
 *    Objekte jemand sieht, entscheidet `propertyVisibilityWhere`, nicht die
 *    Berechtigung. Dasselbe gilt für Dokumente (`documentVisibilityWhere`).
 *    Deshalb bekommt die Suche die ganze Sitzung und nicht nur die Rolle:
 *    Mit der Rolle allein hätte eine Mitarbeiterin über die Suche jedes Objekt
 *    samt Adresse gefunden, das ihr die Objektliste zu Recht verschweigt.
 *  • **Nur für die Rollen der Verwaltung** (Route und Seite, 2026-09-27). Jeder
 *    Treffer führt in `/admin`; die Kopfzeilensuche gibt es nur dort. Die
 *    Mitarbeitenden hatten trotzdem Zugang zum Endpunkt — und bekamen Links
 *    auf Seiten, die sie nicht öffnen dürfen.
 *
 *  Seit dem Produktsprint vom 2026-09-26 kommen Objekte, Buchungen und
 *  Dokumente dazu — die drei Bereiche, nach denen im Büro am häufigsten
 *  gefragt wird („die Buchung von Müller", „das Objekt an der
 *  Bahnhofstrasse"). Die Reihenfolge der Bereiche unten ist die Reihenfolge
 *  der Gruppen in der Kopfzeilensuche: erst die Person, dann ihr Objekt, dann
 *  die Vorgänge in der Reihenfolge, in der sie entstehen.
 */

export interface Treffer {
  art: string;
  id: string;
  titel: string;
  untertitel: string | null;
  link: string;
}

/** Treffer je Bereich in der Kopfzeile. */
export const VORSCHAU_JE_BEREICH = 5;
/** Treffer je Bereich in der Vollansicht, solange kein Bereich gewählt ist. */
export const UEBERSICHT_JE_BEREICH = 10;
/** Treffer je Seite, wenn die Vollansicht einen Bereich durchblättert. */
export const SEITE_JE_BEREICH = 25;

export interface SuchErgebnis {
  q: string;
  treffer: Treffer[];
  /** Arten, die über die gezeigten Treffer hinaus weitere haben. */
  mehr: string[];
  /**
   * Hinweis des Scanners, wenn die Eingabe ein Etikettcode war — vor allem
   * „dieses Etikett ist gesperrt". Die Suche zeigte den Datensatz eines
   * gesperrten Etiketts bis 2026-09-27 kommentarlos, während der Scanner
   * denselben Code mit Warnung auflöste: zwei Antworten auf eine Eingabe.
   */
  hinweis: string | null;
}

/** Arten des Scanners in den Gruppennamen der Suche. */
const SCAN_ART: Record<ScanTrefferArt, string> = {
  MATERIAL: 'Material',
  GERAET: 'Gerät',
  EINSATZ: 'Einsatz',
  RECHNUNG: 'Rechnung',
  KUNDSCHAFT: 'Kundschaft',
  OBJEKT: 'Objekt',
  // Verträge löst der Scanner nur über ihre Nummer auf, nie über ein Etikett;
  // in die Suche gelangen hier nur Etikett-Treffer. Der Eintrag steht, weil
  // der Typ jede Art verlangt — und damit eine spätere Etikettart „Vertrag"
  // nicht still ohne Gruppennamen bliebe.
  VERTRAG: 'Vertrag',
};

/** Ein Suchbereich: welche Art, ob die Rolle ihn sieht, und wie er lädt. */
interface Bereich {
  art: string;
  sichtbar: boolean;
  laden: (seite: { skip: number; take: number }) => Promise<Treffer[]>;
}

export async function globaleSuche(params: {
  organizationId: string;
  session: SessionUser;
  q: string;
  /** Treffer je Bereich (Kopfzeile 5, Vollansicht mehr). */
  jeBereich?: number;
  /** Nur diesen Bereich laden — für das Blättern in der Vollansicht. */
  bereich?: string;
  /** Seite innerhalb von `bereich`, ab 1. */
  seite?: number;
}): Promise<SuchErgebnis> {
  const q = params.q.trim();
  const enthaelt = { contains: q, mode: 'insensitive' as const };
  const org = params.organizationId;
  const darf = (p: Parameters<typeof can>[1]) => can(params.session.role, p);
  const jeBereich = params.jeBereich ?? VORSCHAU_JE_BEREICH;
  const seite = Math.max(1, params.seite ?? 1);

  const bereiche: Bereich[] = [
    {
      art: 'Kundschaft',
      sichtbar: darf('customer:read'),
      laden: ({ skip, take }) =>
        prisma.customer
          .findMany({
            where: {
              organizationId: org,
              deletedAt: null,
              OR: [{ firstName: enthaelt }, { lastName: enthaelt }, { companyName: enthaelt }, { email: enthaelt }, { number: enthaelt }],
            },
            select: { id: true, number: true, firstName: true, lastName: true, companyName: true },
            orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
            skip,
            take,
          })
          .then((r) =>
            r.map((k) => ({
              art: 'Kundschaft',
              id: k.id,
              titel: k.companyName ?? `${k.firstName} ${k.lastName}`,
              untertitel: k.number,
              link: `/admin/kunden/${k.id}`,
            })),
          ),
    },
    {
      art: 'Objekt',
      sichtbar: darf('property:read'),
      // Die Sichtbarkeit kommt aus derselben Funktion wie die Objektliste —
      // Mitarbeitende finden nur Objekte mit eigenem Einsatz (siehe oben).
      laden: ({ skip, take }) =>
        prisma.property
          .findMany({
            where: {
              AND: [
                propertyVisibilityWhere(params.session, org),
                {
                  OR: [
                    { label: enthaelt },
                    { address: { street: enthaelt } },
                    { address: { city: enthaelt } },
                    { address: { postalCode: enthaelt } },
                    { customer: { companyName: enthaelt } },
                    { customer: { lastName: enthaelt } },
                  ],
                },
              ],
            },
            select: {
              id: true,
              label: true,
              customerId: true,
              address: { select: { street: true, streetNo: true, postalCode: true, city: true } },
              customer: { select: { companyName: true, firstName: true, lastName: true } },
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
            skip,
            take,
          })
          .then((r) =>
            r.map((o) => {
              const kunde = o.customer.companyName ?? `${o.customer.firstName} ${o.customer.lastName}`;
              const adresse = o.address
                ? [`${o.address.street} ${o.address.streetNo ?? ''}`.trim(), `${o.address.postalCode} ${o.address.city}`].join(', ')
                : null;
              return {
                art: 'Objekt',
                id: o.id,
                titel: `${kunde} — ${o.label}`,
                untertitel: adresse,
                // Objekte haben keine eigene Detailseite; sie stehen in der
                // Kundenakte, und dorthin führt der Treffer.
                link: `/admin/kunden/${o.customerId}`,
              };
            }),
          ),
    },
    {
      art: 'Buchung',
      sichtbar: darf('booking:read'),
      laden: ({ skip, take }) =>
        prisma.booking
          .findMany({
            where: {
              organizationId: org,
              deletedAt: null,
              OR: [
                { number: enthaelt },
                { customer: { companyName: enthaelt } },
                { customer: { lastName: enthaelt } },
                { customer: { firstName: enthaelt } },
                { items: { some: { name: enthaelt } } },
              ],
            },
            select: {
              id: true,
              number: true,
              scheduledStart: true,
              customer: { select: { companyName: true, firstName: true, lastName: true } },
            },
            orderBy: [{ scheduledStart: 'desc' }, { id: 'asc' }],
            skip,
            take,
          })
          .then((r) =>
            r.map((b) => ({
              art: 'Buchung',
              id: b.id,
              titel: `${b.number} — ${b.customer.companyName ?? `${b.customer.firstName} ${b.customer.lastName}`}`,
              untertitel: new Intl.DateTimeFormat('de-CH', { timeZone: 'Europe/Zurich', dateStyle: 'medium', timeStyle: 'short' }).format(b.scheduledStart),
              link: `/admin/buchungen/${b.id}`,
            })),
          ),
    },
    {
      art: 'Anfrage',
      sichtbar: darf('lead:read'),
      laden: ({ skip, take }) =>
        prisma.lead
          .findMany({
            where: { organizationId: org, deletedAt: null, OR: [{ firstName: enthaelt }, { lastName: enthaelt }, { company: enthaelt }, { email: enthaelt }, { number: enthaelt }] },
            select: { id: true, number: true, firstName: true, lastName: true, company: true },
            orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
            skip,
            take,
          })
          .then((r) => r.map((l) => ({ art: 'Anfrage', id: l.id, titel: l.company ?? `${l.firstName} ${l.lastName}`, untertitel: l.number, link: `/admin/leads/${l.id}` }))),
    },
    {
      art: 'Offerte',
      sichtbar: darf('quote:read'),
      laden: ({ skip, take }) =>
        prisma.quote
          .findMany({
            where: { organizationId: org, deletedAt: null, OR: [{ number: enthaelt }, { title: enthaelt }] },
            select: { id: true, number: true, title: true },
            orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
            skip,
            take,
          })
          .then((r) => r.map((o) => ({ art: 'Offerte', id: o.id, titel: o.number, untertitel: o.title, link: `/admin/offerten/${o.id}` }))),
    },
    {
      art: 'Besichtigung',
      sichtbar: darf('quote:read'),
      laden: ({ skip, take }) =>
        prisma.siteVisit
          .findMany({
            where: { organizationId: org, number: enthaelt },
            select: { id: true, number: true },
            orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
            skip,
            take,
          })
          .then((r) => r.map((b) => ({ art: 'Besichtigung', id: b.id, titel: b.number, untertitel: null, link: `/admin/besichtigungen/${b.id}` }))),
    },
    {
      art: 'Rechnung',
      sichtbar: darf('invoice:read'),
      laden: ({ skip, take }) =>
        prisma.invoice
          .findMany({
            where: { organizationId: org, deletedAt: null, OR: [{ number: enthaelt }, { billToName: enthaelt }, { billToCompany: enthaelt }] },
            select: { id: true, number: true, billToName: true, billToCompany: true },
            orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
            skip,
            take,
          })
          .then((r) => r.map((i) => ({ art: 'Rechnung', id: i.id, titel: i.number, untertitel: i.billToCompany ?? i.billToName, link: `/admin/rechnungen/${i.id}` }))),
    },
    {
      // Dokumente nur mit dem vollen Leserecht: `document:read_own`
      // (Mitarbeitende) hat keinen Weg in die Dokumentenablage der
      // Administration, ein Treffer dorthin wäre ein toter Link. Welche
      // Dokumente die Rolle sieht, entscheidet `documentVisibilityWhere` — die
      // Betriebsleitung findet keine Personalakten anderer Leute.
      art: 'Dokument',
      sichtbar: darf('document:read'),
      laden: ({ skip, take }) =>
        prisma.managedDocument
          .findMany({
            where: {
              AND: [
                documentVisibilityWhere(params.session, org),
                { OR: [{ title: enthaelt }, { tags: { has: q } }] },
              ],
            },
            select: { id: true, title: true, category: true },
            orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
            skip,
            take,
          })
          .then((r) => r.map((d) => ({ art: 'Dokument', id: d.id, titel: d.title, untertitel: null, link: `/admin/fuehrung/dokumente/${d.id}` }))),
    },
    {
      art: 'Einsatz',
      sichtbar: darf('job:read'),
      laden: ({ skip, take }) =>
        prisma.job
          .findMany({
            where: { organizationId: org, deletedAt: null, OR: [{ number: enthaelt }, { title: enthaelt }] },
            select: { id: true, number: true, title: true },
            orderBy: [{ scheduledStart: 'desc' }, { id: 'asc' }],
            skip,
            take,
          })
          .then((r) => r.map((j) => ({ art: 'Einsatz', id: j.id, titel: j.number, untertitel: j.title, link: `/admin/einsaetze/${j.id}` }))),
    },
    {
      art: 'Vertrag',
      sichtbar: darf('contract:read'),
      laden: ({ skip, take }) =>
        prisma.contract
          .findMany({
            where: { organizationId: org, deletedAt: null, OR: [{ number: enthaelt }, { title: enthaelt }] },
            select: { id: true, number: true, title: true },
            orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
            skip,
            take,
          })
          .then((r) => r.map((c) => ({ art: 'Vertrag', id: c.id, titel: c.number ?? c.title, untertitel: c.title, link: `/admin/vertraege/${c.id}` }))),
    },
    {
      art: 'Personal',
      sichtbar: darf('employee:read'),
      laden: ({ skip, take }) =>
        prisma.employee
          .findMany({
            where: { organizationId: org, OR: [{ employeeNumber: enthaelt }, { user: { firstName: enthaelt } }, { user: { lastName: enthaelt } }] },
            select: { id: true, employeeNumber: true, position: true, user: { select: { firstName: true, lastName: true } } },
            orderBy: [{ employeeNumber: 'asc' }, { id: 'asc' }],
            skip,
            take,
          })
          .then((r) =>
            r.map((e) => ({ art: 'Personal', id: e.id, titel: `${e.user.firstName} ${e.user.lastName}`, untertitel: `${e.employeeNumber} · ${e.position}`, link: `/admin/personal/${e.id}` })),
          ),
    },
    {
      art: 'Reklamation',
      sichtbar: darf('complaint:read'),
      laden: ({ skip, take }) =>
        prisma.complaint
          .findMany({
            where: { organizationId: org, OR: [{ number: enthaelt }, { title: enthaelt }] },
            select: { id: true, number: true, title: true },
            orderBy: [{ reportedAt: 'desc' }, { id: 'asc' }],
            skip,
            take,
          })
          .then((r) => r.map((c) => ({ art: 'Reklamation', id: c.id, titel: c.number, untertitel: c.title, link: `/admin/reklamationen/${c.id}` }))),
    },
    {
      art: 'Material',
      sichtbar: darf('inventory:read'),
      laden: ({ skip, take }) =>
        prisma.material
          .findMany({
            where: { organizationId: org, OR: [{ sku: enthaelt }, { name: enthaelt }, { barcode: q }] },
            select: { id: true, sku: true, name: true },
            orderBy: [{ name: 'asc' }, { id: 'asc' }],
            skip,
            take,
          })
          .then((r) => r.map((m) => ({ art: 'Material', id: m.id, titel: m.name, untertitel: m.sku, link: `/admin/material` }))),
    },
    {
      art: 'Gerät',
      sichtbar: darf('equipment:read'),
      laden: ({ skip, take }) =>
        prisma.equipment
          .findMany({
            where: { organizationId: org, OR: [{ inventoryNumber: enthaelt }, { name: enthaelt }, { serialNumber: enthaelt }] },
            select: { id: true, inventoryNumber: true, name: true },
            orderBy: [{ inventoryNumber: 'asc' }, { id: 'asc' }],
            skip,
            take,
          })
          .then((r) => r.map((g) => ({ art: 'Gerät', id: g.id, titel: g.name, untertitel: g.inventoryNumber, link: `/admin/geraete` }))),
    },
  ];

  const gewaehlt = bereiche.filter((b) => b.sichtbar && (!params.bereich || b.art === params.bereich));
  const skip = params.bereich ? (seite - 1) * jeBereich : 0;

  // Eine Zeile mehr als gezeigt: Ist sie da, hat der Bereich weitere Treffer.
  const geladen = await Promise.all(
    gewaehlt.map(async (b) => {
      const zeilen = await b.laden({ skip, take: jeBereich + 1 });
      return { art: b.art, zeilen: zeilen.slice(0, jeBereich), mehr: zeilen.length > jeBereich };
    }),
  );

  // Ein Etikettcode im Suchfeld (eingefügt oder vom Handscanner getippt)
  // enthält keinen Namen, in dem `contains` etwas fände. Er geht deshalb
  // durch denselben Auflöser wie der Scanner — mit dessen Rechte- und
  // Sichtbarkeitsprüfung, nicht mit einer zweiten, und mit dessen Hinweis.
  let scanTreffer: Treffer[] = [];
  let hinweis: string | null = null;
  if (!params.bereich && scanEinordnen(q).art === 'INTERN') {
    const scan = await scanAufloesen({ organizationId: org, session: params.session, text: q });
    scanTreffer = scan.treffer
      .filter((t) => t.link)
      .map((t) => ({ art: SCAN_ART[t.art], id: t.id, titel: t.titel, untertitel: t.untertitel, link: t.link! }));
    hinweis = scan.hinweis;
  }

  return {
    q,
    treffer: [...scanTreffer, ...geladen.flatMap((g) => g.zeilen)],
    mehr: geladen.filter((g) => g.mehr).map((g) => g.art),
    hinweis,
  };
}
