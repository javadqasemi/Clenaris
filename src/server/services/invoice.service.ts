import 'server-only';

import { Prisma, type Invoice, type PaymentMethod, type PaymentStatus } from '@prisma/client';

import { prisma, toNumber } from '@/lib/db';
import { aufRappen, geld, max0 } from '@/lib/money';
import { BusinessRuleError, ConflictError, NotFoundError } from '@/lib/errors';
import { absoluteUrl, round2 } from '@/lib/utils';
import { orderByFor, resolveSort, type SortOrder } from '@/lib/sort';
import { audit } from '@/lib/audit';
import { emitAutomationTrigger } from './automation-engine.service';
import {
  invoiceIssuedEmail,
  paymentReceivedEmail,
  paymentReminderEmail,
} from '@/lib/email/templates';
import { smsTemplates } from '@/lib/sms/client';
import { renderCreditNotePdf, renderInvoicePdf } from '@/lib/pdf/render';
import { buildQrReference } from '@/lib/pdf/swiss-qr';
import type {
  CreateInvoiceInput,
  InvoiceItemInput,
  RecordPaymentInput,
} from '@/lib/validation/finance';

import {
  issuePublicToken,
  resolveWithLegacy,
  revokeTokensFor,
  tokenRejectionError,
} from './access-token.service';
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
  /**
   * Herkunft aus einem Vertrag — gesetzt ausschliesslich vom
   * Vertragsrechnungsdienst.
   *
   * Bewusst **kein** Teil von `CreateInvoiceInput`: Die Felder stehen damit
   * nicht in der Zod-Eingabe und sind über `POST /api/invoices` nicht
   * erreichbar. Sonst könnte eine von Hand erfasste Rechnung eine
   * Abrechnungsperiode für sich beanspruchen, die der Serienlauf später
   * braucht — und der Teilindex würde den regulären Lauf abweisen statt der
   * Falscheingabe.
   */
  vertrag?: {
    contractId: string;
    contractVersionId: string;
    /** Periodenbeginn — zusammen mit dem Ende der Schlüssel gegen Doppelabrechnung. */
    contractPeriodStart: Date;
    /** Erster Tag nach der Periode; die Ausschlussbedingung verhindert Überlappung. */
    contractPeriodEnd: Date;
  };
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

    const angelegt = await tx.invoice.create({
      data: {
        organizationId: params.organizationId,
        number,
        customerId: customer.id,
        bookingId: params.input.bookingId ?? null,
        quoteId: params.input.quoteId ?? null,
        contractId: params.vertrag?.contractId ?? null,
        contractVersionId: params.vertrag?.contractVersionId ?? null,
        contractPeriodStart: params.vertrag?.contractPeriodStart ?? null,
        contractPeriodEnd: params.vertrag?.contractPeriodEnd ?? null,
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

    // Jeder Einsatz auf dieser Rechnung wird hier beansprucht — in derselben
    // Transaktion, sonst rollt die Rechnung zurück (samt Nummer).
    await einsaetzeBeanspruchen(tx, {
      organizationId: params.organizationId,
      customerId: customer.id,
      invoiceId: angelegt.id,
      jobIds: totals.items.map((item) => item.jobId),
    });
    return angelegt;
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

/**
 * Die Einsätze einer Rechnung für diese Rechnung beanspruchen (2026-09-27).
 *
 * Eine bedingte Aktualisierung, kein „lesen, dann schreiben": Nur Einsätze
 * derselben Organisation und Kundschaft, die noch **keine** gültige Rechnung
 * tragen, werden gesetzt. Stimmt die Zahl nicht, war mindestens einer schon
 * verrechnet — oder gehört nicht hierher — und die ganze Rechnung scheitert
 * (409). Zwei gleichzeitige Rechnungen für denselben Einsatz treffen dieselbe
 * Zeile; PostgreSQL lässt die zweite warten, und danach sieht sie den Anspruch
 * der ersten.
 *
 * Das gilt für jeden Weg zu einer Rechnung mit Einsatzbezug: Sammelrechnung
 * aus Einsätzen, von Hand erfasste Position mit `jobId`, Vertragsabrechnung
 * je Einsatz.
 */
export async function einsaetzeBeanspruchen(
  tx: Prisma.TransactionClient,
  params: { organizationId: string; customerId: string; invoiceId: string; jobIds: (string | null | undefined)[] },
): Promise<void> {
  const ids = [...new Set(params.jobIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return;
  const beansprucht = await tx.job.updateMany({
    where: { id: { in: ids }, organizationId: params.organizationId, customerId: params.customerId, deletedAt: null, billedInvoiceId: null },
    data: { billedInvoiceId: params.invoiceId },
  });
  if (beansprucht.count !== ids.length) {
    throw new ConflictError('Mindestens ein Einsatz dieser Rechnung ist bereits verrechnet oder gehört nicht zu dieser Kundschaft.');
  }
}

/** Den Anspruch einer Rechnung freigeben — bei Storno und gelöschtem Entwurf. */
export async function einsaetzeFreigeben(tx: Prisma.TransactionClient, invoiceId: string): Promise<void> {
  await tx.job.updateMany({ where: { billedInvoiceId: invoiceId }, data: { billedInvoiceId: null } });
}

type BuchungMitPositionen = Prisma.BookingGetPayload<{ include: { items: true; extras: true } }>;

/**
 * Rechnungszeilen und Rechnungsrabatt aus der Preisherleitung einer Buchung.
 *
 * Die eine Herleitung: Positionen (jede Leistung samt Grundpauschale),
 * Zusatzleistungen, Anfahrt und Zuschläge werden Zeilen, Rabatte
 * (Rhythmus, Stammkunde, Gutschein) der Rechnungsrabatt. Was die
 * gespeicherten Zeilen nicht einzeln hergeben — Preisregeln,
 * Express-Zuschlag, Mindestauftragswert —, ergibt sich als Differenz zum
 * gespeicherten Nettobetrag und wird aus der Herleitung benannt, soweit sie
 * es kann. So ist `Rechnung.netTotal = Buchung.netTotal` eine Gleichung,
 * nicht eine Hoffnung; `mehrere-leistungen.test.ts` prüft sie.
 *
 * Die MwSt. rechnet die Rechnung wie jede Rechnung je Position
 * (`computeInvoiceTotals`). Gegenüber der auf dem Total gerundeten
 * Buchungs-MwSt. kann das je Position um einen Rappen abweichen — die
 * Rechnung folgt der MWSTG-Regel, die Buchung ist eine Schätzung.
 */
export function rechnungsgrundlageAusBuchung(
  booking: BuchungMitPositionen,
  jobId: string,
  termin: Date,
): { items: InvoiceItemInput[]; discountAmount: number } {
  const satz = toNumber(booking.vatRate);
  const datum = termin.toLocaleDateString('de-CH', { timeZone: 'Europe/Zurich' });
  const items: InvoiceItemInput[] = [];

  for (const position of [...booking.items].sort((a, b) => a.position - b.position)) {
    items.push({
      jobId,
      name: `${position.name} · ${datum}`,
      quantity: toNumber(position.quantity),
      unit: position.unit,
      unitPrice: toNumber(position.unitPrice),
      discount: 0,
      vatRate: toNumber(position.vatRate) || satz,
    });
  }
  for (const extra of booking.extras) {
    items.push({ jobId, name: extra.name, quantity: extra.quantity, unit: 'Stk.', unitPrice: toNumber(extra.unitPrice), discount: 0, vatRate: satz });
  }
  const anfahrt = toNumber(booking.travelFee);
  if (anfahrt > 0) {
    items.push({ jobId, name: 'Anfahrt', quantity: 1, unit: 'Pauschal', unitPrice: anfahrt, discount: 0, vatRate: satz });
  }

  const zeilenSumme = round2(items.reduce((s, i) => s + round2(i.quantity * i.unitPrice), 0));
  let discountAmount = round2(toNumber(booking.discountAmount));
  // Was zwischen Zeilen, Rabatt und gespeichertem Nettobetrag fehlt, sind
  // Zuschläge (positiv) oder zusätzliche Abzüge (negativ, etwa eine
  // Preisregel mit Minusbetrag).
  const rest = round2(toNumber(booking.netTotal) - zeilenSumme + discountAmount);
  if (rest > 0) {
    const herleitung = (booking.priceBreakdown ?? null) as { lines?: { label?: string; amount?: number; kind?: string }[] } | null;
    const zuschlaege = (herleitung?.lines ?? []).filter((l) => l.kind === 'surcharge' && typeof l.amount === 'number' && l.amount > 0 && l.label);
    const benannt = round2(zuschlaege.reduce((s, l) => s + (l.amount ?? 0), 0));
    if (zuschlaege.length > 0 && Math.abs(benannt - rest) < 0.005) {
      for (const z of zuschlaege) {
        items.push({ jobId, name: z.label!, quantity: 1, unit: 'Pauschal', unitPrice: round2(z.amount!), discount: 0, vatRate: satz });
      }
    } else {
      items.push({ jobId, name: `Zuschläge gemäss Buchung ${booking.number}`, quantity: 1, unit: 'Pauschal', unitPrice: rest, discount: 0, vatRate: satz });
    }
  } else if (rest < 0) {
    discountAmount = round2(discountAmount - rest);
  }

  return { items, discountAmount };
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
      booking: { include: { items: { include: { service: { select: { name: true } } } }, extras: true } },
    },
  });

  if (jobs.length === 0) throw new NotFoundError('Einsätze');

  const notCompleted = jobs.filter((j) => !['COMPLETED', 'VERIFIED'].includes(j.status));
  if (notCompleted.length > 0) {
    throw new BusinessRuleError(
      `Folgende Einsätze sind noch nicht abgeschlossen: ${notCompleted.map((j) => j.number).join(', ')}.`,
    );
  }

  // Schnelle, verständliche Antwort für den Normalfall. Entscheidend ist der
  // Anspruch in `createInvoice` — diese Vorprüfung schliesst keinen Wettlauf,
  // sie erspart nur die Arbeit. Vorher fragte sie jede Position mit diesem
  // Einsatz ab, auch auf **stornierten** Rechnungen: Ein Einsatz liess sich
  // nach einem Storno nie wieder verrechnen.
  if (jobs.some((job) => job.billedInvoiceId)) {
    throw new BusinessRuleError('Mindestens ein Einsatz wurde bereits verrechnet.');
  }

  const items: InvoiceItemInput[] = [];
  let discountAmount = 0;
  /** Eine Buchung wird einmal verrechnet, auch wenn mehrere ihrer Einsätze auf der Rechnung stehen. */
  const verrechneteBuchungen = new Set<string>();

  for (const job of jobs) {
    /**
     * Einsatz aus einer Buchung: Die Rechnung übernimmt die gespeicherte
     * Preisherleitung der Buchung — dieselbe, die die Kundschaft bestätigt
     * hat —, statt eine eigene Formel zu rechnen (Befund A1, 2026-09-26).
     *
     * Vorher entstand je Einsatz eine Zeile aus der *ersten* Buchungsposition:
     * Grundpauschale, Zusatzleistungen, Anfahrt, Zuschläge und Rabatte fielen
     * weg, und der Rechnungsbetrag wich vom gebuchten ab. Jetzt ergibt die
     * Rechnung denselben Nettobetrag wie die Buchung (`rechnungsgrundlageAusBuchung`).
     * Bei mehreren Einsätzen derselben Buchung (Nachbesserung) steht die
     * Buchung einmal auf der Rechnung, am ersten Einsatz.
     */
    if (job.booking) {
      if (!verrechneteBuchungen.has(job.booking.id)) {
        verrechneteBuchungen.add(job.booking.id);
        const grundlage = rechnungsgrundlageAusBuchung(job.booking, job.id, job.scheduledStart);
        items.push(...grundlage.items);
        discountAmount = round2(discountAmount + grundlage.discountAmount);
      }
    } else {
      // Einsatz ohne Buchung (von Hand angelegt): Sein Ertrag ist die einzige
      // Grundlage, verteilt auf die geleisteten oder geplanten Stunden.
      const minutes = job.timeEntries.reduce((sum, e) => sum + e.minutes, 0) || job.estimatedMin;
      const hours = round2(minutes / 60);
      items.push({
        jobId: job.id,
        name: `${job.service?.name ?? job.title} · ${job.scheduledStart.toLocaleDateString('de-CH', { timeZone: 'Europe/Zurich' })}`,
        description: job.completionNote ?? undefined,
        quantity: hours,
        unit: 'Std.',
        unitPrice: round2(toNumber(job.revenue) / Math.max(hours, 0.5)),
        discount: 0,
        vatRate: 8.1,
      });
    }

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
      ...(verrechneteBuchungen.size === 1 ? { bookingId: [...verrechneteBuchungen][0] } : {}),
      items,
      discountAmount,
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

  await emitAutomationTrigger({
    organizationId: params.organizationId,
    trigger: 'INVOICE_ISSUED',
    entityId: issued.id,
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

  /**
   * Für jeden Versand ein frischer, sicherer Link — dieselbe Regel wie bei
   * der Offerte, die hier bis Gate 2.5 fehlte: Verschickt wurde
   * `invoice.publicToken`, eine cuid im Klartext, ohne Ablauf und ohne
   * Widerruf.
   *
   * **Warum `INVOICE_PAY` und nicht `INVOICE_VIEW`.** Die Rechnungs-E-Mail
   * enthält eine Zahlschaltfläche; der Empfänger soll damit bezahlen können.
   * Über die Capability-Hierarchie deckt dieser eine Token Ansicht, PDF und
   * Zahlung ab — ein zweiter Link in derselben E-Mail wäre ein zweites
   * Geheimnis ohne zusätzlichen Nutzen.
   *
   * **Warum die alten zuerst widerrufen werden.** Eine zweite Zustellung
   * — korrigierter Betrag, neue Adresse — soll den ersten Link entwerten.
   * Sonst lägen zwei gültige Schlüssel zu demselben Vorgang in zwei
   * Postfächern.
   */
  await revokeTokensFor({
    purpose: 'INVOICE_PAY',
    resourceId: invoice.id,
    revokedById: params.actorId,
  });
  const link = await issuePublicToken({
    organizationId: params.organizationId,
    purpose: 'INVOICE_PAY',
    resourceId: invoice.id,
    createdById: params.actorId,
    // Eine Rechnung bleibt nach Fälligkeit zahlbar; Mahnungen laufen
    // weiter. Der Link muss deshalb länger gelten als die Frist selbst.
    expiresAt: new Date(invoice.dueDate.getTime() + 180 * 24 * 60 * 60 * 1000),
  });

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
      invoiceUrl: absoluteUrl(`/rechnung/${link.raw}`),
      payUrl: absoluteUrl(`/rechnung/${link.raw}/bezahlen`),
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

/** Rundungstoleranz: Ab höchstens 5 Rappen Rest gilt eine Rechnung als bezahlt. */
const BEZAHLT_TOLERANZ = new Prisma.Decimal('0.05');

/**
 * Bezahlter Betrag, offener Posten und Zahlstatus einer Rechnung — aus den
 * Belegen gebildet, nicht fortgeschrieben.
 *
 * **Warum eine Funktion für drei Wege.** Verbuchen, Stornieren und Gutschrift
 * rechneten den Saldo je selbst — und zwei davon falsch: Verbuchen und Storno
 * setzten `balance = grossTotal − bezahlt` und vergassen die Gutschriften, die
 * seit Wave 13 den Saldo senken. Auf einer Rechnung über 100 mit einer
 * Gutschrift von 30 liess die Zahlung der restlichen 70 einen Saldo von 30
 * stehen, die Rechnung blieb „teilweise bezahlt" und wäre gemahnt worden.
 * Gefunden bei der Integritätsprüfung (Wave 24,
 * `scripts/datenintegritaet.ts`), die genau diese Gleichung prüft.
 *
 * Verbuchen las ausserdem den bezahlten Betrag **vor** der Transaktion und
 * schrieb ihn als Summe zurück — zwei gleichzeitige Zahlungen hätten einander
 * überschrieben. Hier sperrt die Zeile, und die Summe kommt aus den
 * Zahlungen selbst.
 *
 * Der Status folgt dem Geld, nicht der Gutschrift: `PAID` nur, wenn Geld
 * geflossen ist und nichts mehr offen ist. Eine vollständig gutgeschriebene
 * Rechnung ist nicht bezahlt — ihr Saldo ist 0, der Status bleibt. Stornierte
 * und abgeschriebene Rechnungen behalten ihren Status und ihren Saldo 0.
 *
 * Muss in der Transaktion des auslösenden Belegs laufen.
 */
export async function saldoNeuBilden(tx: Prisma.TransactionClient, invoiceId: string): Promise<Invoice> {
  await tx.$queryRaw`SELECT "id" FROM "invoices" WHERE "id" = ${invoiceId} FOR UPDATE`;
  const rechnung = await tx.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    select: { grossTotal: true, status: true, sentAt: true, paidAt: true },
  });
  /*
    Eingegangenes Geld ist jede Zahlung, die einmal eingegangen ist — auch
    eine teilweise oder ganz erstattete —, abzüglich ihres **kumulierten**
    Erstattungsstands (2026-09-27). Vorher zählte hier nur `SUCCEEDED`: Eine
    Zahlung über 100 mit einer Teilerstattung über 10 (Status
    `PARTIALLY_REFUNDED`) fiel ganz heraus, und die nächste Büro-Zahlung
    oder Gutschrift schrieb den Saldo auf „alles offen" zurück — während der
    Stripe-Webhook daneben mit eigener Rechnung einen anderen Stand gesetzt
    hatte. Jetzt gibt es nur diese eine Rechnung, und der Webhook ruft sie auf.

    Dezimal statt Gleitkomma (`src/lib/money.ts`): Summen und Differenzen
    sind exakt, gerundet wird einmal, auf Rappen.
  */
  const [zahlungen, gutschriften] = await Promise.all([
    tx.payment.aggregate({
      where: { invoiceId, status: { in: EINGEGANGENE_ZAHLUNG } },
      _sum: { amount: true, refundedAmount: true },
    }),
    tx.creditNote.aggregate({ where: { invoiceId }, _sum: { grossTotal: true } }),
  ]);
  const bezahlt = aufRappen(geld(zahlungen._sum.amount).minus(geld(zahlungen._sum.refundedAmount)));
  const gutgeschrieben = aufRappen(gutschriften._sum.grossTotal);
  const offen = aufRappen(geld(rechnung.grossTotal).minus(bezahlt).minus(gutgeschrieben));

  if (rechnung.status === 'CANCELLED' || rechnung.status === 'WRITTEN_OFF') {
    return tx.invoice.update({ where: { id: invoiceId }, data: { paidAmount: bezahlt, balance: 0 } });
  }

  const voll = bezahlt.greaterThan(0) && offen.lessThanOrEqualTo(BEZAHLT_TOLERANZ);
  const status: Invoice['status'] = voll
    ? 'PAID'
    : bezahlt.greaterThan(0)
      ? 'PARTIALLY_PAID'
      : rechnung.status === 'PAID' || rechnung.status === 'PARTIALLY_PAID'
        ? // Nach einem Storno ohne verbleibende Zahlung: zurück auf den Stand
          // vor dem Geld. „Überfällig" setzt der Tageslauf wieder, wenn es zutrifft.
          rechnung.sentAt
          ? 'SENT'
          : 'ISSUED'
        : rechnung.status;

  return tx.invoice.update({
    where: { id: invoiceId },
    data: {
      paidAmount: bezahlt,
      balance: max0(offen),
      status,
      paidAt: voll ? (rechnung.paidAt ?? new Date()) : null,
    },
  });
}

/** Zahlungen, deren Geld einmal eingegangen ist — auch wenn es teilweise oder ganz zurückging. */
const EINGEGANGENE_ZAHLUNG: PaymentStatus[] = ['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'];

/**
 * Den Erstattungsstand einer Anbieterzahlung übernehmen — idempotent und
 * reihenfolgefest (2026-09-27).
 *
 * Der Anbieter meldet den **kumulierten** Stand (`amount_refunded`), nicht den
 * Zuwachs. Genau so wird er gespeichert: als Stand. Dreimal dasselbe
 * Ereignis ergibt dreimal denselben Stand; ein älteres Ereignis, das nach
 * einem neueren eintrifft, wird an `refundSyncedAt` erkannt und übergangen.
 * Der Saldo entsteht danach in `saldoNeuBilden` — derselben Rechnung wie für
 * Büro-Zahlungen und Gutschriften.
 *
 * Vorher zog der Webhook den kumulierten Betrag bei jedem Ereignis erneut ab
 * und rechnete den Saldo selbst: zwei Teilerstattungen über 10 und 20
 * senkten den bezahlten Betrag um 40, eine erneute Zustellung um weitere 30.
 *
 * Läuft in der Transaktion des Aufrufers (Webhook), damit Ereignisvermerk und
 * Wirkung zusammen bestehen oder zusammen zurückrollen.
 */
export async function erstattungsstandUebernehmen(
  tx: Prisma.TransactionClient,
  params: { providerPaymentId: string; kumuliert: Prisma.Decimal; stand: Date },
): Promise<'uebernommen' | 'veraltet' | 'unbekannt'> {
  const vorhanden = await tx.payment.findUnique({ where: { providerPaymentId: params.providerPaymentId }, select: { id: true } });
  if (!vorhanden) return 'unbekannt';
  // Zeile sperren: Zwei gleichzeitige Ereignisse derselben Zahlung dürfen
  // nicht beide den alten Stand lesen.
  await tx.$queryRaw`SELECT "id" FROM "payments" WHERE "id" = ${vorhanden.id} FOR UPDATE`;
  const zahlung = await tx.payment.findUniqueOrThrow({ where: { id: vorhanden.id } });
  if (zahlung.refundSyncedAt && zahlung.refundSyncedAt.getTime() > params.stand.getTime()) return 'veraltet';
  if (!EINGEGANGENE_ZAHLUNG.includes(zahlung.status)) return 'unbekannt';

  const betrag = geld(zahlung.amount);
  // Mehr als die Zahlung kann nicht erstattet sein; ein solcher Wert wäre ein
  // Anbieterfehler und wird auf den Zahlbetrag begrenzt.
  const kumuliert = aufRappen(Prisma.Decimal.min(max0(params.kumuliert), betrag));
  const zuwachs = kumuliert.minus(geld(zahlung.refundedAmount));

  await tx.payment.update({
    where: { id: zahlung.id },
    data: {
      refundedAmount: kumuliert,
      refundSyncedAt: params.stand,
      refundedAt: kumuliert.greaterThan(0) ? (zahlung.refundedAt ?? params.stand) : null,
      status: kumuliert.greaterThanOrEqualTo(betrag) ? 'REFUNDED' : kumuliert.greaterThan(0) ? 'PARTIALLY_REFUNDED' : 'SUCCEEDED',
    },
  });

  if (zahlung.invoiceId) await saldoNeuBilden(tx, zahlung.invoiceId);
  // Der Kundenwert wuchs mit der Zahlung; er sinkt um das, was zurückging.
  if (zahlung.customerId && !zuwachs.isZero()) {
    await tx.customer.update({ where: { id: zahlung.customerId }, data: { lifetimeValue: { decrement: zuwachs } } });
  }
  return 'uebernommen';
}

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

  /*
    Zwei gleichzeitige Zustellungen derselben Anbieterzahlung sehen oben beide
    „noch nicht gebucht". Die eindeutige `providerPaymentId` lässt dann genau
    eine Buchung zu; die zweite scheitert mit P2002 — und das ist kein Fehler,
    sondern die Antwort „schon gebucht". Vorher wurde daraus ein 500, und der
    Anbieter stellte weiter zu.
  */
  let updated: Invoice;
  try {
    updated = await zahlungBuchen();
  } catch (error) {
    if (params.providerPaymentId && error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const aktuell = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
      return { invoice: aktuell, fullyPaid: aktuell.status === 'PAID' };
    }
    throw error;
  }

  function zahlungBuchen() {
    return prisma.$transaction(async (tx) => {
    await tx.payment.create({
      data: {
        invoiceId: invoice!.id,
        customerId: invoice!.customerId,
        amount,
        currency: invoice!.currency,
        method: params.input.method as PaymentMethod,
        status: 'SUCCEEDED',
        reference: params.input.reference ?? null,
        note: params.input.note ?? null,
        provider: params.provider ?? 'manual',
        providerPaymentId: params.providerPaymentId ?? null,
        paidAt: params.input.paidAt ?? new Date(),
      },
    });

    const result = await saldoNeuBilden(tx, invoice!.id);

    // Kundenwert (Lifetime Value) fortschreiben.
    await tx.customer.update({
      where: { id: invoice!.customerId },
      data: { lifetimeValue: { increment: amount } },
    });

    return result;
    });
  }
  const fullyPaid = updated.status === 'PAID';

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
        amount: toNumber(updated.paidAmount),
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

    /**
     * Auch die Mahnung bekommt einen frischen Link statt der alten cuid.
     *
     * Hier wird bewusst **nicht** widerrufen: Die Rechnungs-E-Mail liegt noch
     * im Postfach, und wer daraus bezahlen will, soll das können. Eine
     * Mahnung fügt einen Weg hinzu, sie nimmt keinen weg.
     */
    const link = await issuePublicToken({
      organizationId,
      purpose: 'INVOICE_PAY',
      resourceId: invoice.id,
      expiresAt: new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000),
    });

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
        payUrl: absoluteUrl(`/rechnung/${link.raw}/bezahlen`),
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

  // Storno und Freigabe der Einsätze gemeinsam: Eine stornierte Rechnung
  // verrechnet nichts mehr, und die Einsätze lassen sich neu verrechnen.
  const updated = await prisma.$transaction(async (tx) => {
    const storniert = await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        balance: 0,
        notes: [invoice.notes, `Storniert: ${params.reason}`].filter(Boolean).join('\n'),
      },
    });
    await einsaetzeFreigeben(tx, invoice.id);
    return storniert;
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
  const grossTotal = round2(netTotal + vatAmount);
  if (grossTotal <= 0) throw new BusinessRuleError('Eine Gutschrift über null Franken ist keine.');

  /**
   * Bis 2026-09-23 prüfte diese Funktion nichts — und hatte keinen Aufrufer:
   * Der Storno verwies für teilweise bezahlte Rechnungen auf eine Gutschrift,
   * die sich nirgends erstellen liess. Jetzt, mit Route und Oberfläche:
   * Kundschaft der Organisation; eine Bezugsrechnung muss ausgestellt, nicht
   * storniert und von derselben Kundschaft sein; und über alle Gutschriften
   * hinweg wird nie mehr gutgeschrieben, als die Rechnung betrug.
   */
  const kunde = await prisma.customer.findFirst({
    where: { id: params.customerId, organizationId: params.organizationId },
    select: { id: true },
  });
  if (!kunde) throw new NotFoundError('Kundschaft');

  const note = await prisma.$transaction(async (tx) => {
    if (params.invoiceId) {
      // Zeilensperre: Zwei gleichzeitige Gutschriften dürfen zusammen die Rechnung nicht übersteigen.
      await tx.$queryRaw`SELECT "id" FROM "invoices" WHERE "id" = ${params.invoiceId} FOR UPDATE`;
      const rechnung = await tx.invoice.findFirst({
        where: { id: params.invoiceId, organizationId: params.organizationId, deletedAt: null },
        select: { id: true, number: true, status: true, customerId: true, grossTotal: true, balance: true },
      });
      if (!rechnung) throw new NotFoundError('Rechnung');
      if (rechnung.customerId !== params.customerId) {
        throw new BusinessRuleError('Die Gutschrift gehört zur Kundschaft der Rechnung.');
      }
      if (rechnung.status === 'DRAFT' || rechnung.status === 'CANCELLED') {
        throw new BusinessRuleError('Gutgeschrieben wird nur auf eine ausgestellte, nicht stornierte Rechnung.');
      }
      const bisher = await tx.creditNote.aggregate({ where: { invoiceId: rechnung.id }, _sum: { grossTotal: true } });
      const rest = round2(toNumber(rechnung.grossTotal) - toNumber(bisher._sum.grossTotal));
      if (grossTotal > rest + 0.004) {
        throw new BusinessRuleError(
          `Auf Rechnung ${rechnung.number} kann höchstens noch CHF ${rest.toFixed(2)} gutgeschrieben werden.`,
        );
      }
    }

    const { number } = await nextNumber(tx, params.organizationId, 'credit_note');

    const gutschrift = await tx.creditNote.create({
      data: {
        organizationId: params.organizationId,
        number,
        invoiceId: params.invoiceId ?? null,
        customerId: params.customerId,
        reason: params.reason,
        issueDate: params.issueDate ?? new Date(),
        netTotal,
        vatAmount,
        grossTotal,
        items: params.items as unknown as Prisma.InputJsonValue,
      },
    });

    // Der offene Posten sinkt um die Gutschrift — sonst mahnte der Betrieb
    // einen Betrag, den er selbst gutgeschrieben hat. Gebildet wie bei jeder
    // Zahlung, damit alle drei Wege dieselbe Gleichung benutzen.
    if (params.invoiceId) await saldoNeuBilden(tx, params.invoiceId);
    return gutschrift;
  });

  // Das PDF gleich erzeugen — ein Beleg ohne Dokument ist keiner, den man versenden kann.
  await renderCreditNotePdf(note.id).catch((error) => log.error('Gutschrift-PDF fehlgeschlagen', { error }));

  await audit.created({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'CreditNote',
    entityId: note.id,
    summary: `Gutschrift ${note.number} über CHF ${toNumber(note.grossTotal).toFixed(2)}`,
  });

  return note;
}

export async function listCreditNotes(params: { organizationId: string; customerId?: string; invoiceId?: string }) {
  return prisma.creditNote.findMany({
    where: {
      organizationId: params.organizationId,
      ...(params.customerId ? { customerId: params.customerId } : {}),
      ...(params.invoiceId ? { invoiceId: params.invoiceId } : {}),
    },
    orderBy: { issueDate: 'desc' },
    take: 500,
    include: {
      customer: { select: { id: true, number: true, companyName: true, firstName: true, lastName: true } },
      invoice: { select: { id: true, number: true } },
    },
  });
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
  contractId?: string;
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
    ...(filter.contractId ? { contractId: filter.contractId } : {}),
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

/**
 * Öffentlicher Zugriff auf eine Rechnung über den Link aus der E-Mail.
 *
 * Verlangt `INVOICE_VIEW`; ein `INVOICE_PAY` erfüllt das über die
 * Capability-Hierarchie mit. Der umgekehrte Weg gilt nicht — die Zahlroute
 * prüft eigens auf `INVOICE_PAY`.
 *
 * Hier stand bis Gate 2.5 `findUnique({ where: { publicToken } })`: die
 * cuid-Spalte als Sicherheitsmerkmal. Für das reine Ansehen bleibt der
 * Rückfall auf alte Links möglich, solange `LEGACY_PUBLIC_TOKENS`
 * ausdrücklich eingeschaltet ist.
 */
export async function getInvoiceByToken(token: string) {
  const aufgeloest = await resolveWithLegacy({
    raw: token,
    purpose: 'INVOICE_VIEW',
    legacyLookup: async (raw) =>
      prisma.invoice.findUnique({
        where: { publicToken: raw },
        select: { id: true, organizationId: true },
      }),
  });
  if (!aufgeloest.ok) throw tokenRejectionError(aufgeloest.reason, 'Rechnung');

  const invoice = await prisma.invoice.findFirst({
    where: { id: aufgeloest.resourceId, organizationId: aufgeloest.organizationId },
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
