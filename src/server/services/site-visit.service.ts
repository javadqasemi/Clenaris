import 'server-only';

import { Prisma, type Frequency, type SiteVisitStatus } from '@prisma/client';

import { audit } from '@/lib/audit';
import { prisma, toNumber } from '@/lib/db';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { calculatePrice, FREQUENCY_LABEL } from '@/lib/pricing/engine';
import type { PriceBreakdown } from '@/lib/pricing/types';
import { round2 } from '@/lib/utils';
import type { SiteVisitAreaInput, SiteVisitCreateInput, SiteVisitQuoteInput, SiteVisitUpdateInput } from '@/lib/validation/verkauf';

import { nextNumber } from './numbering.service';
import { createQuoteTx } from './quote.service';

/**
 * Besichtigung / Objektaufnahme (Wave 12, 2026-09-23).
 *
 * ---------------------------------------------------------------------------
 *  Was fehlte
 * ---------------------------------------------------------------------------
 *
 * Für Büros, Praxen und Treppenhäuser entsteht eine Offerte nach einer
 * Besichtigung. Bis hierher gab es dafür keinen Ort: Die gemessenen Flächen
 * standen auf Papier, und die Offerte bekam Preise, die jemand aus dem Kopf
 * eintrug — an der Preisberechnung vorbei, die für die Online-Buchung gilt.
 * Zwei Kundschaften mit demselben Objekt bekamen so zwei Preise.
 *
 * ---------------------------------------------------------------------------
 *  Die Regeln
 * ---------------------------------------------------------------------------
 *
 *  • **Ein Weg zum Preis.** Jede aufgenommene Fläche geht durch
 *    `calculatePrice` — mit Postleitzahl (Anfahrt), Objektart, Turnus,
 *    Zusatzleistungen und dem Dauerrabatt der Kundschaft. Die Offerte
 *    übernimmt das Ergebnis; kein Preis kommt aus dem Formular.
 *  • **Beim Erstellen der Offerte wird neu gerechnet.** Die gespeicherte
 *    Berechnung ist eine Vorschau; ändert sich der Katalog dazwischen, gilt
 *    der aktuelle Stand — und die neue Berechnung wird wieder festgehalten.
 *  • **„Preis auf Anfrage" wird nicht geraten.** Enthält eine Fläche eine
 *    Leistung ohne Preisgrundlage, entsteht keine Offerte (422); die Stelle
 *    wird von Hand offeriert.
 *  • **Eine Offerte je Besichtigung**, in derselben Transaktion verknüpft;
 *    die Besichtigungszeile ist dabei gesperrt — zwei gleichzeitige Klicks
 *    ergeben eine Offerte, nicht zwei.
 *  • **Bezug geprüft:** Anfrage, Kundschaft, Objekt und begutachtende Person
 *    gehören der Organisation; das Objekt gehört der Kundschaft.
 */

const OFFEN: SiteVisitStatus[] = ['PLANNED'];

async function pruefeBezug(
  organizationId: string,
  input: { leadId?: string | null; customerId?: string | null; propertyId?: string | null; assessorId?: string | null },
) {
  if (input.leadId) {
    const l = await prisma.lead.findFirst({ where: { id: input.leadId, organizationId }, select: { id: true } });
    if (!l) throw new NotFoundError('Anfrage');
  }
  if (input.customerId) {
    const k = await prisma.customer.findFirst({ where: { id: input.customerId, organizationId }, select: { id: true } });
    if (!k) throw new NotFoundError('Kundschaft');
  }
  if (input.propertyId) {
    const o = await prisma.property.findFirst({
      where: { id: input.propertyId, customer: { organizationId }, ...(input.customerId ? { customerId: input.customerId } : {}) },
      select: { id: true },
    });
    if (!o) throw new NotFoundError('Objekt');
  }
  if (input.assessorId) {
    const p = await prisma.user.findFirst({
      where: { id: input.assessorId, organizationId, role: { in: ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'EMPLOYEE'] }, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!p) throw new BusinessRuleError('Begutachten kann nur ein aktives Konto des Betriebs.');
  }
}

async function laden(organizationId: string, id: string) {
  const v = await prisma.siteVisit.findFirst({ where: { id, organizationId } });
  if (!v) throw new NotFoundError('Besichtigung');
  return v;
}

export async function listSiteVisits(params: { organizationId: string; status?: SiteVisitStatus; leadId?: string; customerId?: string }) {
  return prisma.siteVisit.findMany({
    where: {
      organizationId: params.organizationId,
      ...(params.status ? { status: params.status } : {}),
      ...(params.leadId ? { leadId: params.leadId } : {}),
      ...(params.customerId ? { customerId: params.customerId } : {}),
    },
    orderBy: [{ scheduledAt: 'desc' }],
    take: 500,
    include: {
      lead: { select: { id: true, firstName: true, lastName: true, company: true } },
      customer: { select: { id: true, number: true, companyName: true, firstName: true, lastName: true } },
      property: { select: { id: true, label: true } },
      assessor: { select: { id: true, firstName: true, lastName: true } },
      quote: { select: { id: true, number: true, status: true } },
      _count: { select: { areas: true } },
    },
  });
}

export async function getSiteVisit(organizationId: string, id: string) {
  const v = await prisma.siteVisit.findFirst({
    where: { id, organizationId },
    include: {
      lead: { select: { id: true, firstName: true, lastName: true, company: true, postalCode: true } },
      customer: { select: { id: true, number: true, companyName: true, firstName: true, lastName: true } },
      property: { select: { id: true, label: true, address: { select: { street: true, streetNo: true, postalCode: true, city: true } } } },
      assessor: { select: { id: true, firstName: true, lastName: true } },
      quote: { select: { id: true, number: true, status: true, grossTotal: true } },
      areas: { orderBy: { position: 'asc' }, include: { service: { select: { id: true, name: true, pricingModel: true } } } },
    },
  });
  if (!v) throw new NotFoundError('Besichtigung');
  return v;
}

export async function createSiteVisit(params: { organizationId: string; actorId: string; ip?: string | null; input: SiteVisitCreateInput }) {
  const { input } = params;
  await pruefeBezug(params.organizationId, input);
  const neu = await prisma.$transaction(async (tx) => {
    const { number } = await nextNumber(tx, params.organizationId, 'site_visit');
    return tx.siteVisit.create({
      data: {
        organizationId: params.organizationId,
        number,
        leadId: input.leadId ?? null,
        customerId: input.customerId ?? null,
        propertyId: input.propertyId ?? null,
        scheduledAt: new Date(input.scheduledAt),
        assessorId: input.assessorId ?? null,
        propertyKind: input.propertyKind,
        hasPets: input.hasPets,
        accessNotes: input.accessNotes ?? null,
        street: input.street ?? null,
        postalCode: input.postalCode ?? null,
        city: input.city ?? null,
        createdById: params.actorId,
      },
    });
  });
  await audit.created({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'SiteVisit',
    entityId: neu.id,
    summary: `Besichtigung ${neu.number} geplant`,
    ip: params.ip,
  });
  return neu;
}

export async function updateSiteVisit(params: { organizationId: string; id: string; actorId: string; ip?: string | null; input: SiteVisitUpdateInput }) {
  const vorher = await laden(params.organizationId, params.id);
  if (vorher.quoteId) throw new BusinessRuleError('Aus dieser Besichtigung ist bereits eine Offerte entstanden — die Aufnahme bleibt, wie sie offeriert wurde.');
  if (vorher.status === 'CANCELLED') throw new BusinessRuleError('Die Besichtigung ist abgesagt.');
  const { input } = params;
  if (input.assessorId) await pruefeBezug(params.organizationId, { assessorId: input.assessorId });
  const nachher = await prisma.siteVisit.update({
    where: { id: vorher.id },
    data: {
      ...(input.scheduledAt ? { scheduledAt: new Date(input.scheduledAt) } : {}),
      ...(input.assessorId !== undefined ? { assessorId: input.assessorId } : {}),
      ...(input.propertyKind ? { propertyKind: input.propertyKind } : {}),
      ...(input.hasPets !== undefined ? { hasPets: input.hasPets } : {}),
      ...(input.accessNotes !== undefined ? { accessNotes: input.accessNotes } : {}),
      ...(input.findings !== undefined ? { findings: input.findings } : {}),
      ...(input.street !== undefined ? { street: input.street } : {}),
      ...(input.postalCode !== undefined ? { postalCode: input.postalCode } : {}),
      ...(input.city !== undefined ? { city: input.city } : {}),
      // Eine geänderte Aufnahme macht die gespeicherte Berechnung wertlos.
      calculation: Prisma_JsonNull(),
      calculatedAt: null,
    },
  });
  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'SiteVisit',
    entityId: vorher.id,
    summary: `Besichtigung ${vorher.number} geändert`,
    ip: params.ip,
  });
  return nachher;
}

/** Ein Json-Feld leeren (SQL NULL, nicht der Json-Wert `null`). */
function Prisma_JsonNull() {
  return Prisma.DbNull;
}

/** Die Flächen als Ganzes setzen — geprüft gegen Katalog und Zusatzleistungen. */
export async function setSiteVisitAreas(params: { organizationId: string; id: string; actorId: string; ip?: string | null; areas: SiteVisitAreaInput[] }) {
  const v = await laden(params.organizationId, params.id);
  if (v.quoteId) throw new BusinessRuleError('Aus dieser Besichtigung ist bereits eine Offerte entstanden.');
  if (v.status === 'CANCELLED') throw new BusinessRuleError('Die Besichtigung ist abgesagt.');

  const serviceIds = [...new Set(params.areas.map((a) => a.serviceId))];
  const leistungen = await prisma.service.findMany({
    where: { id: { in: serviceIds }, organizationId: params.organizationId, active: true },
    select: { id: true, extras: { select: { extraId: true } } },
  });
  const jeLeistung = new Map(leistungen.map((l) => [l.id, new Set(l.extras.map((e) => e.extraId))]));
  for (const a of params.areas) {
    const erlaubt = jeLeistung.get(a.serviceId);
    if (!erlaubt) throw new NotFoundError('Leistung');
    for (const e of a.extras) {
      if (!erlaubt.has(e.extraId)) throw new BusinessRuleError(`Die Zusatzleistung gehört nicht zur Leistung der Fläche „${a.label}".`);
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.siteVisitArea.deleteMany({ where: { siteVisitId: v.id } });
    await tx.siteVisitArea.createMany({
      data: params.areas.map((a, i) => ({
        siteVisitId: v.id,
        position: i + 1,
        label: a.label,
        serviceId: a.serviceId,
        squareMeters: a.squareMeters ?? null,
        rooms: a.rooms ?? null,
        bathrooms: a.bathrooms ?? null,
        windows: a.windows ?? null,
        frequency: a.frequency,
        extras: a.extras as unknown as Prisma.InputJsonValue,
        manualHours: a.manualHours ?? null,
        note: a.note ?? null,
      })),
    });
    await tx.siteVisit.update({ where: { id: v.id }, data: { calculation: Prisma_JsonNull(), calculatedAt: null } });
  });
  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'SiteVisit',
    entityId: v.id,
    summary: `Besichtigung ${v.number}: ${params.areas.length} Fläche(n) aufgenommen`,
    ip: params.ip,
  });
  return getSiteVisit(params.organizationId, v.id);
}

/** Eine Fläche anhängen — für die Maske, die Fläche für Fläche aufnimmt. */
export async function addSiteVisitArea(params: { organizationId: string; id: string; actorId: string; ip?: string | null; area: SiteVisitAreaInput }) {
  const bisher = await prisma.siteVisitArea.findMany({
    where: { siteVisit: { id: params.id, organizationId: params.organizationId } },
    orderBy: { position: 'asc' },
  });
  const alsEingabe: SiteVisitAreaInput[] = bisher.map((a) => ({
    label: a.label,
    serviceId: a.serviceId,
    squareMeters: a.squareMeters,
    rooms: a.rooms === null ? null : toNumber(a.rooms),
    bathrooms: a.bathrooms,
    windows: a.windows,
    frequency: a.frequency as SiteVisitAreaInput['frequency'],
    extras: (a.extras as unknown as SiteVisitAreaInput['extras']) ?? [],
    manualHours: a.manualHours === null ? null : toNumber(a.manualHours),
    note: a.note,
  }));
  return setSiteVisitAreas({ ...params, areas: [...alsEingabe, params.area] });
}

/** Eine Fläche entfernen. */
export async function removeSiteVisitArea(params: { organizationId: string; id: string; areaId: string; actorId: string; ip?: string | null }) {
  const v = await laden(params.organizationId, params.id);
  if (v.quoteId) throw new BusinessRuleError('Aus dieser Besichtigung ist bereits eine Offerte entstanden.');
  const treffer = await prisma.siteVisitArea.deleteMany({ where: { id: params.areaId, siteVisitId: v.id } });
  if (treffer.count === 0) throw new NotFoundError('Fläche');
  await prisma.siteVisit.update({ where: { id: v.id }, data: { calculation: Prisma_JsonNull(), calculatedAt: null } });
  return { id: params.areaId, deleted: true };
}

export async function completeSiteVisit(params: { organizationId: string; id: string; actorId: string; ip?: string | null; findings?: string }) {
  const v = await laden(params.organizationId, params.id);
  if (!OFFEN.includes(v.status)) throw new BusinessRuleError('Nur eine geplante Besichtigung lässt sich abschliessen.');
  const flaechen = await prisma.siteVisitArea.count({ where: { siteVisitId: v.id } });
  if (flaechen === 0) throw new BusinessRuleError('Ohne aufgenommene Fläche gibt es nichts zu offerieren.');
  const treffer = await prisma.siteVisit.updateMany({
    where: { id: v.id, status: 'PLANNED' },
    data: { status: 'DONE', performedAt: new Date(), ...(params.findings ? { findings: params.findings } : {}) },
  });
  if (treffer.count === 0) throw new BusinessRuleError('Die Besichtigung hat sich eben geändert — bitte neu laden.');
  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'SiteVisit',
    entityId: v.id,
    summary: `Besichtigung ${v.number} durchgeführt`,
    ip: params.ip,
  });
  return laden(params.organizationId, v.id);
}

export async function cancelSiteVisit(params: { organizationId: string; id: string; actorId: string; ip?: string | null; reason: string }) {
  const v = await laden(params.organizationId, params.id);
  if (v.quoteId) throw new BusinessRuleError('Aus dieser Besichtigung ist bereits eine Offerte entstanden.');
  if (v.status === 'CANCELLED') throw new BusinessRuleError('Die Besichtigung ist bereits abgesagt.');
  await prisma.siteVisit.update({ where: { id: v.id }, data: { status: 'CANCELLED', cancelledReason: params.reason } });
  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'SiteVisit',
    entityId: v.id,
    summary: `Besichtigung ${v.number} abgesagt: ${params.reason}`,
    ip: params.ip,
  });
  return laden(params.organizationId, v.id);
}

// ---------------------------------------------------------------------------
//  Berechnung
// ---------------------------------------------------------------------------

export interface Flaechenrechnung {
  areaId: string;
  label: string;
  serviceId: string;
  serviceName: string;
  frequency: Frequency;
  onRequest: boolean;
  netTotal: number;
  vatRate: number;
  vatAmount: number;
  grossTotal: number;
  laborHours: number;
  lines: PriceBreakdown['lines'];
  notes: string[];
}

export interface Besichtigungsrechnung {
  berechnetAm: string;
  flaechen: Flaechenrechnung[];
  netTotal: number;
  vatAmount: number;
  grossTotal: number;
  aufAnfrage: boolean;
}

/**
 * Jede Fläche durch `calculatePrice` — dieselbe Berechnung wie die
 * Online-Buchung. Postleitzahl: Objekt, sonst Besichtigung, sonst Anfrage.
 */
async function rechne(organizationId: string, id: string): Promise<Besichtigungsrechnung> {
  const v = await getSiteVisit(organizationId, id);
  if (v.areas.length === 0) throw new BusinessRuleError('Es ist noch keine Fläche aufgenommen.');
  const plz = v.property?.address?.postalCode ?? v.postalCode ?? v.lead?.postalCode ?? null;
  const kunde = v.customerId
    ? await prisma.customer.findUnique({ where: { id: v.customerId }, select: { id: true, discountPercent: true, totalBookings: true } })
    : null;

  const flaechen: Flaechenrechnung[] = [];
  for (const a of v.areas) {
    const b = await calculatePrice(
      {
        serviceId: a.serviceId,
        squareMeters: a.squareMeters,
        rooms: a.rooms === null ? null : toNumber(a.rooms),
        bathrooms: a.bathrooms,
        windows: a.windows,
        propertyKind: v.propertyKind,
        frequency: a.frequency,
        extras: (a.extras as unknown as { extraId: string; quantity: number }[]) ?? [],
        postalCode: plz,
        hasPets: v.hasPets,
        manualHours: a.manualHours === null ? null : toNumber(a.manualHours),
        customer: kunde ? { id: kunde.id, totalBookings: kunde.totalBookings } : null,
        customerDiscountPercent: kunde ? toNumber(kunde.discountPercent) : 0,
      },
      organizationId,
    );
    flaechen.push({
      areaId: a.id,
      label: a.label,
      serviceId: a.serviceId,
      serviceName: a.service.name,
      frequency: a.frequency,
      onRequest: b.onRequest,
      netTotal: b.netTotal,
      vatRate: b.vatRate,
      vatAmount: b.vatAmount,
      grossTotal: b.grossTotal,
      laborHours: b.laborHours,
      lines: b.lines,
      notes: b.notes,
    });
  }
  return {
    berechnetAm: new Date().toISOString(),
    flaechen,
    netTotal: round2(flaechen.reduce((s, f) => s + f.netTotal, 0)),
    vatAmount: round2(flaechen.reduce((s, f) => s + f.vatAmount, 0)),
    grossTotal: round2(flaechen.reduce((s, f) => s + f.grossTotal, 0)),
    aufAnfrage: flaechen.some((f) => f.onRequest),
  };
}

export async function calculateSiteVisit(params: { organizationId: string; id: string }) {
  const v = await laden(params.organizationId, params.id);
  if (v.status === 'CANCELLED') throw new BusinessRuleError('Die Besichtigung ist abgesagt.');
  const r = await rechne(params.organizationId, v.id);
  if (!v.quoteId) {
    await prisma.siteVisit.update({
      where: { id: v.id },
      data: { calculation: r as unknown as Prisma.InputJsonValue, calculatedAt: new Date(r.berechnetAm) },
    });
  }
  return r;
}

/**
 * Aus der Besichtigung eine Offerte (Entwurf). Neu gerechnet, eine Position
 * je Fläche, Preis aus der Berechnung; in einer Transaktion mit der
 * Verknüpfung, die Besichtigung gesperrt.
 */
export async function createQuoteFromSiteVisit(params: {
  organizationId: string;
  id: string;
  actorId: string;
  ip?: string | null;
  input: SiteVisitQuoteInput;
}) {
  const v = await laden(params.organizationId, params.id);
  if (v.status !== 'DONE') throw new BusinessRuleError('Offeriert wird nach der Besichtigung — bitte zuerst abschliessen.');
  if (v.quoteId) throw new BusinessRuleError('Aus dieser Besichtigung ist bereits eine Offerte entstanden.');

  const r = await rechne(params.organizationId, v.id);
  if (r.aufAnfrage) {
    const stellen = r.flaechen.filter((f) => f.onRequest).map((f) => f.label).join(', ');
    throw new BusinessRuleError(`Für „${stellen}" gibt es keine Preisgrundlage (Preis auf Anfrage). Diese Stelle wird von Hand offeriert.`);
  }

  const heute = new Date();
  const gueltigBis = new Date(Date.UTC(heute.getUTCFullYear(), heute.getUTCMonth(), heute.getUTCDate() + params.input.validDays));
  const items = r.flaechen.map((f) => ({
    serviceId: f.serviceId,
    name: `${f.serviceName} — ${f.label}`,
    description: [
      f.frequency !== 'ONCE' ? `Turnus: ${FREQUENCY_LABEL[f.frequency] ?? f.frequency}, Preis je Einsatz` : null,
      ...f.lines.map((l) => `${l.label}: CHF ${l.amount.toFixed(2)}`),
    ]
      .filter(Boolean)
      .join('\n')
      .slice(0, 2000),
    quantity: 1,
    unit: f.frequency === 'ONCE' ? 'Pauschal' : 'Einsatz',
    unitPrice: f.netTotal,
    discount: 0,
    vatRate: f.vatRate,
    optional: false,
  }));

  const quote = await prisma.$transaction(async (tx) => {
    // Sperre: zwei gleichzeitige Offerten aus derselben Besichtigung schliessen sich aus.
    await tx.$queryRaw`SELECT "id" FROM "site_visits" WHERE "id" = ${v.id} FOR UPDATE`;
    const frisch = await tx.siteVisit.findUnique({ where: { id: v.id }, select: { quoteId: true, status: true } });
    if (frisch?.quoteId) throw new BusinessRuleError('Aus dieser Besichtigung ist eben eine Offerte entstanden.');
    const q = await createQuoteTx(tx, {
      organizationId: params.organizationId,
      actorId: params.actorId,
      input: {
        customerId: v.customerId ?? undefined,
        leadId: v.leadId ?? undefined,
        propertyId: v.propertyId ?? undefined,
        title: params.input.title ?? `Offerte nach Besichtigung ${v.number}`,
        validUntil: gueltigBis,
        introText: params.input.introText,
        internalNote: `Aus Besichtigung ${v.number}; Preise aus der Preisberechnung vom ${r.berechnetAm.slice(0, 16).replace('T', ' ')} UTC.`,
        discountValue: 0,
        items,
      },
    });
    await tx.siteVisit.update({
      where: { id: v.id },
      data: { quoteId: q.id, calculation: r as unknown as Prisma.InputJsonValue, calculatedAt: new Date(r.berechnetAm) },
    });
    return q;
  });

  if (v.leadId) await prisma.lead.update({ where: { id: v.leadId }, data: { status: 'PROPOSAL' } });
  await audit.created({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Quote',
    entityId: quote.id,
    summary: `Offerte ${quote.number} aus Besichtigung ${v.number} erstellt`,
    ip: params.ip,
  });
  return { quoteId: quote.id, number: quote.number, grossTotal: toNumber(quote.grossTotal), rechnung: r };
}
