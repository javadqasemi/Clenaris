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
import { clampQuantity, rateForService, unitForService } from '@/lib/pricing/units';
import type { QuoteRequestInput } from '@/lib/validation/crm';
import type {
  CreateQuoteInput,
  QuoteItemInput,
  RespondQuoteInput,
  UpdateQuoteInput,
} from '@/lib/validation/operations';

import { nextNumber } from './numbering.service';
import { notify, notifyStaff } from './notification.service';
import { createInvoiceFromQuote } from './invoice.service';
import {
  issuePublicToken,
  noteTokenUse,
  resolveWithLegacy,
  revokeTokensFor,
  tokenRejectionError,
} from './access-token.service';

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

  /**
   * Ohne gewählte Rabattart gibt es keinen Rabatt.
   *
   * Zuvor fiel der Fall „keine Art gewählt" in den Fixbetrag-Zweig. Wer im
   * Editor „Prozentual, 10" einstellte und dann auf „Kein Rabatt" zurückging,
   * behielt die 10 im Wertfeld — und bekam beim Speichern still 10 Franken
   * Rabatt statt keinen. Der Fehler war unsichtbar, weil das Wertfeld in
   * diesem Zustand ausgegraut ist.
   */
  const discountAmount = !discountType
    ? 0
    : discountType === 'PERCENT'
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

/**
 * Aus einer Website-Offertanfrage einen Offertentwurf machen.
 *
 * **Das Problem, das diese Funktion löst.** Bisher landete eine Offertanfrage
 * von der Website ausschliesslich im Formular für *Kontaktanfragen*. Die
 * offertspezifischen Angaben — Fläche, Turnus, Strasse, Wunschtermin,
 * angehängte Dateien — wurden dabei von der Validierung stillschweigend
 * verworfen, weil das Kontaktschema sie nicht kennt. In der Offertenübersicht
 * erschien nichts, und im Büro entstand der Eindruck, das Formular sei kaputt.
 * Es war schlimmer: Es funktionierte, nur landete das Ergebnis am falschen Ort
 * und ohne die Hälfte der Angaben.
 *
 * **Warum ein Entwurf und nicht nur ein Lead.** Eine Anfrage, die als Lead
 * endet, muss jemand von Hand in eine Offerte übertragen — und tippt dabei
 * Fläche und Leistung ein zweites Mal ab. Der Entwurf trägt diese Angaben
 * bereits als Position, mit der richtigen Einheit und dem Katalogansatz. Er
 * ist ausdrücklich ein *Entwurf*: Der Preis ist eine Ableitung aus dem
 * Katalog, kein Angebot. Verschickt wird er erst, wenn ihn eine Person
 * geprüft hat.
 *
 * **Warum die Position auch ohne passende Katalogleistung entsteht.** Findet
 * sich keine Leistung zur angefragten Art, wird eine Position mit Menge und
 * Einheit, aber ohne Preis angelegt. Eine leere Offerte würde die Angabe
 * verlieren, um die es geht.
 */
export async function createQuoteFromRequest(params: {
  organizationId: string;
  leadId: string;
  input: QuoteRequestInput;
}): Promise<Quote> {
  const { input } = params;

  const service = await prisma.service.findFirst({
    where: { organizationId: params.organizationId, kind: input.serviceKind, active: true },
    orderBy: { position: 'asc' },
  });

  const unit = unitForService(service?.pricingModel ?? 'PER_HOUR', input.serviceKind);
  const unitPrice = service
    ? rateForService({
        pricingModel: service.pricingModel,
        hourlyRate: service.hourlyRate ? toNumber(service.hourlyRate) : null,
        pricePerSqm: service.pricePerSqm ? toNumber(service.pricePerSqm) : null,
        basePrice: toNumber(service.basePrice),
      })
    : 0;

  /**
   * Die angefragte Menge in die Einheit der Leistung übersetzen.
   *
   * Die Website fragt Fläche ab; abgerechnet wird je nach Leistung nach
   * Fläche, Stunden oder Stück. Für Stundenmodelle wird die Fläche über den
   * hinterlegten Minutenansatz in Stunden umgerechnet — dieselbe Kennzahl, die
   * auch die Einsatzplanung verwendet. Fehlt die Fläche, bleibt die Vorgabe
   * der Einheit stehen; sie ist als Platzhalter erkennbar und wird beim
   * Prüfen ohnehin angefasst.
   */
  const quantity = deriveQuantity(input, service, unit);

  const vatRate = service ? toNumber(service.vatRate) : 8.1;

  const title = [
    service?.name ?? SERVICE_KIND_LABEL[input.serviceKind] ?? 'Reinigung',
    input.city ?? input.postalCode ?? null,
  ]
    .filter(Boolean)
    .join(' · ');

  const quote = await prisma.$transaction(async (tx) => {
    const { number } = await nextNumber(tx, params.organizationId, 'quote');

    return tx.quote.create({
      data: {
        organizationId: params.organizationId,
        number,
        leadId: params.leadId,
        title,
        status: 'DRAFT',
        validUntil: new Date(Date.now() + 30 * 86_400_000),
        introText: buildIntroText(input),
        // Der Wortlaut der Anfrage bleibt intern erhalten — die Einleitung ist
        // eine Zusammenfassung, das Original ist der Beleg.
        internalNote: [
          'Automatisch aus der Offertanfrage auf der Website erstellt.',
          input.preferredDate
            ? `Wunschtermin: ${new Date(input.preferredDate).toLocaleDateString('de-CH')}`
            : null,
          '',
          input.message,
        ]
          .filter((line) => line !== null)
          .join('\n'),
        terms: defaultTerms(),
        subtotal: round2(quantity * unitPrice),
        netTotal: round2(quantity * unitPrice),
        vatAmount: round2(quantity * unitPrice * (vatRate / 100)),
        grossTotal: round2(quantity * unitPrice * (1 + vatRate / 100)),
        items: {
          create: [
            {
              serviceId: service?.id ?? null,
              name: service?.name ?? SERVICE_KIND_LABEL[input.serviceKind] ?? 'Reinigung',
              description: describeRequest(input),
              quantity,
              unit: unit.unit,
              unitPrice,
              discount: 0,
              vatRate,
              lineTotal: round2(quantity * unitPrice),
              position: 0,
              optional: false,
            },
          ],
        },
      },
    });
  });

  // Der Lead steht ab jetzt in der Angebotsphase — dort erwartet ihn die
  // Nachfassliste.
  await prisma.lead.update({
    where: { id: params.leadId },
    data: { status: 'PROPOSAL' },
  });

  await audit.created({
    organizationId: params.organizationId,
    entity: 'Quote',
    entityId: quote.id,
    summary: `Offertentwurf ${quote.number} aus Website-Anfrage erstellt`,
  });

  return quote;
}

const SERVICE_KIND_LABEL: Record<string, string> = {
  OFFICE_CLEANING: 'Büroreinigung',
  MOVE_OUT_CLEANING: 'Umzugsreinigung',
  RESIDENTIAL_CLEANING: 'Wohnungsreinigung',
  WINDOW_CLEANING: 'Fensterreinigung',
  CONSTRUCTION_CLEANING: 'Bauendreinigung',
  BUILDING_MAINTENANCE: 'Liegenschaftsunterhalt',
  SPECIAL: 'Sonderreinigung',
};

const FREQUENCY_LABEL: Record<string, string> = {
  ONCE: 'einmalig',
  WEEKLY: 'wöchentlich',
  BIWEEKLY: 'alle zwei Wochen',
  MONTHLY: 'monatlich',
  QUARTERLY: 'vierteljährlich',
  SEMIANNUAL: 'halbjährlich',
  ANNUAL: 'jährlich',
  CUSTOM: 'nach Absprache',
};

/** Angefragte Fläche in die Abrechnungseinheit der Leistung übersetzen. */
function deriveQuantity(
  input: QuoteRequestInput,
  service: { minutesPerSqm: Prisma.Decimal; defaultDurationMin: number; pricingModel: string } | null,
  unit: ReturnType<typeof unitForService>,
): number {
  const sqm = input.squareMeters ?? null;

  if (unit.unit === 'm²') {
    return sqm ? clampQuantity(sqm, unit) : unit.defaultQuantity;
  }

  if (unit.unit === 'Std.') {
    if (!sqm || !service) return unit.defaultQuantity;
    const minutesPerSqm = toNumber(service.minutesPerSqm);
    const minutes = minutesPerSqm > 0 ? sqm * minutesPerSqm : service.defaultDurationMin;
    return clampQuantity(minutes / 60, unit);
  }

  return unit.defaultQuantity;
}

/** Kurzbeschreibung der Position aus den Angaben der Anfrage. */
function describeRequest(input: QuoteRequestInput): string {
  return [
    input.squareMeters ? `${input.squareMeters} m²` : null,
    input.rooms ? `${input.rooms} Zimmer` : null,
    FREQUENCY_LABEL[input.frequency] ?? null,
    [input.street, [input.postalCode, input.city].filter(Boolean).join(' ')]
      .filter(Boolean)
      .join(', ') || null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Einleitungstext des Entwurfs — vom Büro vor dem Versand zu prüfen. */
function buildIntroText(input: QuoteRequestInput): string {
  return [
    `Guten Tag ${input.firstName} ${input.lastName}`,
    '',
    'Vielen Dank für Ihre Anfrage. Gerne unterbreiten wir Ihnen folgendes Angebot',
    `für die ${SERVICE_KIND_LABEL[input.serviceKind] ?? 'Reinigung'}`,
    input.frequency !== 'ONCE' ? `(${FREQUENCY_LABEL[input.frequency]})` : '',
    '.',
  ]
    .filter(Boolean)
    .join(' ')
    .replace(' .', '.');
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

  /**
   * Für jeden Versand ein frischer, sicherer Link.
   *
   * Vorher stand hier `quote.publicToken` — ein cuid, das als Geheimnis
   * gedacht war und keines ist. Neue Versände bekommen jetzt einen Token aus
   * 32 Zufallsbytes, von dem in der Datenbank nur der SHA-256-Hash liegt.
   *
   * **Warum die alten zuerst widerrufen werden.** Wird eine Offerte ein
   * zweites Mal versendet — korrigierter Betrag, neue Adresse —, soll der
   * erste Link nicht weiter gelten. Sonst lägen zwei gültige Schlüssel zu
   * demselben Vorgang in zwei Postfächern, und der ältere zeigte auf einen
   * Stand, den niemand mehr meint.
   *
   * **Warum der Link nirgends gespeichert wird.** Er lässt sich aus dem Hash
   * nicht zurückrechnen — das ist der Sinn der Sache. Die Verwaltung kann
   * einen verlorenen Link deshalb nicht anzeigen, sondern nur neu versenden.
   * Genau so verhält sich auch die Passwortzurücksetzung.
   */
  await revokeTokensFor({
    purpose: 'QUOTE_RESPOND',
    resourceId: quote.id,
    revokedById: params.actorId,
  });
  const link = await issuePublicToken({
    organizationId: quote.organizationId,
    purpose: 'QUOTE_RESPOND',
    resourceId: quote.id,
    createdById: params.actorId,
    // Nach Ablauf der Offerte hat der Link keinen Zweck mehr. Zwei Wochen
    // Nachlauf, damit eine kurz nach Fristende eintreffende Antwort nicht an
    // einer toten Adresse landet, sondern die Meldung „abgelaufen" bekommt.
    expiresAt: new Date(quote.validUntil.getTime() + 14 * 24 * 60 * 60 * 1000),
  });
  const publicUrl = absoluteUrl(`/offerte/${link.raw}`);

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

/**
 * Öffentlicher Zugriff über den Token; markiert die Offerte als angesehen.
 *
 * **Die Lücke, die hier war.** `sendQuote` stellte seit Gate 1 einen sicheren
 * Token aus und verschickte `/offerte/<64 Hexzeichen>`. Diese Funktion suchte
 * aber weiter in `Quote.publicToken`, einer Spalte mit 25-Zeichen-cuids. Ein
 * Hexwert dieser Länge kann dort nicht treffen — jede seit Gate 1 versendete
 * Offerte führte auf eine „nicht gefunden"-Seite. Umgestellt wurde damals nur
 * die Antwortroute, und die erreicht man erst über diese Seite.
 *
 * Der Fehler war nicht das Übersehen einer Zeile, sondern eine fehlende
 * Prüfung: Die Gate-1-Reihe testete alte Links und den Rennzustand beim
 * Annehmen — nie den frisch ausgestellten Link von Anfang bis Ende. Genau das
 * tut jetzt `oeffentliche-links.test.ts`.
 *
 * Akzeptiert werden `QUOTE_VIEW` **und** `QUOTE_RESPOND`: Wer antworten darf,
 * darf ansehen. Die Umkehrung gilt nicht, dafür sorgt `purposesSatisfying`.
 */
export async function getQuoteByToken(token: string) {
  const aufgeloest = await resolveWithLegacy({
    raw: token,
    purpose: 'QUOTE_VIEW',
    legacyLookup: async (raw) =>
      prisma.quote.findUnique({
        where: { publicToken: raw },
        select: { id: true, organizationId: true },
      }),
  });
  if (!aufgeloest.ok) throw tokenRejectionError(aufgeloest.reason, 'Offerte');

  const quote = await prisma.quote.findFirst({
    where: { id: aufgeloest.resourceId, organizationId: aufgeloest.organizationId },
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

/** Zustände, aus denen heraus eine Offerte noch beantwortet werden kann. */
const BEANTWORTBAR = ['DRAFT', 'SENT', 'VIEWED', 'EXPIRED'] as const;

/** Wer geantwortet hat — für das Prüfprotokoll. */
export type AntwortHerkunft =
  /** Über einen Link ohne Anmeldung. */
  | { art: 'LINK'; tokenId?: string }
  /** Angemeldet im Kundenbereich. */
  | { art: 'KUNDENKONTO'; userId: string };

/**
 * Die eigentliche Antwort auf eine Offerte — unabhängig davon, woher sie kommt.
 *
 * **Warum das herausgelöst ist.** Es gibt jetzt zwei Eingänge: den
 * öffentlichen Link und die angemeldete Ansicht im Kundenbereich. Die
 * Berechtigung unterscheidet sich (Capability gegen Sitzung plus
 * Eigentümerschaft), die Geschäftsoperation nicht. Sie ein zweites Mal zu
 * schreiben hiesse, den Rennzustand, den Gate 1 behoben hat, an der zweiten
 * Stelle neu einzubauen — und zwar unbemerkt, weil die erste weiterhin
 * korrekt wäre.
 *
 * Der Aufrufer hat die Berechtigung bereits geprüft. Diese Funktion prüft
 * den *Zustand*: Frist, Übergang, Folgeaktionen.
 */
async function respondToQuoteCore(params: {
  quoteId: string;
  organizationId: string;
  input: RespondQuoteInput;
  herkunft: AntwortHerkunft;
  ip?: string;
}): Promise<Quote> {
  const quote = await prisma.quote.findFirst({
    where: { id: params.quoteId, organizationId: params.organizationId },
    include: { customer: true, lead: true },
  });
  if (!quote || quote.deletedAt) throw new NotFoundError('Offerte');

  if (quote.validUntil < new Date()) {
    throw new BusinessRuleError(
      'Diese Offerte ist abgelaufen. Wir erstellen Ihnen gerne ein aktualisiertes Angebot.',
    );
  }

  const accepted = params.input.decision === 'ACCEPT';

  /**
   * Der Statusübergang ist die Stelle, an der die Einmaligkeit hängt — nicht
   * der Link und nicht die Sitzung.
   *
   * Vorher wurde gelesen, geprüft und danach geschrieben. Zwei gleichzeitige
   * Annahmen sahen beide `SENT`, beide schrieben, beide lösten die
   * Folgeaktionen aus: zwei Meldungen ans Büro, zwei Lead-Übergänge, zwei
   * neu gerenderte PDF. Die Bedingung steht deshalb in der `where`-Klausel
   * derselben Anweisung: `updateMany` trifft entweder eine Zeile oder keine,
   * und PostgreSQL entscheidet das, nicht die Anwendung.
   *
   * Dass beide Eingänge hier durchlaufen, ist der Grund für die Auslagerung:
   * Eine Annahme über den Link und eine Ablehnung im Kundenkonto,
   * gleichzeitig abgeschickt, ergeben genau einen Übergang.
   */
  const uebergang = await prisma.quote.updateMany({
    where: { id: quote.id, status: { in: [...BEANTWORTBAR] }, deletedAt: null },
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

  if (uebergang.count === 0) {
    throw new BusinessRuleError('Diese Offerte wurde bereits beantwortet.');
  }

  const updated = await prisma.quote.findUniqueOrThrow({ where: { id: quote.id } });

  // Ab hier läuft nur noch, wer den Übergang gewonnen hat — die
  // Folgeaktionen können also nicht doppelt auslösen.
  if (params.herkunft.art === 'LINK' && params.herkunft.tokenId) {
    await noteTokenUse(params.herkunft.tokenId).catch(() => undefined);
  }

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
    permission: 'quote:read',
    emailContent: accepted
      ? quoteAcceptedInternalEmail({
          quoteNumber: quote.number,
          customerName,
          grossTotal: toNumber(quote.grossTotal),
          adminUrl: absoluteUrl(`/admin/offerten/${quote.id}`),
        })
      : undefined,
  });

  /**
   * Das Protokoll unterscheidet die beiden Wege.
   *
   * Eine Antwort über einen Link ohne Anmeldung ist etwas anderes als eine
   * aus einem angemeldeten Konto: Im einen Fall weiss man, dass jemand den
   * Link hatte, im anderen, wer es war. Beides als dasselbe zu verbuchen
   * machte die Spur später unbrauchbar — gerade dort, wo sie zählt.
   */
  await audit.updated({
    organizationId: quote.organizationId,
    userId: params.herkunft.art === 'KUNDENKONTO' ? params.herkunft.userId : undefined,
    entity: 'Quote',
    entityId: quote.id,
    summary:
      params.herkunft.art === 'KUNDENKONTO'
        ? `Offerte ${quote.number} im Kundenkonto ${accepted ? 'angenommen' : 'abgelehnt'}`
        : `Offerte ${quote.number} über den Link ${accepted ? 'angenommen' : 'abgelehnt'}`,
    ip: params.ip,
  });

  // PDF mit Unterschrift neu erzeugen.
  if (accepted) {
    await renderQuotePdf(quote.id).catch(() => undefined);
  }

  return updated;
}

/**
 * Antwort über den öffentlichen Link.
 *
 * Prüft die Capability und reicht danach an `respondToQuoteCore` weiter.
 */
export async function respondToQuote(params: {
  token: string;
  input: RespondQuoteInput;
  ip?: string;
}): Promise<Quote> {
  const aufgeloest = await resolveWithLegacy({
    raw: params.token,
    purpose: 'QUOTE_RESPOND',
    /**
     * Kein Rückfall auf den alten Weg — hier nicht, unabhängig von der
     * Umgebungseinstellung. Annehmen und Ablehnen ändern den Zustand der
     * Offerte, lösen Meldungen aus und lassen sich nicht zurücknehmen. Wer
     * nur einen alten cuid-Link hat, sieht die Offerte weiterhin und bekommt
     * für die Antwort einen neuen Link.
     */
    allowLegacy: false,
    legacyLookup: async (raw) => {
      const treffer = await prisma.quote.findUnique({
        where: { publicToken: raw },
        select: { id: true, organizationId: true },
      });
      return treffer;
    },
  });
  if (!aufgeloest.ok) throw tokenRejectionError(aufgeloest.reason, 'Offerte');

  return respondToQuoteCore({
    quoteId: aufgeloest.resourceId,
    organizationId: aufgeloest.organizationId,
    input: params.input,
    herkunft: { art: 'LINK', tokenId: aufgeloest.tokenId },
    ip: params.ip,
  });
}

/**
 * Antwort aus dem angemeldeten Kundenbereich.
 *
 * **Kein öffentlicher Token im Spiel.** Wer angemeldet ist und die Offerte
 * besitzt, braucht keine Capability — die wäre ein Umweg über einen Weg für
 * Aussenstehende und ein Geheimnis, das ohne Not entsteht.
 *
 * Die Eigentümerprüfung steht in der `where`-Klausel, nicht in einem `if`:
 * Eine fremde Offerte wird nicht gefunden, statt gefunden und abgelehnt zu
 * werden. Das schliesst auch die Organisation mit ein.
 */
export async function respondToQuoteAsCustomer(params: {
  quoteId: string;
  organizationId: string;
  customerId: string;
  userId: string;
  input: RespondQuoteInput;
  ip?: string;
}): Promise<Quote> {
  const eigene = await prisma.quote.findFirst({
    where: {
      id: params.quoteId,
      organizationId: params.organizationId,
      customerId: params.customerId,
      deletedAt: null,
    },
    select: { id: true },
  });
  if (!eigene) throw new NotFoundError('Offerte');

  return respondToQuoteCore({
    quoteId: eigene.id,
    organizationId: params.organizationId,
    input: params.input,
    herkunft: { art: 'KUNDENKONTO', userId: params.userId },
    ip: params.ip,
  });
}

/**
 * Eine Offerte für die angemeldete Kundschaft laden.
 *
 * Gegenstück zu `getQuoteByToken` für den Fall, dass eine Sitzung vorliegt.
 * Dieselbe Darstellung, andere Berechtigung — und deshalb eine eigene
 * Funktion statt eines Schalters in der bestehenden.
 */
export async function getQuoteForCustomer(params: {
  quoteId: string;
  organizationId: string;
  customerId: string;
}) {
  const quote = await prisma.quote.findFirst({
    where: {
      id: params.quoteId,
      organizationId: params.organizationId,
      customerId: params.customerId,
      deletedAt: null,
    },
    include: {
      items: { orderBy: { position: 'asc' } },
      customer: { select: { firstName: true, lastName: true, companyName: true, email: true } },
      lead: { select: { firstName: true, lastName: true, company: true, email: true } },
      organization: {
        select: { name: true, email: true, phone: true, logoUrl: true, primaryColor: true },
      },
    },
  });
  if (!quote) throw new NotFoundError('Offerte');
  return quote;
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

