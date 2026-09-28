import 'server-only';

import { randomBytes } from 'node:crypto';

import { Prisma, type Invoice, type PaymentMethod, type PaymentStatus } from '@prisma/client';

import { prisma, toNumber } from '@/lib/db';
import { aufRappen, einsatzertragAlsPauschale, geld, max0 } from '@/lib/money';
import { tagPlus, zuercherTag, zuercherTagesbeginn } from '@/lib/zuerich';
import { gutschriftsSummen, rechnungsSummen } from '@/lib/rechnungsbetraege';
import { BusinessRuleError, ConflictError, NotFoundError } from '@/lib/errors';
import { absoluteUrl, formatDate, round2 } from '@/lib/utils';
import { orderByFor, resolveSort, type SortOrder } from '@/lib/sort';
import { audit, recordAuditInTx } from '@/lib/audit';
import { automationEreignisseAbarbeiten, automationEreignisVormerken } from './automation-engine.service';
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
import { notify, notifyStaff } from './notification.service';
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

/**
 * Summen einer Rechnung — dezimal gerechnet in `lib/rechnungsbetraege.ts`
 * (2026-09-27). Vorher stand die Rechnung hier in JavaScript-`number`; die
 * Regeln sind unverändert, die Arithmetik nicht mehr binär.
 */
export function computeInvoiceTotals(
  items: InvoiceItemInput[],
  discountAmount = 0,
): ComputedInvoiceTotals {
  return rechnungsSummen(items, discountAmount);
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

  /**
   * Buchung und Offerte gehören **dieser Kundschaft** (2026-09-28).
   *
   * Vorher wurden `bookingId` und `quoteId` ungeprüft übernommen. Eine
   * Rechnung an Kundschaft B mit der Buchung von A hing danach an As Buchung
   * — und das Kundenkonto von A zeigte in der Buchungsansicht Nummer, Betrag
   * und Saldo einer Rechnung an B. Über die Organisation hinaus hielt nur der
   * Fremdschlüssel. Jetzt ist ein fremder Bezug ein 404 wie jeder andere
   * nicht gefundene Datensatz: Ob es ihn bei einer anderen Kundschaft gibt,
   * soll die Antwort nicht verraten.
   */
  if (params.input.bookingId) {
    const buchung = await prisma.booking.findFirst({
      where: { id: params.input.bookingId, organizationId: params.organizationId, customerId: customer.id, deletedAt: null },
      select: { id: true },
    });
    if (!buchung) throw new NotFoundError('Buchung');
  }
  if (params.input.quoteId) {
    const offerte = await prisma.quote.findFirst({
      where: { id: params.input.quoteId, organizationId: params.organizationId, customerId: customer.id, deletedAt: null },
      select: { id: true },
    });
    if (!offerte) throw new NotFoundError('Offerte');
  }

  const totals = computeInvoiceTotals(params.input.items, params.input.discountAmount);

  // Kalendertage in Zürich (2026-09-27). `new Date()` landete in der
  // `@db.Date`-Spalte als UTC-Tag — zwischen Mitternacht und 01:00/02:00 als
  // gestern, und die Frist zählte von dort.
  const issueDate = params.input.issueDate ?? zuercherTag();
  const dueDate = params.input.dueDate ?? tagPlus(issueDate, customer.paymentTermDays);

  const billing = customer.addresses[0];

  const invoice = await prisma.$transaction(async (tx) => {
    // Entwürfe erhalten eine Platzhalternummer, damit die Sequenz nicht
    // durch verworfene Entwürfe Lücken bekommt. Mit Zufallsteil (2026-09-28):
    // Nur aus der Millisekunde gebildet, kollidierten zwei gleichzeitig
    // angelegte Entwürfe am eindeutigen Index (Organisation, Nummer) — ein 500
    // statt eines zweiten Entwurfs.
    let number = `ENTWURF-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`;
    let qrReference: string | null = null;

    if (params.input.issueImmediately) {
      const seq = await nextNumber(tx, params.organizationId, 'invoice', issueDate);
      number = seq.number;
      qrReference = buildQrReference({ invoiceSequence: seq.sequence, year: seq.year });
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
    /*
      Parität mit `issueInvoice` (2026-09-27): Eine direkt ausgestellte
      Rechnung ist ebenso ausgestellt. Bis dahin meldete nur `issueInvoice`
      den Auslöser und erzeugte das PDF — die Sammelrechnung aus Einsätzen und
      die Rechnung aus einer Offerte (beide direkt ausgestellt) lösten keine
      Regel „Rechnung ausgestellt" aus und hatten kein PDF.
    */
    if (params.input.issueImmediately) {
      await automationEreignisVormerken(tx, { organizationId: params.organizationId, trigger: 'INVOICE_ISSUED', entityId: angelegt.id });
    }
    /*
      Protokoll in der Transaktion (2026-09-27, F-14). Eine direkt
      ausgestellte Rechnung zieht hier ihre Nummer aus der lückenlosen Folge
      nach Art. 957a OR — eine Nummer ohne Protokollzeile wäre ein Beleg, von
      dem niemand weiss, wer ihn ausgestellt hat. Vorher lief `audit.created`
      nach dem Commit und verschluckte jeden Fehler. Jetzt stehen Rechnung und
      Zeile gemeinsam oder gar nicht; scheitert das Protokoll, rollt auch die
      Nummer zurück, und die Folge bleibt lückenlos.
    */
    await recordAuditInTx(tx, {
      organizationId: params.organizationId,
      userId: params.actorId,
      action: 'CREATE',
      entity: 'Invoice',
      entityId: angelegt.id,
      summary: `Rechnung ${angelegt.number} ${params.input.issueImmediately ? 'erstellt und ausgestellt' : 'erstellt'} (${toNumber(angelegt.grossTotal).toFixed(2)} CHF)`,
    });
    return angelegt;
  });

  if (params.input.issueImmediately) {
    await renderInvoicePdf(invoice.id).catch((error) => log.error('PDF-Erzeugung fehlgeschlagen', { error }));
  }

  if (params.input.issueImmediately) await automationEreignisseAbarbeiten({ organizationId: params.organizationId });

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
      /*
        Einsatz ohne Buchung (von Hand angelegt): Sein Ertrag ist die einzige
        Grundlage — und genau der wird verrechnet (2026-09-27, N-03).

        Vorher: Menge = Stunden, Einzelpreis = Ertrag / max(Stunden, 0.5). Die
        Untergrenze sollte eine Division durch fast null verhindern, verrechnete
        aber unter 30 Minuten nur einen Bruchteil: 20 Minuten mit Ertrag 100
        ergaben 0.33 × 200 = 66. Darüber rechneten gerundeter Stundensatz mal
        gerundete Stunden am Ertrag vorbei. Eine Mindestverrechnung gibt es in
        keiner Regel dieses Betriebs; der vereinbarte Ertrag ist der Preis.
        Deshalb eine Pauschale über den Ertrag, die Dauer steht im Text
        (`einsatzertragAlsPauschale` in `lib/money.ts`).
      */
      const minutes = job.timeEntries.reduce((sum, e) => sum + e.minutes, 0) || job.estimatedMin;
      const zeile = einsatzertragAlsPauschale(job.revenue, minutes);
      items.push({
        jobId: job.id,
        name: `${job.service?.name ?? job.title} · ${job.scheduledStart.toLocaleDateString('de-CH', { timeZone: 'Europe/Zurich' })} · ${zeile.stunden.toFixed(2)} Std.`,
        description: job.completionNote ?? undefined,
        quantity: zeile.quantity,
        unit: zeile.unit,
        unitPrice: zeile.unitPrice,
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
    /*
      Zeile sperren und den Stand **in** der Transaktion erneut prüfen
      (2026-09-27). Vorher prüfte nur die Abfrage oben „noch Entwurf?", und
      das Schreiben war unbedingt: Zwei gleichzeitige „Ausstellen" zogen je
      eine Nummer, die zweite überschrieb die erste — eine Lücke in der nach
      Art. 957a OR lückenlosen Folge. Jetzt wartet der zweite Aufruf, sieht
      ISSUED und scheitert, bevor er eine Nummer zieht.
    */
    await tx.$queryRaw`SELECT "id" FROM "invoices" WHERE "id" = ${invoice.id} FOR UPDATE`;
    const stand = await tx.invoice.findUniqueOrThrow({ where: { id: invoice.id }, select: { status: true, issueDate: true, dueDate: true, deletedAt: true } });
    if (stand.status !== 'DRAFT') throw new BusinessRuleError('Diese Rechnung wurde bereits ausgestellt.');
    // Auch „gelöscht?" unter der Sperre (2026-09-28): Lief das Löschen des
    // Entwurfs zwischen der Abfrage oben und dieser Sperre, bekam ein bereits
    // gelöschter Entwurf eine Nummer — eine ausgestellte Rechnung, die in
    // keiner Liste erscheint, und damit eine Lücke nach Art. 957a OR.
    if (stand.deletedAt) throw new NotFoundError('Rechnung');

    /**
     * Das Rechnungsdatum ist der Tag der Ausstellung (2026-09-27).
     *
     * Der Entwurf behielt vorher das Datum, an dem er angelegt wurde: Wer am
     * 3. einen Entwurf anlegte und ihn am 28. ausstellte, verschickte eine
     * Rechnung vom 3., die beim Eintreffen schon fällig war — und deren Nummer
     * aus dem Kreis jenes Datums kam, im Januar also aus dem alten Jahr.
     * Zurückdatieren ist keine Funktion; vordatieren bleibt möglich (ein
     * späteres Entwurfsdatum wird übernommen). Die Frist wandert mit: so
     * viele Tage wie im Entwurf zwischen Datum und Fälligkeit lagen.
     */
    const heute = zuercherTag();
    const rechnungsdatum = stand.issueDate < heute ? heute : stand.issueDate;
    const frist = Math.round((stand.dueDate.getTime() - stand.issueDate.getTime()) / 86_400_000);
    const seq = await nextNumber(tx, params.organizationId, 'invoice', zuercherTagesbeginn(rechnungsdatum));
    const ausgestellt = await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        number: seq.number,
        status: 'ISSUED',
        issueDate: rechnungsdatum,
        dueDate: tagPlus(rechnungsdatum, Math.max(0, frist)),
        qrReference: buildQrReference({ invoiceSequence: seq.sequence, year: seq.year }),
      },
    });
    await automationEreignisVormerken(tx, { organizationId: params.organizationId, trigger: 'INVOICE_ISSUED', entityId: invoice.id });
    // In derselben Transaktion wie die Nummer (F-14, 2026-09-27) — Begründung
    // bei `createInvoice`: keine ausgestellte Nummer ohne Protokollzeile, und
    // kein Protokoll für eine Ausstellung, die zurückgerollt ist.
    await recordAuditInTx(tx, {
      organizationId: params.organizationId,
      userId: params.actorId,
      action: 'UPDATE',
      entity: 'Invoice',
      entityId: ausgestellt.id,
      summary: `Rechnung ${ausgestellt.number} ausgestellt`,
    });
    return ausgestellt;
  });

  await renderInvoicePdf(issued.id).catch((error) =>
    log.error('PDF-Erzeugung fehlgeschlagen', { error }),
  );

  await automationEreignisseAbarbeiten({ organizationId: params.organizationId });

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
 * Eine von Hand erfasste Zahlung stornieren — vorher im Endpunkt
 * `DELETE /api/payments/:id` geschrieben (bis 2026-09-27).
 *
 * Der Übergang ist **bedingt** (`status: SUCCEEDED` bzw. nicht `CANCELLED`
 * im `where` des `updateMany`): Zwei gleichzeitige Stornos derselben Zahlung
 * lasen vorher beide „gültig" ausserhalb jeder Sperre und senkten den
 * Kundenwert zweimal (Befund N-05, Rest). Jetzt gewinnt genau einer; der
 * zweite findet nichts mehr umzustellen und bekommt die Meldung „bereits
 * storniert". Protokollzeile in derselben Transaktion (F-14).
 *
 * Zahlungen eines Anbieters werden hier nie storniert — sie sind dort eine
 * Tatsache; die Erstattung läuft über den Anbieter.
 */
export async function zahlungStornieren(params: {
  organizationId: string;
  paymentId: string;
  actorId: string;
  ip?: string | null;
}): Promise<void> {
  const payment = await prisma.payment.findFirst({
    where: {
      id: params.paymentId,
      OR: [{ invoice: { organizationId: params.organizationId } }, { customer: { organizationId: params.organizationId } }],
    },
    include: { invoice: { select: { id: true, number: true, customerId: true } } },
  });
  if (!payment) throw new NotFoundError('Zahlung');
  if (payment.provider && payment.provider !== 'manual') {
    throw new BusinessRuleError(
      `Diese Zahlung stammt von ${payment.provider} und ist dort eine Tatsache. ` +
        'Eine Erstattung läuft über den Zahlungsanbieter, nicht über das Löschen der Zeile.',
    );
  }
  const amount = toNumber(payment.amount);

  await prisma.$transaction(async (tx) => {
    const umgestellt = await tx.payment.updateMany({
      where: { id: payment.id, status: { not: 'CANCELLED' } },
      data: {
        status: 'CANCELLED',
        note: [payment.note, `Storniert am ${zuercherTag().toISOString().slice(0, 10)}`].filter(Boolean).join('\n'),
      },
    });
    if (umgestellt.count === 0) throw new BusinessRuleError('Diese Zahlung ist bereits storniert.');

    // Der Kundenwert wurde beim Verbuchen erhöht; nur eine *gebuchte*
    // Zahlung nimmt ihn zurück — dieselbe Akte wie beim Erhöhen.
    if (payment.status === 'SUCCEEDED') {
      const kunde = payment.invoice?.customerId ?? payment.customerId;
      if (kunde) await tx.customer.update({ where: { id: kunde }, data: { lifetimeValue: { decrement: amount } } });
      if (payment.invoiceId) await saldoNeuBilden(tx, payment.invoiceId);
    }

    await recordAuditInTx(tx, {
      organizationId: params.organizationId,
      userId: params.actorId,
      action: 'DELETE',
      entity: 'Payment',
      entityId: payment.id,
      summary: payment.invoice
        ? `Zahlung über ${amount} CHF zu Rechnung ${payment.invoice.number} storniert`
        : `Zahlung über ${amount} CHF storniert`,
      ip: params.ip ?? undefined,
    });
  });
}

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
 *
 * **Zweite Quelle: die gescheiterte Rückerstattung** (`ausfall`, 2026-09-27,
 * Rest von F-04). Scheitert eine Rückerstattung bei Stripe nachträglich
 * (`failed`) oder wird sie abgebrochen (`canceled`), sinkt der kumulierte
 * Stand der Zahlung wieder — aber das Ereignis dazu (`refund.updated`,
 * `refund.failed`, `charge.refund.updated`) trägt nur die *eine*
 * Rückerstattung, nicht den Stand der Zahlung. Bis hierher wurde es gar nicht
 * behandelt: Der Saldo blieb gesenkt, obwohl das Geld nie zurückging, und
 * die Rechnung wäre als offen gemahnt worden.
 *
 * Der neue Stand wird deshalb **hinter derselben Zeilensperre** aus dem
 * gespeicherten gebildet — nicht beim Aufrufer, der ihn ausserhalb der Sperre
 * läse: Zwei gleichzeitig gescheiterte Rückerstattungen derselben Zahlung
 * läsen sonst beide den alten Stand, und die zweite überschriebe die erste.
 * Und er wird nur dann gesenkt, wenn die Rückerstattung überhaupt schon
 * mitgezählt ist — siehe unten.
 */
export async function erstattungsstandUebernehmen(
  tx: Prisma.TransactionClient,
  params: { providerPaymentId: string; stand: Date } & (
    | { kumuliert: Prisma.Decimal }
    | { ausfall: { betrag: Prisma.Decimal; erstelltAm: Date } }
  ),
): Promise<'uebernommen' | 'veraltet' | 'unbekannt' | 'ausstehend'> {
  const vorhanden = await tx.payment.findUnique({ where: { providerPaymentId: params.providerPaymentId }, select: { id: true } });
  /*
    Noch keine Zahlung zu dieser Kennung: `'ausstehend'`, nicht `'unbekannt'`
    (2026-09-27, F-04). Stripe stellt `charge.refunded` und
    `checkout.session.completed` in beliebiger Reihenfolge zu; die Zahlung
    kann schlicht noch unterwegs sein. `ereignisVerbuchen` weist das Ereignis
    daraufhin zurück, statt es als verarbeitet zu vermerken — mit
    `'unbekannt'` war die Rückerstattung verloren, sobald die Zahlung eintraf.
  */
  if (!vorhanden) return 'ausstehend';
  // Zeile sperren: Zwei gleichzeitige Ereignisse derselben Zahlung dürfen
  // nicht beide den alten Stand lesen.
  await tx.$queryRaw`SELECT "id" FROM "payments" WHERE "id" = ${vorhanden.id} FOR UPDATE`;
  const zahlung = await tx.payment.findUniqueOrThrow({ where: { id: vorhanden.id } });
  if (zahlung.refundSyncedAt && zahlung.refundSyncedAt.getTime() > params.stand.getTime()) return 'veraltet';
  if (!EINGEGANGENE_ZAHLUNG.includes(zahlung.status)) return 'unbekannt';

  const betrag = geld(zahlung.amount);
  /*
    Bei einem Ausfall: Ist die gescheiterte Rückerstattung im gespeicherten
    Stand schon enthalten? Stripe zählt eine Rückerstattung ab ihrer
    Erstellung zu `amount_refunded` (auch solange sie `pending` ist), und
    `charge.refunded` entsteht frühestens in dieser Sekunde. Wurde also schon
    ein Stand übernommen, der nicht älter ist als die Rückerstattung
    (`refundSyncedAt ≥ erstelltAm`), ist sie darin enthalten und wird
    abgezogen. Ist der übernommene Stand älter, kam das Ausfallereignis vor
    dem `charge.refunded` dieser Rückerstattung an (Stripe garantiert keine
    Reihenfolge): Dann ist nichts abzuziehen — der Stand bleibt, rückt aber
    auf den Zeitpunkt des Ausfalls vor, und das verspätete `charge.refunded`,
    das die gescheiterte Rückerstattung noch mitzählt, gilt oben als
    veraltet. Einfach abzuziehen, wie es naheläge, hätte in diesem Fall eine
    *andere*, gültige Rückerstattung mit ausgebucht.

    Die Grenze: Zwei Rückerstattungen derselben Zahlung in derselben Sekunde,
    von denen nur die erste schon übernommen ist, lassen sich an Sekunden
    nicht unterscheiden; die zweite gälte als enthalten. Das lässt sich nur
    mit Stripes eigenem Stand der Zahlung (API-Abfrage) auflösen.
  */
  const roh =
    'ausfall' in params
      ? zahlung.refundSyncedAt && zahlung.refundSyncedAt.getTime() >= params.ausfall.erstelltAm.getTime()
        ? geld(zahlung.refundedAmount).minus(params.ausfall.betrag)
        : geld(zahlung.refundedAmount)
      : params.kumuliert;
  // Mehr als die Zahlung kann nicht erstattet sein; ein solcher Wert wäre ein
  // Anbieterfehler und wird auf den Zahlbetrag begrenzt.
  const kumuliert = aufRappen(Prisma.Decimal.min(max0(roh), betrag));
  /*
    Gleiche Sekunde, kleinerer Stand: veraltet (2026-09-27). `event.created`
    hat nur Sekundenauflösung; zwei Teilerstattungen in derselben Sekunde
    lassen sich am Zeitpunkt nicht ordnen, und der strikte Vergleich oben
    liess das ältere, später zugestellte Ereignis den Stand zurückdrehen. Der
    kumulierte Stand wächst innerhalb einer Sekunde nur — der grössere ist
    der neuere.

    **Nicht für den Ausfall:** Er senkt den Stand ausdrücklich. Scheitert
    eine Rückerstattung in derselben Sekunde, in der ihr `charge.refunded`
    übernommen wurde, wäre der kleinere Stand sonst als „veraltet" verworfen
    — und der Ausfall ginge verloren, weil sein Vermerk trotzdem stünde.
  */
  if (
    !('ausfall' in params) &&
    zahlung.refundSyncedAt &&
    zahlung.refundSyncedAt.getTime() === params.stand.getTime() &&
    kumuliert.lessThan(geld(zahlung.refundedAmount))
  ) {
    return 'veraltet';
  }
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

/**
 * Eine Anbieterzahlung passt nicht zu ihrer Rechnung und wird nicht gebucht
 * (2026-09-27). Eigene Klasse, damit der Webhook genau diesen Fall erkennt —
 * als dauerhaften Zustand, der vermerkt und gemeldet, aber nicht von Stripe
 * wiederholt werden soll — und nicht jede andere Geschäftsregel mit ihm.
 */
export class ZahlungsbezugError extends BusinessRuleError {
  constructor(message: string) {
    super(message);
    this.name = 'ZahlungsbezugError';
  }
}

export async function recordPayment(params: {
  organizationId: string;
  invoiceId: string;
  input: RecordPaymentInput;
  actorId?: string | null;
  provider?: string;
  providerPaymentId?: string;
  /**
   * Die Währung, in der der Anbieter das Geld tatsächlich eingezogen hat
   * (Stripe: `session.currency`). Fehlt sie, lässt sich nichts vergleichen —
   * echte Stripe-Ereignisse tragen sie immer.
   */
  providerCurrency?: string | null;
}): Promise<{ invoice: Invoice; fullyPaid: boolean }> {
  const invoice = await prisma.invoice.findFirst({
    where: { id: params.invoiceId, organizationId: params.organizationId, deletedAt: null },
    include: { customer: { include: { user: { select: { id: true } } } } },
  });
  if (!invoice) throw new NotFoundError('Rechnung');

  /*
    Anbietergeld in einer **anderen Währung** als die Rechnung (2026-09-27,
    Testmatrix `zahlung.falscherBezug`): nicht buchen.

    Bis dahin übernahm der Webhook `amount_total` ungesehen als Betrag der
    Rechnungswährung — EUR 108.10 standen als CHF 108.10 im Zahlungsbuch, der
    Saldo war null, die Rechnung „bezahlt", und niemand erfuhr, dass Stripe
    etwas ganz anderes eingezogen hatte. Umrechnen können wir nicht: Den Kurs
    und die Gebühren kennt allein der Anbieter, und eine selbst gewählte
    Umrechnung wäre eine erfundene Zahl in einem Buch, das nach Art. 957a OR
    stimmen muss.

    Anders als bei der stornierten Rechnung (unten) wird hier *nicht* gebucht:
    Dort stimmt die Zahl und nur der Zweck ist weggefallen; hier stimmt die
    Zahl selbst nicht. Der Webhook vermerkt das Ereignis, meldet es dem Büro
    und antwortet 200 — der Zustand ist dauerhaft, eine Wiederholung durch
    Stripe änderte nichts (Regel 6 im Webhook). Die Rückzahlung läuft von
    Hand über den Anbieter.
  */
  if (params.provider && params.providerCurrency && params.providerCurrency.toUpperCase() !== invoice.currency.toUpperCase()) {
    throw new ZahlungsbezugError(
      `Die Zahlung lautet auf ${params.providerCurrency.toUpperCase()}, die Rechnung ${invoice.number} auf ${invoice.currency}.`,
    );
  }
  // Schnelle Antwort für das Büro. Entscheidend ist die Prüfung hinter der
  // Zeilensperre in `zahlungBuchen` — diese hier schliesst keinen Wettlauf.
  if (!params.provider && invoice.status === 'CANCELLED') {
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
  let aufStornierteRechnung = false;
  let abweichendVon: number | null = null;
  try {
    ({ rechnung: updated, storniert: aufStornierteRechnung, abweichendVon } = await zahlungBuchen());
  } catch (error) {
    if (params.providerPaymentId && error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const aktuell = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
      return { invoice: aktuell, fullyPaid: aktuell.status === 'PAID' };
    }
    throw error;
  }

  function zahlungBuchen(): Promise<{ rechnung: Invoice; storniert: boolean; abweichendVon: number | null }> {
    return prisma.$transaction(async (tx) => {
    /*
      Zeilensperre für **jede** Zahlung, dann den Stand in der Transaktion
      lesen (2026-09-27, N-05). Vorher prüfte nur die Abfrage oben
      „storniert?", ausserhalb jeder Sperre: Ein gleichzeitiger Storno las
      „nichts bezahlt", die Zahlung las „nicht storniert", und beide
      schrieben — eine stornierte Rechnung mit Geld darauf, von der niemand
      wusste. `cancelInvoice` sperrt dieselbe Zeile; einer von beiden wartet
      und sieht danach den Stand des anderen.
    */
    await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${invoice!.id} FOR UPDATE`;
    const stand = await tx.invoice.findUniqueOrThrow({ where: { id: invoice!.id }, select: { balance: true, status: true } });
    const storniert = stand.status === 'CANCELLED';

    /*
      Eine von Hand erfasste Zahlung höchstens bis zum offenen Saldo
      (2026-09-27), geprüft hinter der Zeilensperre, damit zwei gleichzeitige
      Erfassungen nicht beide „passt noch" lesen. Vorher nahm die Erfassung
      jeden positiven Betrag an — ein Tippfehler (1800 statt 180) ergab einen
      negativen Saldo und einen um 1620 zu hohen Kundenwert. Ein Betrag, der
      nach Rundung auf Rappen null ist, ist keine Zahlung. Und auf eine
      stornierte Rechnung bucht das Büro nichts.

      **Nicht** für Zahlungen eines Anbieters (`provider`): Deren Geld ist
      schon eingegangen, und eine Überzahlung muss gebucht werden, um sie
      zurückzuzahlen — sie abzuweisen hiesse, eingegangenes Geld zu
      verschweigen.
    */
    if (!params.provider) {
      if (storniert) throw new BusinessRuleError('Für eine stornierte Rechnung können keine Zahlungen erfasst werden.');
      if (amount <= 0) throw new BusinessRuleError('Der Betrag muss mindestens einen Rappen betragen.');
      if (amount > toNumber(stand.balance)) {
        throw new BusinessRuleError(
          `Der Betrag übersteigt den offenen Saldo von CHF ${toNumber(stand.balance).toFixed(2)}. Eine Überzahlung bitte als Gutschrift oder Rückzahlung behandeln.`,
        );
      }
    }

    /*
      Geld eines Anbieters auf eine **stornierte** Rechnung (N-05,
      2026-09-27): buchen und zur Rückzahlung melden, nicht abweisen.

      Vorher warf diese Funktion auch hier `BusinessRuleError`. Der Webhook
      antwortete 422, Stripe wertete das als Fehlschlag und stellte drei Tage
      lang erneut zu — jedes Mal mit demselben Ergebnis. Das Geld der
      Kundschaft lag danach bei Stripe, und in der Buchhaltung stand nichts
      davon. Genau der Fall entsteht regelmässig: Die Kundschaft öffnet den
      Zahlungslink, das Büro storniert die Rechnung, die Kundschaft bezahlt.

      Gebucht wird die Zahlung an der stornierten Rechnung, wie jede andere
      eingegangene Zahlung. `saldoNeuBilden` hält den Saldo einer stornierten
      Rechnung bei 0 und weist den eingegangenen Betrag als `paidAmount` aus
      — eine stornierte Rechnung mit bezahltem Betrag ist genau das Merkmal
      „Geld zurückzahlen". Die Zahlungsnotiz sagt es ausdrücklich, das Büro
      wird benachrichtigt (unten, nach dem Commit), und die Rückzahlung läuft
      über den Anbieter; ihr `charge.refunded` senkt den Betrag wieder.
      Verworfen: die Zahlung ohne Rechnung als Guthaben der Kundschaft zu
      führen — das Modell kennt kein Guthabenkonto, und eine Zahlung ohne
      Rechnung verschwände aus jeder Sicht, in der das Büro danach sucht.
    */
    /*
      Anbietergeld mit **abweichendem Betrag** (2026-09-27, Testmatrix
      `zahlung.falscherBezug`): buchen, was eingegangen ist — und es sagen.

      Die Checkout-Session entsteht über genau den offenen Saldo. Weicht der
      eingezogene Betrag davon ab, hat sich der Saldo seither bewegt (eine
      Büro-Zahlung, eine Gutschrift) oder die Session gehört nicht zu diesem
      Stand. Abweisen hiesse eingegangenes Geld verschweigen — dieselbe
      Begründung wie bei der Überzahlung oben. Bis dahin geschah die Buchung
      aber *stillschweigend*: Eine Überzahlung stand als negativer Saldo an der
      Rechnung, und niemand wurde aufgefordert, sie zurückzuzahlen. Jetzt trägt
      die Zahlung den Hinweis, das Protokoll den Vermerk, und das Büro bekommt
      eine Meldung (nach dem Commit, wie beim Storno). Die stornierte Rechnung
      hat ihren eigenen, schärferen Hinweis; dort ist jeder Betrag „zu viel".
    */
    const offen = toNumber(stand.balance);
    const betragWeichtAb = Boolean(params.provider) && !storniert && Math.abs(amount - offen) >= 0.005;
    const hinweis = storniert
      ? 'Eingang auf stornierte Rechnung — Rückzahlung über den Zahlungsanbieter veranlassen.'
      : betragWeichtAb
        ? `Betrag weicht vom offenen Saldo ab (offen CHF ${offen.toFixed(2)}, eingegangen CHF ${amount.toFixed(2)}) — bitte prüfen.`
        : null;

    await tx.payment.create({
      data: {
        invoiceId: invoice!.id,
        customerId: invoice!.customerId,
        amount,
        currency: invoice!.currency,
        method: params.input.method as PaymentMethod,
        status: 'SUCCEEDED',
        reference: params.input.reference ?? null,
        note: [params.input.note, hinweis].filter(Boolean).join('\n') || null,
        provider: params.provider ?? 'manual',
        providerPaymentId: params.providerPaymentId ?? null,
        paidAt: params.input.paidAt ?? new Date(),
      },
    });

    const result = await saldoNeuBilden(tx, invoice!.id);

    // Kundenwert (Lifetime Value) fortschreiben. Auch bei der stornierten
    // Rechnung: Die Rückerstattung senkt ihn später um denselben Betrag
    // (`erstattungsstandUebernehmen`) — beide Seiten bleiben symmetrisch.
    await tx.customer.update({
      where: { id: invoice!.customerId },
      data: { lifetimeValue: { increment: amount } },
    });

    /*
      Protokoll in der Transaktion (F-14, 2026-09-27). Eine eingegangene
      Zahlung ohne Protokollzeile ist genau der Fall, nach dem eine
      Revision fragt; `audit.payment` lief nach dem Commit und verschluckte
      jeden Fehler. Jetzt gilt: keine Zahlung ohne Zeile. Scheitert das
      Protokoll bei einer Anbieterzahlung, antwortet der Webhook 500 und
      Stripe stellt erneut zu — die Zahlung geht nicht verloren, sie wird
      mit ihrer Zeile gebucht, sobald das Protokoll wieder schreibt.
    */
    await recordAuditInTx(tx, {
      organizationId: params.organizationId,
      userId: params.actorId ?? null,
      action: 'PAYMENT',
      entity: 'Invoice',
      entityId: invoice!.id,
      summary:
        `Zahlung CHF ${amount.toFixed(2)} (${params.input.method}) zu Rechnung ${invoice!.number}` +
        (storniert ? ' — Rechnung ist storniert, Rückzahlung nötig' : '') +
        (betragWeichtAb ? ` — Betrag weicht vom offenen Saldo (CHF ${offen.toFixed(2)}) ab` : ''),
    });

    return { rechnung: result, storniert, abweichendVon: betragWeichtAb ? offen : null };
    });
  }

  if (abweichendVon !== null) {
    // Nach dem Commit, aus demselben Grund wie beim Storno: Die Meldung darf
    // die Buchung nicht zurückrollen. Einmal je Zahlung — eine erneute
    // Zustellung endet oben an `providerPaymentId`, bevor sie hierher kommt.
    await notifyStaff({
      organizationId: params.organizationId,
      title: 'Zahlung mit abweichendem Betrag',
      body: `Auf die Rechnung ${invoice.number} sind CHF ${amount.toFixed(2)} eingegangen; offen waren CHF ${abweichendVon.toFixed(2)}. Bitte prüfen und eine Differenz ausgleichen.`,
      link: `/admin/rechnungen/${invoice.id}`,
      permission: 'payment:read',
      entity: 'Invoice',
      entityId: invoice.id,
    }).catch((error) => log.error('Meldung zur Zahlung mit abweichendem Betrag fehlgeschlagen', { error }));
  }

  if (aufStornierteRechnung) {
    // Nach dem Commit: Eine Meldung, die scheitert, darf die Buchung nicht
    // zurückrollen — das Geld ist da, und die Zahlungszeile trägt den Hinweis.
    await notifyStaff({
      organizationId: params.organizationId,
      title: 'Zahlung auf stornierte Rechnung',
      body: `Auf die stornierte Rechnung ${invoice.number} sind CHF ${amount.toFixed(2)} eingegangen. Bitte die Rückzahlung veranlassen.`,
      link: `/admin/rechnungen/${invoice.id}`,
      permission: 'payment:read',
      entity: 'Invoice',
      entityId: invoice.id,
    }).catch((error) => log.error('Meldung zur Zahlung auf stornierte Rechnung fehlgeschlagen', { error }));
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
      // Überfällig ist, was *vor* dem heutigen Zürcher Tag fällig war. Prisma
      // kürzte den Zeitpunkt für die `@db.Date`-Spalte bisher stillschweigend
      // auf den UTC-Tag; der Vergleich sagt jetzt selbst, was er meint.
      dueDate: { lt: zuercherTag(now) },
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

    /*
      Mahnung, Mahnstufe und Protokollzeile in **einer** Transaktion
      (2026-09-27, F-14). Eine Mahnung mit Gebühr ändert die Forderung
      gegenüber der Kundschaft und ist eine der ersten Fragen jeder
      Reklamation („wann wurde ich gemahnt, mit welcher Gebühr?"). Bis dahin
      lief das Protokoll nach dem Commit über `audit.updated`, das Fehler
      verschluckt: Die Gebühr stand dann in der Forderung, aber in keinem
      Protokoll. Ohne handelnde Person — der Tageslauf mahnt, nicht jemand im
      Büro.

      **Erst festhalten, dann versenden** (2026-09-27). Vorher ging die
      Nachricht vor der Transaktion hinaus: Scheiterte diese, war die
      Kundschaft gemahnt, aber nichts vermerkt, und der nächste Tageslauf
      mahnte dieselbe Stufe noch einmal. Der Übergang der Mahnstufe ist
      bedingt (`reminderLevel` wie gelesen) — zwei gleichzeitige Tagesläufe
      mahnen so nicht beide. Scheitert danach der Versand, steht die Mahnung
      vermerkt und der Fehlversand im Benachrichtigungsprotokoll; eine
      doppelte Mahnung wäre das grössere Übel.
    */
    const vermerkt = await prisma.$transaction(async (tx) => {
      const stufe = await tx.invoice.updateMany({
        where: { id: invoice.id, reminderLevel: invoice.reminderLevel },
        data: { reminderLevel: level, lastReminderAt: now },
      });
      if (stufe.count === 0) return false;
      await tx.paymentReminder.create({
        data: { invoiceId: invoice.id, level, fee, channel: 'EMAIL' },
      });
      await recordAuditInTx(tx, {
        organizationId,
        action: 'UPDATE',
        entity: 'Invoice',
        entityId: invoice.id,
        summary: `${level === 1 ? 'Zahlungserinnerung' : `${level - 1}. Mahnung`} zu Rechnung ${invoice.number} versendet${fee > 0 ? ` (Gebühr CHF ${fee.toFixed(2)})` : ''}`,
        changes: { reminderLevel: level, fee },
      });
      return true;
    });
    if (!vermerkt) continue;

    await notify({
      userId: invoice.customer.user?.id ?? null,
      email: invoice.billToEmail ?? invoice.customer.email,
      phone: invoice.customer.mobile ?? invoice.customer.phone,
      channels: level >= 2 ? ['IN_APP', 'EMAIL', 'SMS'] : ['IN_APP', 'EMAIL'],
      title: level === 1 ? 'Zahlungserinnerung' : `${level - 1}. Mahnung`,
      body: `Rechnung ${invoice.number} ist seit ${formatDate(invoice.dueDate)} fällig.`,
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
    }).catch((error) => log.error('Mahnung vermerkt, Versand fehlgeschlagen', { invoiceId: invoice.id, error }));

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

  // Storno und Freigabe der Einsätze gemeinsam: Eine stornierte Rechnung
  // verrechnet nichts mehr, und die Einsätze lassen sich neu verrechnen.
  const updated = await prisma.$transaction(async (tx) => {
    /*
      Zeilensperre und Prüfung **in** der Transaktion (2026-09-27, N-05).
      Vorher las der Storno den bezahlten Betrag vor der Transaktion und
      schrieb danach unbedingt: Eine Zahlung, die dazwischen gebucht wurde,
      stand anschliessend auf einer stornierten Rechnung — Geld, das die
      Regel „bezahlt ⇒ Gutschrift statt Storno" gerade verhindern sollte.
      `recordPayment` sperrt dieselbe Zeile; wer zuerst kommt, gewinnt, und
      der andere sieht dessen Stand.

      Die Regel selbst bleibt: Ist Geld eingegangen, wird nicht storniert,
      sondern gutgeschrieben (Gutschrift, danach Rückzahlung) — sonst stünde
      eingegangenes Geld ohne Gegenbeleg da.
    */
    await tx.$queryRaw`SELECT "id" FROM "invoices" WHERE "id" = ${invoice.id} FOR UPDATE`;
    const stand = await tx.invoice.findUniqueOrThrow({ where: { id: invoice.id }, select: { status: true, paidAmount: true, notes: true } });
    if (stand.status === 'CANCELLED') throw new BusinessRuleError('Diese Rechnung ist bereits storniert.');
    if (geld(stand.paidAmount).greaterThan(0)) {
      throw new BusinessRuleError(
        'Für eine teilweise bezahlte Rechnung ist eine Gutschrift zu erstellen, kein Storno.',
      );
    }

    const storniert = await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        balance: 0,
        notes: [stand.notes, `Storniert: ${params.reason}`].filter(Boolean).join('\n'),
      },
    });
    await einsaetzeFreigeben(tx, invoice.id);
    // In der Transaktion (F-14): Ein Storno ohne Zeile wäre ein Beleg, der
    // verschwindet, ohne dass jemand sagen kann, wer ihn zurückgenommen hat.
    await recordAuditInTx(tx, {
      organizationId: params.organizationId,
      userId: params.actorId,
      action: 'UPDATE',
      entity: 'Invoice',
      entityId: invoice.id,
      summary: `Rechnung ${invoice.number} storniert: ${params.reason}`,
    });
    return storniert;
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
  // Dezimal gerechnet (`lib/rechnungsbetraege.ts`, 2026-09-27).
  const { netTotal, vatAmount, grossTotal } = gutschriftsSummen(params.items);
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
      // Dezimal verglichen — vorher `number` mit einer Toleranz von 0.004, die
      // den Binärfehler überdecken sollte.
      const rest = aufRappen(geld(rechnung.grossTotal).minus(geld(bisher._sum.grossTotal))).toNumber();
      if (geld(grossTotal).greaterThan(geld(rest))) {
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
        // Zürcher Tag, nicht UTC-Tag (siehe `createInvoice`).
        issueDate: params.issueDate ?? zuercherTag(),
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
