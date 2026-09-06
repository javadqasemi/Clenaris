import 'server-only';

import type { Invoice, PaymentMethod, Prisma } from '@prisma/client';

import { prisma, toNumber } from '@/lib/db';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { absoluteUrl, round2 } from '@/lib/utils';
import { orderByFor, resolveSort, type SortOrder } from '@/lib/sort';
import { audit } from '@/lib/audit';
import {
  invoiceIssuedEmail,
  paymentReceivedEmail,
  paymentReminderEmail,
} from '@/lib/email/templates';
import { smsTemplates } from '@/lib/sms/client';
import { renderInvoicePdf } from '@/lib/pdf/render';
import { buildQrReference } from '@/lib/pdf/swiss-qr';
import type {
  CreateInvoiceInput,
  InvoiceItemInput,
  RecordPaymentInput,
} from '@/lib/validation/finance';

import { nextNumber } from './numbering.service';
import { notify } from './notification.service';
import { logger } from '@/lib/logger';

const log = logger('invoice');

/**
 * Rechnungsstellung und Zahlungsabgleich.
 *
 * Architekturentscheide:
 *  1. Rechnungen sind nach dem Ausstellen unveränderlich. Ein `DRAFT` darf
 *     bearbeitet werden; sobald eine Nummer vergeben ist (`ISSUED`), führen
 *     Korrekturen zwingend über eine Gutschrift. Das ist die Anforderung aus
 *     Art. 957a OR und dem MWSTG.
 *  2. Empfängerdaten werden beim Ausstellen als Snapshot kopiert. Zieht die
 *     Kundschaft um, bleibt die ausgestellte Rechnung historisch korrekt.
 *  3. `balance` wird bei jeder Zahlung neu gesetzt statt berechnet — so kann
 *     die Mahnstufen-Abfrage einen Index nutzen und muss nicht aggregieren.
 *  4. MWST wird pro Position gerechnet und aufsummiert, nie auf dem Total.
 *     Bei gemischten Sätzen weicht die Rundung sonst um Rappen ab.
 */

const REMINDER_FEES = [0, 0, 20, 40]; // Stufe 0..3 — Stufe 1 ist gebührenfrei

interface ComputedInvoiceTotals {
  subtotal: number;
  netTotal: number;
  vatAmount: number;
  grossTotal: number;
  items: (InvoiceItemInput & {
    netAmount: number;
    vatAmount: number;
    lineTotal: number;
    position: number;
  })[];
}

export function computeInvoiceTotals(
  items: InvoiceItemInput[],
  discountAmount = 0,
): ComputedInvoiceTotals {
  const computed = items.map((item, index) => {
    const gross = item.quantity * item.unitPrice;
    const netAmount = round2(gross * (1 - (item.discount ?? 0) / 100));
    const vatAmount = round2(netAmount * (item.vatRate / 100));
    return {
      ...item,
      netAmount,
      vatAmount,
      lineTotal: round2(netAmount + vatAmount),
      position: index,
    };
  });

  const subtotal = round2(computed.reduce((sum, item) => sum + item.netAmount, 0));
  const cappedDiscount = round2(Math.min(discountAmount, subtotal));
  const netTotal = round2(subtotal - cappedDiscount);

  // Rabatt proportional auf die MWST-Basis umlegen.
  const factor = subtotal > 0 ? netTotal / subtotal : 1;
  const vatAmount = round2(computed.reduce((sum, item) => sum + item.vatAmount * factor, 0));

  return {
    subtotal,
    netTotal,
    vatAmount,
    grossTotal: round2(netTotal + vatAmount),
    items: computed,
  };
}

// ---------------------------------------------------------------------------
//  Erstellen
// ---------------------------------------------------------------------------

export async function createInvoice(params: {
  organizationId: string;
  input: CreateInvoiceInput;
  actorId: string;
}): Promise<Invoice> {
  const customer = await prisma.customer.findFirst({
    where: { id: params.input.customerId, organizationId: params.organizationId, deletedAt: null },
    include: { addresses: { where: { isBilling: true }, take: 1 } },
  });
  if (!customer) throw new NotFoundError('Kunde');

  const totals = computeInvoiceTotals(params.input.items, params.input.discountAmount);

  const issueDate = params.input.issueDate ?? new Date();
  const dueDate =
    params.input.dueDate ??
    new Date(issueDate.getTime() + customer.paymentTermDays * 86_400_000);

  const billing = customer.addresses[0];

  const invoice = await prisma.$transaction(async (tx) => {
    // Entwürfe erhalten eine Platzhalternummer, damit die Sequenz nicht
    // durch verworfene Entwürfe Lücken bekommt.
    let number = `ENTWURF-${Date.now().toString(36).toUpperCase()}`;
    let qrReference: string | null = null;

    if (params.input.issueImmediately) {
      const seq = await nextNumber(tx, params.organizationId, 'invoice', issueDate);
      number = seq.number;
      qrReference = buildQrReference({ invoiceSequence: seq.sequence });
    }

    return tx.invoice.create({
      data: {
        organizationId: params.organizationId,
        number,
        customerId: customer.id,
        bookingId: params.input.bookingId ?? null,
        quoteId: params.input.quoteId ?? null,
        status: params.input.issueImmediately ? 'ISSUED' : 'DRAFT',
        issueDate,
        dueDate,
        periodFrom: params.input.periodFrom ?? null,
        periodTo: params.input.periodTo ?? null,
        billToName: `${customer.firstName} ${customer.lastName}`,
        billToCompany: customer.companyName,
        billToStreet: billing ? [billing.street, billing.streetNo].filter(Boolean).join(' ') : '—',
        billToZip: billing?.postalCode ?? '',
        billToCity: billing?.city ?? '',
        billToCountry: billing?.country ?? 'CH',
        billToEmail: customer.email,
        billToVat: customer.vatNumber,
        introText: params.input.introText ?? null,
        outroText: params.input.outroText ?? null,
        notes: params.input.notes ?? null,
        subtotal: totals.subtotal,
        discountAmount: params.input.discountAmount,
        netTotal: totals.netTotal,
        vatAmount: totals.vatAmount,
        grossTotal: totals.grossTotal,
        balance: totals.grossTotal,
        qrReference,
        createdById: params.actorId,
        items: {
          create: totals.items.map((item) => ({
            jobId: item.jobId ?? null,
            name: item.name,
            description: item.description ?? null,
            quantity: item.quantity,
            unit: item.unit,
            unitPrice: item.unitPrice,
            discount: item.discount ?? 0,
            vatRate: item.vatRate,
            netAmount: item.netAmount,
            vatAmount: item.vatAmount,
            lineTotal: item.lineTotal,
            position: item.position,
          })),
        },
      },
    });
  });

  await audit.created({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Invoice',
    entityId: invoice.id,
    summary: `Rechnung ${invoice.number} erstellt (${toNumber(invoice.grossTotal).toFixed(2)} CHF)`,
  });

  return invoice;
}

/** Sammelrechnung aus abgeschlossenen Einsätzen. */
export async function createInvoiceFromJobs(params: {
  organizationId: string;
  customerId: string;
  jobIds: string[];
  periodFrom?: Date;
  periodTo?: Date;
  issueImmediately: boolean;
  actorId: string;
}): Promise<Invoice> {
  const jobs = await prisma.job.findMany({
    where: {
      id: { in: params.jobIds },
      organizationId: params.organizationId,
      customerId: params.customerId,
      deletedAt: null,
    },
    include: {
      service: true,
      timeEntries: true,
      materials: { where: { billable: true } },
      booking: { include: { items: true } },
    },
  });

  if (jobs.length === 0) throw new NotFoundError('Einsätze');

  const notCompleted = jobs.filter((j) => !['COMPLETED', 'VERIFIED'].includes(j.status));
  if (notCompleted.length > 0) {
    throw new BusinessRuleError(
      `Folgende Einsätze sind noch nicht abgeschlossen: ${notCompleted.map((j) => j.number).join(', ')}.`,
    );
  }

  const alreadyInvoiced = await prisma.invoiceItem.findMany({
    where: { jobId: { in: params.jobIds } },
    select: { jobId: true },
  });
  if (alreadyInvoiced.length > 0) {
    throw new BusinessRuleError('Mindestens ein Einsatz wurde bereits verrechnet.');
  }

  const items: InvoiceItemInput[] = [];

  for (const job of jobs) {
    const bookingItem = job.booking?.items[0];
    const minutes =
      job.timeEntries.reduce((sum, e) => sum + e.minutes, 0) || job.estimatedMin;
    const hours = round2(minutes / 60);

    items.push({
      jobId: job.id,
      name: `${job.service?.name ?? job.title} · ${job.scheduledStart.toLocaleDateString('de-CH')}`,
      description: job.completionNote ?? undefined,
      quantity: bookingItem ? toNumber(bookingItem.quantity) : hours,
      unit: bookingItem?.unit ?? 'Std.',
      unitPrice: bookingItem
        ? toNumber(bookingItem.unitPrice)
        : round2(toNumber(job.revenue) / Math.max(hours, 0.5)),
      discount: 0,
      vatRate: bookingItem ? toNumber(bookingItem.vatRate) : 8.1,
    });

    for (const material of job.materials) {
      items.push({
        jobId: job.id,
        name: `Material: ${material.name}`,
        quantity: toNumber(material.quantity),
        unit: material.unit,
        unitPrice: toNumber(material.unitCost),
        discount: 0,
        vatRate: 8.1,
      });
    }
  }

  return createInvoice({
    organizationId: params.organizationId,
    actorId: params.actorId,
    input: {
      customerId: params.customerId,
      items,
      discountAmount: 0,
      periodFrom: params.periodFrom,
      periodTo: params.periodTo,
      issueImmediately: params.issueImmediately,
    } as CreateInvoiceInput,
  });
}

export async function createInvoiceFromQuote(params: {
  organizationId: string;
  quoteId: string;
  actorId: string;
}): Promise<Invoice> {
  const quote = await prisma.quote.findFirst({
    where: { id: params.quoteId, organizationId: params.organizationId, deletedAt: null },
    include: { items: { orderBy: { position: 'asc' } } },
  });
  if (!quote) throw new NotFoundError('Offerte');
  if (!quote.customerId) {
    throw new BusinessRuleError('Die Offerte ist keinem Kunden zugeordnet.');
  }

  return createInvoice({
    organizationId: params.organizationId,
    actorId: params.actorId,
    input: {
      customerId: quote.customerId,
      quoteId: quote.id,
      introText: quote.introText ?? undefined,
      outroText: quote.outroText ?? undefined,
      discountAmount: toNumber(quote.discountAmount),
      issueImmediately: true,
      items: quote.items
        .filter((item) => !item.optional)
        .map((item) => ({
          name: item.name,
          description: item.description ?? undefined,
          quantity: toNumber(item.quantity),
          unit: item.unit,
          unitPrice: toNumber(item.unitPrice),
          discount: toNumber(item.discount),
          vatRate: toNumber(item.vatRate),
        })),
    } as CreateInvoiceInput,
  });
}

/** Entwurf ausstellen: Nummer vergeben, QR-Referenz setzen, PDF erzeugen. */
export async function issueInvoice(params: {
  organizationId: string;
  invoiceId: string;
  actorId: string;
}): Promise<Invoice> {
  const invoice = await prisma.invoice.findFirst({
    where: { id: params.invoiceId, organizationId: params.organizationId, deletedAt: null },
    include: { items: true },
  });
  if (!invoice) throw new NotFoundError('Rechnung');
  if (invoice.status !== 'DRAFT') {
    throw new BusinessRuleError('Diese Rechnung wurde bereits ausgestellt.');
  }
  if (invoice.items.length === 0) {
    throw new BusinessRuleError('Die Rechnung enthält keine Positionen.');
  }

  const issued = await prisma.$transaction(async (tx) => {
    const seq = await nextNumber(tx, params.organizationId, 'invoice', invoice.issueDate);
    return tx.invoice.update({
      where: { id: invoice.id },
      data: {
        number: seq.number,
        status: 'ISSUED',
        qrReference: buildQrReference({ invoiceSequence: seq.sequence }),
      },
    });
  });

  await renderInvoicePdf(issued.id).catch((error) =>
    log.error('PDF-Erzeugung fehlgeschlagen', { error }),
  );

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Invoice',
    entityId: issued.id,
    summary: `Rechnung ${issued.number} ausgestellt`,
  });

  return issued;
}

// ---------------------------------------------------------------------------
//  Versand
// ---------------------------------------------------------------------------

export async function sendInvoice(params: {
  organizationId: string;
  invoiceId: string;
  email?: string;
  actorId: string;
}): Promise<Invoice> {
  let invoice = await prisma.invoice.findFirst({
    where: { id: params.invoiceId, organizationId: params.organizationId, deletedAt: null },
    include: { customer: { include: { user: { select: { id: true } } } } },
  });
  if (!invoice) throw new NotFoundError('Rechnung');

  if (invoice.status === 'DRAFT') {
    await issueInvoice({
      organizationId: params.organizationId,
      invoiceId: invoice.id,
      actorId: params.actorId,
    });
    invoice = await prisma.invoice.findFirstOrThrow({
      where: { id: params.invoiceId },
      include: { customer: { include: { user: { select: { id: true } } } } },
    });
  }

  const pdf = await renderInvoicePdf(invoice.id);
  const recipient = params.email ?? invoice.billToEmail ?? invoice.customer.email;

  await notify({
    userId: invoice.customer.user?.id ?? null,
    email: recipient,
    channels: ['IN_APP', 'EMAIL'],
    title: 'Neue Rechnung',
    body: `Rechnung ${invoice.number} über CHF ${toNumber(invoice.grossTotal).toFixed(2)}`,
    link: `/konto/rechnungen/${invoice.id}`,
    emailContent: invoiceIssuedEmail({
      firstName: invoice.customer.firstName,
      invoiceNumber: invoice.number,
      grossTotal: toNumber(invoice.grossTotal),
      dueDate: invoice.dueDate,
      invoiceUrl: absoluteUrl(`/rechnung/${invoice.publicToken}`),
      payUrl: absoluteUrl(`/rechnung/${invoice.publicToken}/bezahlen`),
    }),
    emailAttachments: [{ filename: pdf.filename, content: pdf.buffer }],
    entity: 'Invoice',
    entityId: invoice.id,
  });

  const updated = await prisma.invoice.update({
    where: { id: invoice.id },
    data: { status: 'SENT', sentAt: new Date() },
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Invoice',
    entityId: invoice.id,
    summary: `Rechnung ${invoice.number} an ${recipient} versendet`,
  });

  return updated;
}

// ---------------------------------------------------------------------------
//  Zahlungen
// ---------------------------------------------------------------------------

export async function recordPayment(params: {
  organizationId: string;
  invoiceId: string;
  input: RecordPaymentInput;
  actorId?: string | null;
  provider?: string;
  providerPaymentId?: string;
}): Promise<{ invoice: Invoice; fullyPaid: boolean }> {
  const invoice = await prisma.invoice.findFirst({
    where: { id: params.invoiceId, organizationId: params.organizationId, deletedAt: null },
    include: { customer: { include: { user: { select: { id: true } } } } },
  });
  if (!invoice) throw new NotFoundError('Rechnung');
  if (invoice.status === 'CANCELLED') {
    throw new BusinessRuleError('Für eine stornierte Rechnung können keine Zahlungen erfasst werden.');
  }

  // Idempotenz: derselbe Provider-Payment darf nur einmal gebucht werden.
  if (params.providerPaymentId) {
    const existing = await prisma.payment.findUnique({
      where: { providerPaymentId: params.providerPaymentId },
    });
    if (existing) {
      return { invoice, fullyPaid: toNumber(invoice.balance) <= 0 };
    }
  }

  const amount = round2(params.input.amount);
  const newPaid = round2(toNumber(invoice.paidAmount) + amount);
  const newBalance = round2(toNumber(invoice.grossTotal) - newPaid);
  const fullyPaid = newBalance <= 0.05; // Rundungstoleranz von 5 Rappen

  const updated = await prisma.$transaction(async (tx) => {
    await tx.payment.create({
      data: {
        invoiceId: invoice.id,
        customerId: invoice.customerId,
        amount,
        currency: invoice.currency,
        method: params.input.method as PaymentMethod,
        status: 'SUCCEEDED',
        reference: params.input.reference ?? null,
        note: params.input.note ?? null,
        provider: params.provider ?? 'manual',
        providerPaymentId: params.providerPaymentId ?? null,
        paidAt: params.input.paidAt ?? new Date(),
      },
    });

    const result = await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        paidAmount: newPaid,
        balance: Math.max(0, newBalance),
        status: fullyPaid ? 'PAID' : 'PARTIALLY_PAID',
        paidAt: fullyPaid ? new Date() : null,
      },
    });

    // Kundenwert (Lifetime Value) fortschreiben.
    await tx.customer.update({
      where: { id: invoice.customerId },
      data: { lifetimeValue: { increment: amount } },
    });

    return result;
  });

  if (fullyPaid) {
    await notify({
      userId: invoice.customer.user?.id ?? null,
      email: invoice.customer.email,
      channels: ['IN_APP', 'EMAIL'],
      title: 'Zahlung erhalten',
      body: `Ihre Zahlung zur Rechnung ${invoice.number} ist eingegangen.`,
      emailContent: paymentReceivedEmail({
        firstName: invoice.customer.firstName,
        invoiceNumber: invoice.number,
        amount: newPaid,
      }),
      entity: 'Invoice',
      entityId: invoice.id,
    });
  }

  await audit.payment({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Invoice',
    entityId: invoice.id,
    summary: `Zahlung CHF ${amount.toFixed(2)} (${params.input.method}) zu Rechnung ${invoice.number}`,
  });

  return { invoice: updated, fullyPaid };
}

// ---------------------------------------------------------------------------
//  Mahnwesen
// ---------------------------------------------------------------------------

/**
 * Cron: überfällige Rechnungen markieren und die nächste Mahnstufe versenden.
 * Stufenabstand: 10 Tage. Stufe 1 ist gebührenfrei, danach fallen Gebühren an.
 */
export async function processOverdueInvoices(organizationId: string): Promise<{
  markedOverdue: number;
  remindersSent: number;
}> {
  const now = new Date();

  const marked = await prisma.invoice.updateMany({
    where: {
      organizationId,
      deletedAt: null,
      status: { in: ['ISSUED', 'SENT', 'PARTIALLY_PAID'] },
      dueDate: { lt: now },
      balance: { gt: 0 },
    },
    data: { status: 'OVERDUE' },
  });

  const candidates = await prisma.invoice.findMany({
    where: {
      organizationId,
      deletedAt: null,
      status: 'OVERDUE',
      balance: { gt: 0 },
      reminderLevel: { lt: 3 },
      OR: [
        { lastReminderAt: null },
        { lastReminderAt: { lt: new Date(now.getTime() - 10 * 86_400_000) } },
      ],
    },
    include: { customer: { include: { user: { select: { id: true } } } } },
    take: 100,
  });

  let sent = 0;

  for (const invoice of candidates) {
    const level = invoice.reminderLevel + 1;
    const fee = REMINDER_FEES[level] ?? 0;

    await notify({
      userId: invoice.customer.user?.id ?? null,
      email: invoice.billToEmail ?? invoice.customer.email,
      phone: invoice.customer.mobile ?? invoice.customer.phone,
      channels: level >= 2 ? ['IN_APP', 'EMAIL', 'SMS'] : ['IN_APP', 'EMAIL'],
      title: level === 1 ? 'Zahlungserinnerung' : `${level - 1}. Mahnung`,
      body: `Rechnung ${invoice.number} ist seit ${invoice.dueDate.toLocaleDateString('de-CH')} fällig.`,
      link: `/konto/rechnungen/${invoice.id}`,
      emailContent: paymentReminderEmail({
        firstName: invoice.customer.firstName,
        invoiceNumber: invoice.number,
        grossTotal: toNumber(invoice.grossTotal),
        balance: toNumber(invoice.balance),
        dueDate: invoice.dueDate,
        level,
        payUrl: absoluteUrl(`/rechnung/${invoice.publicToken}/bezahlen`),
        fee: fee > 0 ? fee : undefined,
      }),
      smsBody: smsTemplates.invoiceOverdue({
        number: invoice.number,
        amount: `CHF ${toNumber(invoice.balance).toFixed(2)}`,
        company: 'Clenaris',
      }),
      entity: 'Invoice',
      entityId: invoice.id,
    });

    await prisma.$transaction([
      prisma.paymentReminder.create({
        data: { invoiceId: invoice.id, level, fee, channel: 'EMAIL' },
      }),
      prisma.invoice.update({
        where: { id: invoice.id },
        data: { reminderLevel: level, lastReminderAt: now },
      }),
    ]);

    sent++;
  }

  return { markedOverdue: marked.count, remindersSent: sent };
}

// ---------------------------------------------------------------------------
//  Storno & Gutschrift
// ---------------------------------------------------------------------------

export async function cancelInvoice(params: {
  organizationId: string;
  invoiceId: string;
  reason: string;
  actorId: string;
}): Promise<Invoice> {
  const invoice = await prisma.invoice.findFirst({
    where: { id: params.invoiceId, organizationId: params.organizationId, deletedAt: null },
  });
  if (!invoice) throw new NotFoundError('Rechnung');
  if (toNumber(invoice.paidAmount) > 0) {
    throw new BusinessRuleError(
      'Für eine teilweise bezahlte Rechnung ist eine Gutschrift zu erstellen, kein Storno.',
    );
  }

  const updated = await prisma.invoice.update({
    where: { id: invoice.id },
    data: {
      status: 'CANCELLED',
      cancelledAt: new Date(),
      balance: 0,
      notes: [invoice.notes, `Storniert: ${params.reason}`].filter(Boolean).join('\n'),
    },
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Invoice',
    entityId: invoice.id,
    summary: `Rechnung ${invoice.number} storniert: ${params.reason}`,
  });

  return updated;
}

export async function createCreditNote(params: {
  organizationId: string;
  customerId: string;
  invoiceId?: string;
  reason: string;
  issueDate?: Date;
  items: { name: string; quantity: number; unit: string; unitPrice: number; vatRate: number }[];
  actorId: string;
}) {
  const netTotal = round2(
    params.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0),
  );
  const vatAmount = round2(
    params.items.reduce(
      (sum, item) => sum + item.quantity * item.unitPrice * (item.vatRate / 100),
      0,
    ),
  );

  const note = await prisma.$transaction(async (tx) => {
    const { number } = await nextNumber(tx, params.organizationId, 'credit_note');

    return tx.creditNote.create({
      data: {
        organizationId: params.organizationId,
        number,
        invoiceId: params.invoiceId ?? null,
        customerId: params.customerId,
        reason: params.reason,
        issueDate: params.issueDate ?? new Date(),
        netTotal,
        vatAmount,
        grossTotal: round2(netTotal + vatAmount),
        items: params.items as unknown as Prisma.InputJsonValue,
      },
    });
  });

  await audit.created({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'CreditNote',
    entityId: note.id,
    summary: `Gutschrift ${note.number} über CHF ${toNumber(note.grossTotal).toFixed(2)}`,
  });

  return note;
}

// ---------------------------------------------------------------------------
//  Abfragen
// ---------------------------------------------------------------------------

/** Spalten, nach denen die Rechnungsliste sortiert werden darf. */
export const INVOICE_SORT_FIELDS = [
  'number',
  'issueDate',
  'dueDate',
  'grossTotal',
  'balance',
  'status',
  'billToName',
] as const;

export async function listInvoices(filter: {
  organizationId: string;
  status?: Invoice['status'];
  customerId?: string;
  from?: Date;
  to?: Date;
  q?: string;
  page: number;
  pageSize: number;
  sort?: string;
  order?: SortOrder;
}) {
  const where: Prisma.InvoiceWhereInput = {
    organizationId: filter.organizationId,
    deletedAt: null,
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.customerId ? { customerId: filter.customerId } : {}),
    ...(filter.from || filter.to
      ? {
          issueDate: {
            ...(filter.from ? { gte: filter.from } : {}),
            ...(filter.to ? { lte: filter.to } : {}),
          },
        }
      : {}),
    ...(filter.q
      ? {
          OR: [
            { number: { contains: filter.q, mode: 'insensitive' } },
            { billToName: { contains: filter.q, mode: 'insensitive' } },
            { billToCompany: { contains: filter.q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const sorting = resolveSort(
    { sort: filter.sort, order: filter.order },
    INVOICE_SORT_FIELDS,
    { sort: 'issueDate', order: 'desc' },
  );

  const [items, total, sums] = await Promise.all([
    prisma.invoice.findMany({
      where,
      orderBy: orderByFor(sorting, 'number'),
      skip: (filter.page - 1) * filter.pageSize,
      take: filter.pageSize,
      include: {
        customer: { select: { id: true, firstName: true, lastName: true, companyName: true } },
        _count: { select: { payments: true } },
      },
    }),
    prisma.invoice.count({ where }),
    prisma.invoice.aggregate({ where, _sum: { grossTotal: true, balance: true } }),
  ]);

  return {
    items,
    total,
    totals: {
      gross: toNumber(sums._sum.grossTotal),
      outstanding: toNumber(sums._sum.balance),
    },
  };
}

export async function getInvoiceDetail(params: {
  organizationId: string;
  invoiceId: string;
  customerId?: string;
}) {
  const invoice = await prisma.invoice.findFirst({
    where: {
      id: params.invoiceId,
      organizationId: params.organizationId,
      deletedAt: null,
      ...(params.customerId ? { customerId: params.customerId } : {}),
    },
    include: {
      items: { orderBy: { position: 'asc' } },
      customer: true,
      payments: { orderBy: { createdAt: 'desc' } },
      reminders: { orderBy: { sentAt: 'desc' } },
      creditNotes: true,
      booking: { select: { id: true, number: true } },
      quote: { select: { id: true, number: true } },
    },
  });
  if (!invoice) throw new NotFoundError('Rechnung');
  return invoice;
}

export async function getInvoiceByToken(token: string) {
  const invoice = await prisma.invoice.findUnique({
    where: { publicToken: token },
    include: {
      items: { orderBy: { position: 'asc' } },
      payments: { where: { status: 'SUCCEEDED' }, orderBy: { paidAt: 'desc' } },
      organization: { select: { name: true, email: true, phone: true, iban: true, qrIban: true } },
      customer: { select: { id: true, email: true, stripeCustomerId: true, firstName: true, lastName: true } },
    },
  });
  if (!invoice || invoice.deletedAt) throw new NotFoundError('Rechnung');

  if (!invoice.viewedAt) {
    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { viewedAt: new Date() },
    });
  }

  return invoice;
}
