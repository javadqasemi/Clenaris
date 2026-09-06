import 'server-only';

import type { Prisma, Quote } from '@prisma/client';

import { prisma, toNumber } from '@/lib/db';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { absoluteUrl, round2 } from '@/lib/utils';
import { orderByFor, resolveSort, type SortOrder } from '@/lib/sort';
import { audit } from '@/lib/audit';
import {
  quoteAcceptedInternalEmail,
  quoteExpiringEmail,
  quoteSentEmail,
} from '@/lib/email/templates';
import { renderQuotePdf } from '@/lib/pdf/render';
import type {
  CreateQuoteInput,
  QuoteItemInput,
  RespondQuoteInput,
  UpdateQuoteInput,
} from '@/lib/validation/operations';

import { nextNumber } from './numbering.service';
import { notify, notifyStaff } from './notification.service';
import { createInvoiceFromQuote } from './invoice.service';

/**
 * Offertenverwaltung.
 *
 * Architekturentscheide:
 *  1. Positionstotale werden serverseitig berechnet — der Client schickt nur
 *     Menge, Einzelpreis und Rabatt. Damit können manipulierte Requests keine
 *     inkonsistenten Summen erzeugen.
 *  2. Optionale Positionen fliessen nicht ins Total ein, werden aber im PDF
 *     ausgewiesen. Das ist im Reinigungsgewerbe üblich (z. B. „Fenster zusätzlich").
 *  3. Versandte Offerten sind über einen unerratbaren `publicToken` ohne Login
 *     erreichbar. Zusagen erfolgen mit Namenseingabe und gezeichneter
 *     Unterschrift; IP und Zeitstempel werden zur Beweissicherung protokolliert.
 */

interface ComputedTotals {
  subtotal: number;
  discountAmount: number;
  netTotal: number;
  vatAmount: number;
  grossTotal: number;
  items: (QuoteItemInput & { lineTotal: number; position: number })[];
}

/** Positionen und Totale konsistent berechnen. */
export function computeQuoteTotals(
  items: QuoteItemInput[],
  discountType?: 'PERCENT' | 'FIXED',
  discountValue = 0,
): ComputedTotals {
  const computed = items.map((item, index) => {
    const gross = item.quantity * item.unitPrice;
    const lineTotal = round2(gross * (1 - (item.discount ?? 0) / 100));
    return { ...item, lineTotal, position: index };
  });

  // Optionale Positionen zählen nicht zum verbindlichen Total.
  const billable = computed.filter((item) => !item.optional);
  const subtotal = round2(billable.reduce((sum, item) => sum + item.lineTotal, 0));

  const discountAmount =
    discountType === 'PERCENT'
      ? round2(subtotal * (discountValue / 100))
      : round2(Math.min(discountValue, subtotal));

  const netTotal = round2(subtotal - discountAmount);

  // MWST pro Satz berechnen, damit gemischte Sätze korrekt bleiben.
  const discountFactor = subtotal > 0 ? netTotal / subtotal : 1;
  const vatAmount = round2(
    billable.reduce(
      (sum, item) => sum + item.lineTotal * discountFactor * (item.vatRate / 100),
      0,
    ),
  );

  return {
    subtotal,
    discountAmount,
    netTotal,
    vatAmount,
    grossTotal: round2(netTotal + vatAmount),
    items: computed,
  };
}

// ---------------------------------------------------------------------------
//  CRUD
// ---------------------------------------------------------------------------

export async function createQuote(params: {
  organizationId: string;
  input: CreateQuoteInput;
  actorId: string;
}): Promise<Quote> {
  const totals = computeQuoteTotals(
    params.input.items,
    params.input.discountType,
    params.input.discountValue,
  );

  const quote = await prisma.$transaction(async (tx) => {
    const { number } = await nextNumber(tx, params.organizationId, 'quote');

    return tx.quote.create({
      data: {
        organizationId: params.organizationId,
        number,
        customerId: params.input.customerId ?? null,
        leadId: params.input.leadId ?? null,
        propertyId: params.input.propertyId ?? null,
        title: params.input.title,
        status: 'DRAFT',
        validUntil: params.input.validUntil,
        introText: params.input.introText ?? null,
        outroText: params.input.outroText ?? null,
        terms: params.input.terms ?? defaultTerms(),
        internalNote: params.input.internalNote ?? null,
        discountType: params.input.discountType ?? null,
        discountValue: params.input.discountValue,
        discountAmount: totals.discountAmount,
        subtotal: totals.subtotal,
        netTotal: totals.netTotal,
        vatAmount: totals.vatAmount,
        grossTotal: totals.grossTotal,
        createdById: params.actorId,
        items: {
          create: totals.items.map((item) => ({
            serviceId: item.serviceId ?? null,
            name: item.name,
            description: item.description ?? null,
            quantity: item.quantity,
            unit: item.unit,
            unitPrice: item.unitPrice,
            discount: item.discount ?? 0,
            vatRate: item.vatRate,
            lineTotal: item.lineTotal,
            position: item.position,
            optional: item.optional ?? false,
          })),
        },
      },
    });
  });

  // Lead in die Angebotsphase überführen.
  if (params.input.leadId) {
    await prisma.lead.update({
      where: { id: params.input.leadId },
      data: { status: 'PROPOSAL' },
    });
  }

  await audit.created({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Quote',
    entityId: quote.id,
    summary: `Offerte ${quote.number} erstellt`,
  });

  return quote;
}

export async function updateQuote(params: {
  organizationId: string;
  quoteId: string;
  input: UpdateQuoteInput;
  actorId: string;
}): Promise<Quote> {
  const quote = await prisma.quote.findFirst({
    where: { id: params.quoteId, organizationId: params.organizationId, deletedAt: null },
  });
  if (!quote) throw new NotFoundError('Offerte');

  if (['ACCEPTED', 'CONVERTED'].includes(quote.status)) {
    throw new BusinessRuleError(
      'Eine angenommene Offerte kann nicht mehr geändert werden. Erstellen Sie stattdessen eine Kopie.',
    );
  }

  const data: Prisma.QuoteUpdateInput = {
    ...(params.input.title !== undefined ? { title: params.input.title } : {}),
    ...(params.input.validUntil ? { validUntil: params.input.validUntil } : {}),
    ...(params.input.introText !== undefined ? { introText: params.input.introText } : {}),
    ...(params.input.outroText !== undefined ? { outroText: params.input.outroText } : {}),
    ...(params.input.terms !== undefined ? { terms: params.input.terms } : {}),
    ...(params.input.internalNote !== undefined ? { internalNote: params.input.internalNote } : {}),
  };

  if (params.input.items) {
    const totals = computeQuoteTotals(
      params.input.items,
      params.input.discountType ?? quote.discountType ?? undefined,
      params.input.discountValue ?? toNumber(quote.discountValue),
    );

    Object.assign(data, {
      discountType: params.input.discountType ?? quote.discountType,
      discountValue: params.input.discountValue ?? quote.discountValue,
      discountAmount: totals.discountAmount,
      subtotal: totals.subtotal,
      netTotal: totals.netTotal,
      vatAmount: totals.vatAmount,
      grossTotal: totals.grossTotal,
      // PDF ist nach einer Änderung nicht mehr aktuell.
      pdfUrl: null,
      items: {
        deleteMany: {},
        create: totals.items.map((item) => ({
          serviceId: item.serviceId ?? null,
          name: item.name,
          description: item.description ?? null,
          quantity: item.quantity,
          unit: item.unit,
          unitPrice: item.unitPrice,
          discount: item.discount ?? 0,
          vatRate: item.vatRate,
          lineTotal: item.lineTotal,
          position: item.position,
          optional: item.optional ?? false,
        })),
      },
    });
  }

  const updated = await prisma.quote.update({ where: { id: quote.id }, data });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Quote',
    entityId: quote.id,
    summary: `Offerte ${quote.number} bearbeitet`,
  });

  return updated;
}

/** Kopie erstellen — spart Zeit bei ähnlichen Anfragen. */
export async function duplicateQuote(params: {
  organizationId: string;
  quoteId: string;
  actorId: string;
}): Promise<Quote> {
  const source = await prisma.quote.findFirst({
    where: { id: params.quoteId, organizationId: params.organizationId },
    include: { items: { orderBy: { position: 'asc' } } },
  });
  if (!source) throw new NotFoundError('Offerte');

  const copy = await prisma.$transaction(async (tx) => {
    const { number } = await nextNumber(tx, params.organizationId, 'quote');

    return tx.quote.create({
      data: {
        organizationId: params.organizationId,
        number,
        customerId: source.customerId,
        leadId: source.leadId,
        propertyId: source.propertyId,
        title: `${source.title} (Kopie)`,
        status: 'DRAFT',
        // Gültigkeit ab heute neu bemessen (30 Tage).
        validUntil: new Date(Date.now() + 30 * 86_400_000),
        introText: source.introText,
        outroText: source.outroText,
        terms: source.terms,
        discountType: source.discountType,
        discountValue: source.discountValue,
        discountAmount: source.discountAmount,
        subtotal: source.subtotal,
        netTotal: source.netTotal,
        vatAmount: source.vatAmount,
        grossTotal: source.grossTotal,
        createdById: params.actorId,
        items: {
          create: source.items.map((item) => ({
            serviceId: item.serviceId,
            name: item.name,
            description: item.description,
            quantity: item.quantity,
            unit: item.unit,
            unitPrice: item.unitPrice,
            discount: item.discount,
            vatRate: item.vatRate,
            lineTotal: item.lineTotal,
            position: item.position,
            optional: item.optional,
          })),
        },
      },
    });
  });

  await audit.created({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Quote',
    entityId: copy.id,
    summary: `Offerte ${copy.number} als Kopie von ${source.number} erstellt`,
  });

  return copy;
}

// ---------------------------------------------------------------------------
//  Versand & Antwort
// ---------------------------------------------------------------------------

export async function sendQuote(params: {
  organizationId: string;
  quoteId: string;
  email?: string;
  message?: string;
  attachPdf?: boolean;
  actorId: string;
}): Promise<Quote> {
  const quote = await prisma.quote.findFirst({
    where: { id: params.quoteId, organizationId: params.organizationId, deletedAt: null },
    include: {
      customer: { include: { user: { select: { id: true } } } },
      lead: true,
      items: true,
    },
  });
  if (!quote) throw new NotFoundError('Offerte');
  if (quote.items.length === 0) {
    throw new BusinessRuleError('Die Offerte enthält keine Positionen.');
  }

  const recipientEmail = params.email ?? quote.customer?.email ?? quote.lead?.email;
  if (!recipientEmail) {
    throw new BusinessRuleError('Für diese Offerte ist keine E-Mail-Adresse hinterlegt.');
  }

  const firstName = quote.customer?.firstName ?? quote.lead?.firstName ?? 'Kundin/Kunde';
  const publicUrl = absoluteUrl(`/offerte/${quote.publicToken}`);

  let attachments: { filename: string; content: Buffer }[] | undefined;
  if (params.attachPdf !== false) {
    const pdf = await renderQuotePdf(quote.id);
    attachments = [{ filename: pdf.filename, content: pdf.buffer }];
  }

  await notify({
    userId: quote.customer?.user?.id ?? null,
    email: recipientEmail,
    channels: ['IN_APP', 'EMAIL'],
    title: 'Neue Offerte erhalten',
    body: `Offerte ${quote.number} über CHF ${toNumber(quote.grossTotal).toFixed(2)}`,
    // In-App zur Übersicht: von dort führt „Ansehen und antworten" auf die
    // Token-Seite, die auch ohne Login funktioniert.
    link: '/konto/offerten',
    emailContent: quoteSentEmail({
      firstName,
      quoteNumber: quote.number,
      title: quote.title,
      grossTotal: toNumber(quote.grossTotal),
      validUntil: quote.validUntil,
      quoteUrl: publicUrl,
      message: params.message,
    }),
    emailAttachments: attachments,
    entity: 'Quote',
    entityId: quote.id,
  });

  const updated = await prisma.quote.update({
    where: { id: quote.id },
    data: { status: 'SENT', sentAt: new Date() },
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Quote',
    entityId: quote.id,
    summary: `Offerte ${quote.number} an ${recipientEmail} versendet`,
  });

  return updated;
}

/** Öffentlicher Zugriff über den Token; markiert die Offerte als angesehen. */
export async function getQuoteByToken(token: string) {
  const quote = await prisma.quote.findUnique({
    where: { publicToken: token },
    include: {
      items: { orderBy: { position: 'asc' } },
      customer: { select: { firstName: true, lastName: true, companyName: true, email: true } },
      lead: { select: { firstName: true, lastName: true, company: true, email: true } },
      organization: {
        select: { name: true, email: true, phone: true, logoUrl: true, primaryColor: true },
      },
    },
  });
  if (!quote || quote.deletedAt) throw new NotFoundError('Offerte');

  if (quote.status === 'SENT' && !quote.viewedAt) {
    await prisma.quote.update({
      where: { id: quote.id },
      data: { status: 'VIEWED', viewedAt: new Date() },
    });
  }

  return quote;
}

export async function respondToQuote(params: {
  token: string;
  input: RespondQuoteInput;
  ip?: string;
}): Promise<Quote> {
  const quote = await prisma.quote.findUnique({
    where: { publicToken: params.token },
    include: { customer: true, lead: true },
  });
  if (!quote || quote.deletedAt) throw new NotFoundError('Offerte');

  if (['ACCEPTED', 'REJECTED', 'CONVERTED'].includes(quote.status)) {
    throw new BusinessRuleError('Diese Offerte wurde bereits beantwortet.');
  }
  if (quote.validUntil < new Date()) {
    throw new BusinessRuleError(
      'Diese Offerte ist abgelaufen. Wir erstellen Ihnen gerne ein aktualisiertes Angebot.',
    );
  }

  const accepted = params.input.decision === 'ACCEPT';

  const updated = await prisma.quote.update({
    where: { id: quote.id },
    data: accepted
      ? {
          status: 'ACCEPTED',
          acceptedAt: new Date(),
          signatureDataUrl: params.input.signatureDataUrl ?? null,
          signatureName: params.input.signatureName ?? null,
          signatureIp: params.ip ?? null,
          signedAt: new Date(),
        }
      : {
          status: 'REJECTED',
          rejectedAt: new Date(),
          rejectReason: params.input.reason ?? null,
        },
  });

  if (quote.leadId) {
    await prisma.lead.update({
      where: { id: quote.leadId },
      data: accepted
        ? { status: 'WON', convertedAt: new Date() }
        : { status: 'LOST', lostReason: params.input.reason ?? 'Offerte abgelehnt' },
    });
  }

  const customerName =
    quote.customer?.companyName ??
    `${quote.customer?.firstName ?? quote.lead?.firstName ?? ''} ${quote.customer?.lastName ?? quote.lead?.lastName ?? ''}`.trim();

  await notifyStaff({
    organizationId: quote.organizationId,
    title: accepted ? 'Offerte angenommen' : 'Offerte abgelehnt',
    body: `${quote.number} · ${customerName} · CHF ${toNumber(quote.grossTotal).toFixed(2)}`,
    link: `/admin/offerten/${quote.id}`,
    emailContent: accepted
      ? quoteAcceptedInternalEmail({
          quoteNumber: quote.number,
          customerName,
          grossTotal: toNumber(quote.grossTotal),
          adminUrl: absoluteUrl(`/admin/offerten/${quote.id}`),
        })
      : undefined,
  });

  await audit.updated({
    organizationId: quote.organizationId,
    entity: 'Quote',
    entityId: quote.id,
    summary: `Offerte ${quote.number} durch Kundschaft ${accepted ? 'angenommen' : 'abgelehnt'}`,
    ip: params.ip,
  });

  // PDF mit Unterschrift neu erzeugen.
  if (accepted) {
    await renderQuotePdf(quote.id).catch(() => undefined);
  }

  return updated;
}

// ---------------------------------------------------------------------------
//  Umwandlung
// ---------------------------------------------------------------------------

export async function convertQuoteToBooking(params: {
  organizationId: string;
  quoteId: string;
  scheduledStart: Date;
  addressId?: string;
  actorId: string;
}) {
  const quote = await prisma.quote.findFirst({
    where: { id: params.quoteId, organizationId: params.organizationId, deletedAt: null },
    include: { items: { orderBy: { position: 'asc' } }, customer: true },
  });
  if (!quote) throw new NotFoundError('Offerte');
  if (!quote.customerId) {
    throw new BusinessRuleError(
      'Bitte wandeln Sie zuerst den Lead in einen Kunden um, bevor Sie eine Buchung erstellen.',
    );
  }
  if (quote.status !== 'ACCEPTED') {
    throw new BusinessRuleError('Nur angenommene Offerten können in eine Buchung überführt werden.');
  }

  const billableItems = quote.items.filter((item) => !item.optional);
  const serviceItem = billableItems.find((item) => item.serviceId);
  if (!serviceItem?.serviceId) {
    throw new BusinessRuleError(
      'Die Offerte enthält keine Position mit verknüpfter Dienstleistung. Bitte ergänzen Sie diese.',
    );
  }

  const durationMin = Math.round(
    billableItems
      .filter((item) => item.unit.toLowerCase().startsWith('std'))
      .reduce((sum, item) => sum + toNumber(item.quantity), 0) * 60,
  ) || 120;

  const addressId =
    params.addressId ??
    (
      await prisma.address.findFirst({
        where: { customerId: quote.customerId },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      })
    )?.id;

  const booking = await prisma.$transaction(async (tx) => {
    const { number } = await nextNumber(tx, params.organizationId, 'booking');

    const created = await tx.booking.create({
      data: {
        organizationId: params.organizationId,
        number,
        customerId: quote.customerId!,
        addressId: addressId ?? null,
        propertyId: quote.propertyId,
        quoteId: quote.id,
        status: 'CONFIRMED',
        confirmedAt: new Date(),
        scheduledStart: params.scheduledStart,
        scheduledEnd: new Date(params.scheduledStart.getTime() + durationMin * 60_000),
        durationMin,
        crewSize: Math.max(1, Math.ceil(durationMin / 240)),
        frequency: 'ONCE',
        subtotal: quote.subtotal,
        discountAmount: quote.discountAmount,
        netTotal: quote.netTotal,
        vatAmount: quote.vatAmount,
        grossTotal: quote.grossTotal,
        source: 'EMAIL',
        items: {
          create: billableItems
            .filter((item) => item.serviceId)
            .map((item, index) => ({
              serviceId: item.serviceId!,
              name: item.name,
              description: item.description,
              quantity: item.quantity,
              unit: item.unit,
              unitPrice: item.unitPrice,
              vatRate: item.vatRate,
              lineTotal: item.lineTotal,
              position: index,
              durationMin: index === 0 ? durationMin : 0,
            })),
        },
      },
    });

    await tx.quote.update({
      where: { id: quote.id },
      data: { status: 'CONVERTED', convertedBookingId: created.id },
    });

    return created;
  });

  // Einsatz erzeugen (ausserhalb, damit Checklisten-Templates greifen).
  const { createJobsForBooking } = await import('./job.service');
  await prisma.$transaction(async (tx) => {
    await createJobsForBooking(tx, booking.id);
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Quote',
    entityId: quote.id,
    summary: `Offerte ${quote.number} in Buchung ${booking.number} umgewandelt`,
  });

  return booking;
}

export async function convertQuoteToInvoice(params: {
  organizationId: string;
  quoteId: string;
  actorId: string;
}) {
  const invoice = await createInvoiceFromQuote({
    organizationId: params.organizationId,
    quoteId: params.quoteId,
    actorId: params.actorId,
  });

  await prisma.quote.update({
    where: { id: params.quoteId },
    data: { status: 'CONVERTED', convertedInvoiceId: invoice.id },
  });

  return invoice;
}

// ---------------------------------------------------------------------------
//  Abfragen & Wartung
// ---------------------------------------------------------------------------

/** Spalten, nach denen die Offertenliste sortiert werden darf. */
export const QUOTE_SORT_FIELDS = [
  'number',
  'title',
  'createdAt',
  'validUntil',
  'grossTotal',
  'status',
] as const;

export async function listQuotes(filter: {
  organizationId: string;
  status?: Quote['status'];
  customerId?: string;
  q?: string;
  page: number;
  pageSize: number;
  sort?: string;
  order?: SortOrder;
}) {
  const where: Prisma.QuoteWhereInput = {
    organizationId: filter.organizationId,
    deletedAt: null,
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.customerId ? { customerId: filter.customerId } : {}),
    ...(filter.q
      ? {
          OR: [
            { number: { contains: filter.q, mode: 'insensitive' } },
            { title: { contains: filter.q, mode: 'insensitive' } },
            { customer: { lastName: { contains: filter.q, mode: 'insensitive' } } },
            { lead: { lastName: { contains: filter.q, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };

  const sorting = resolveSort({ sort: filter.sort, order: filter.order }, QUOTE_SORT_FIELDS, {
    sort: 'createdAt',
    order: 'desc',
  });

  const [items, total] = await Promise.all([
    prisma.quote.findMany({
      where,
      orderBy: orderByFor(sorting, 'number'),
      skip: (filter.page - 1) * filter.pageSize,
      take: filter.pageSize,
      include: {
        customer: { select: { id: true, firstName: true, lastName: true, companyName: true } },
        lead: { select: { id: true, firstName: true, lastName: true, company: true } },
        _count: { select: { items: true } },
      },
    }),
    prisma.quote.count({ where }),
  ]);

  return { items, total };
}

export async function getQuoteDetail(params: {
  organizationId: string;
  quoteId: string;
  customerId?: string;
}) {
  const quote = await prisma.quote.findFirst({
    where: {
      id: params.quoteId,
      organizationId: params.organizationId,
      deletedAt: null,
      ...(params.customerId ? { customerId: params.customerId } : {}),
    },
    include: {
      items: { orderBy: { position: 'asc' } },
      customer: { include: { addresses: true } },
      lead: true,
      property: true,
      files: true,
      activities: { orderBy: { occurredAt: 'desc' }, take: 30 },
    },
  });
  if (!quote) throw new NotFoundError('Offerte');
  return quote;
}

/** Cron: abgelaufene Offerten markieren und rechtzeitig erinnern. */
export async function processExpiringQuotes(organizationId: string): Promise<{
  expired: number;
  reminded: number;
}> {
  const now = new Date();
  const inThreeDays = new Date(now.getTime() + 3 * 86_400_000);

  const expiredResult = await prisma.quote.updateMany({
    where: {
      organizationId,
      deletedAt: null,
      status: { in: ['SENT', 'VIEWED'] },
      validUntil: { lt: now },
    },
    data: { status: 'EXPIRED' },
  });

  const expiring = await prisma.quote.findMany({
    where: {
      organizationId,
      deletedAt: null,
      status: { in: ['SENT', 'VIEWED'] },
      validUntil: { gte: now, lte: inThreeDays },
    },
    include: {
      customer: { include: { user: { select: { id: true } } } },
      lead: true,
    },
  });

  for (const quote of expiring) {
    const email = quote.customer?.email ?? quote.lead?.email;
    if (!email) continue;

    await notify({
      userId: quote.customer?.user?.id ?? null,
      email,
      channels: ['EMAIL'],
      title: 'Offerte läuft ab',
      body: `Offerte ${quote.number} läuft am ${quote.validUntil.toLocaleDateString('de-CH')} ab.`,
      emailContent: quoteExpiringEmail({
        firstName: quote.customer?.firstName ?? quote.lead?.firstName ?? 'Kundin/Kunde',
        quoteNumber: quote.number,
        validUntil: quote.validUntil,
        quoteUrl: absoluteUrl(`/offerte/${quote.publicToken}`),
      }),
      entity: 'Quote',
      entityId: quote.id,
    });
  }

  return { expired: expiredResult.count, reminded: expiring.length };
}

function defaultTerms(): string {
  return [
    'Diese Offerte ist 30 Tage gültig und unverbindlich.',
    'Alle Preise verstehen sich in Schweizer Franken zuzüglich der gesetzlichen Mehrwertsteuer von 8.1 %.',
    'Die Ausführung erfolgt nach Terminvereinbarung. Material und Reinigungsmittel sind inbegriffen, sofern nicht anders ausgewiesen.',
    'Zahlungskonditionen: 30 Tage netto ab Rechnungsdatum.',
    'Es gelten unsere Allgemeinen Geschäftsbedingungen.',
  ].join(' ');
}
