import 'server-only';

import type { Prisma, Quote } from '@prisma/client';

import { prisma, toNumber, type Tx } from '@/lib/db';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { absoluteUrl, formatDate, round2 } from '@/lib/utils';
import { aufRappen, geld, max0, prozentVon, summe } from '@/lib/money';
import { rechnungsSummen } from '@/lib/rechnungsbetraege';
import { orderByFor, resolveSort, type SortOrder } from '@/lib/sort';
import { audit } from '@/lib/audit';
import { automationEreignisseAbarbeiten, automationEreignisVormerken } from './automation-engine.service';
import { quoteExpiringEmail, quoteSentEmail } from '@/lib/email/templates';
import { renderQuotePdf, renderQuoteSnapshot } from '@/lib/pdf/render';
import { readLocalBytes, readStoredBytes } from '@/lib/storage';
import { clampQuantity, rateForService, unitForService } from '@/lib/pricing/units';
import type { QuoteRequestInput } from '@/lib/validation/crm';
import type {
  CreateQuoteInput,
  QuoteItemInput,
  RespondQuoteInput,
  UpdateQuoteInput,
} from '@/lib/validation/operations';

import { nextNumber } from './numbering.service';
import { notify } from './notification.service';
import { createInvoiceFromQuote } from './invoice.service';
import {
  issuePublicToken,
  noteTokenUse,
  resolveWithLegacy,
  revokeTokensFor,
  tokenRejectionError,
} from './access-token.service';
import {
  assertQuoteAnnehmbar,
  cancelActiveQuoteAcceptanceInTx,
  declineQuoteCore,
  quoteAcceptanceExpiresAt,
  type AntwortHerkunft,
} from './quote-acceptance.service';
import type { AnfrageKontext } from './signature-events';
import {
  createQuoteAcceptanceRequest,
  findActiveQuoteAcceptance,
  findCompletedQuoteAcceptance,
  issueSignatureAccess,
  issueQuoteAcceptanceSession,
} from './signature.service';

export type { AntwortHerkunft } from './quote-acceptance.service';

/**
 * Offertenverwaltung.
 *
 * Architekturentscheide:
 *  1. Positionstotale werden serverseitig berechnet — der Client schickt nur
 *     Menge, Einzelpreis und Rabatt. Damit können manipulierte Requests keine
 *     inkonsistenten Summen erzeugen.
 *  2. Optionale Positionen fliessen nicht ins Total ein, werden aber im PDF
 *     ausgewiesen. Das ist im Reinigungsgewerbe üblich (z. B. „Fenster zusätzlich").
 *  3. Versandte Offerten sind über einen Capability-Link ohne Login erreichbar
 *     (`access-token.service.ts`). Die Annahme läuft seit Gate 4C über den
 *     Signaturkern: unveränderlicher Snapshot, Zustimmung, gezeichnete oder
 *     getippte Unterschrift, Prüfsummen und Protokoll — die Offerte wird
 *     erst mit dem Abschluss des Vorgangs ACCEPTED (`quote-acceptance.service.ts`).
 *     Die Altfelder `signatureDataUrl`/`signatureName`/`signatureIp`/`signedAt`
 *     werden von neuen Annahmen nicht mehr geschrieben.
 */

interface ComputedTotals {
  subtotal: number;
  discountAmount: number;
  netTotal: number;
  vatAmount: number;
  grossTotal: number;
  items: (QuoteItemInput & { lineTotal: number; position: number })[];
}

/**
 * Positionen und Totale konsistent berechnen — dezimal und nach derselben
 * Regel wie die Rechnung (2026-09-27, Befund N-03/Q-02).
 *
 * Bis dahin rechnete diese Funktion in JavaScript-`number`: 1.5 Std. × CHF
 * 30.15 sind 45.225, binär knapp darunter, und die Offerte zeigte 45.22 statt
 * 45.23. Dazu eine eigene MWST-Methode (Summe der ungerundeten
 * Positionssteuern), während die Rechnung aus derselben Offerte
 * (`createInvoiceFromQuote`) je Position auf Rappen rundet, wie es
 * `invoice.service.ts` für das MWSTG festhält. Offerte und Rechnung konnten so
 * um Rappen auseinanderliegen, obwohl die Rechnung die angenommene Offerte
 * sein soll.
 *
 * Jetzt rechnet `rechnungsSummen` (`lib/rechnungsbetraege.ts`) beides:
 * Positionsnetto, MWST je Position, Rabatt gekappt und anteilig auf die MWST
 * umgelegt. `createInvoiceFromQuote` übergibt dieselben verbindlichen
 * Positionen und denselben Rabattbetrag — die Rechnung ergibt damit genau das
 * Total der Offerte. Die Rabattregel der Offerte (Prozent vom Zwischentotal
 * oder Fixbetrag, höchstens das Zwischentotal) bleibt, nur dezimal.
 */
export function computeQuoteTotals(
  items: QuoteItemInput[],
  discountType?: 'PERCENT' | 'FIXED',
  discountValue = 0,
): ComputedTotals {
  // Zeilen **aller** Positionen — auch die optionalen tragen im PDF ihren Betrag.
  const zeilen = rechnungsSummen(items).items;
  const computed = items.map((item, index) => ({ ...item, lineTotal: zeilen[index]!.netAmount, position: index }));

  // Optionale Positionen zählen nicht zum verbindlichen Total.
  const verbindlich = items.filter((item) => !item.optional);
  const subtotal = summe(computed.filter((item) => !item.optional).map((item) => item.lineTotal)).toNumber();

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
      ? prozentVon(subtotal, discountValue)
      : aufRappen(max0(discountValue).lessThan(geld(subtotal)) ? max0(discountValue) : geld(subtotal)).toNumber();

  // Netto, MWST je Position und Brutto wie auf der Rechnung aus dieser Offerte.
  const summen = rechnungsSummen(verbindlich, discountAmount);

  return {
    subtotal: summen.subtotal,
    discountAmount,
    netTotal: summen.netTotal,
    vatAmount: summen.vatAmount,
    grossTotal: summen.grossTotal,
    items: computed,
  };
}

// ---------------------------------------------------------------------------
//  CRUD
// ---------------------------------------------------------------------------

/**
 * Kundschaft, Anfrage und Objekt einer Offerte gehören der Organisation —
 * und das Objekt der Kundschaft.
 *
 * Bis 2026-09-23 übernahm `createQuote` die drei Kennungen ungeprüft. Eine
 * Kennung aus einer anderen Organisation (oder ein Objekt einer anderen
 * Kundschaft) ergab eine Offerte, die auf fremde Daten zeigt; ihr PDF hätte
 * fremde Adressen gedruckt. Die Prüfung steht in der Abfrage (404), wie
 * überall sonst.
 */
async function pruefeOffertBezug(tx: Tx, organizationId: string, input: Pick<CreateQuoteInput, 'customerId' | 'leadId' | 'propertyId'>) {
  if (input.customerId) {
    const k = await tx.customer.findFirst({ where: { id: input.customerId, organizationId }, select: { id: true } });
    if (!k) throw new NotFoundError('Kunde');
  }
  if (input.leadId) {
    const l = await tx.lead.findFirst({ where: { id: input.leadId, organizationId }, select: { id: true } });
    if (!l) throw new NotFoundError('Lead');
  }
  if (input.propertyId) {
    const o = await tx.property.findFirst({
      where: {
        id: input.propertyId,
        customer: { organizationId },
        ...(input.customerId ? { customerId: input.customerId } : {}),
      },
      select: { id: true },
    });
    if (!o) throw new NotFoundError('Objekt');
  }
}

/**
 * Die Offerte in einer bestehenden Transaktion anlegen — für Aufrufer, die
 * im selben Schritt noch etwas anderes festhalten müssen (die Besichtigung,
 * aus der die Offerte entsteht). Lead-Status und Protokoll übernimmt der
 * Aufrufer.
 */
export async function createQuoteTx(
  tx: Tx,
  params: { organizationId: string; input: CreateQuoteInput; actorId: string },
): Promise<Quote> {
  await pruefeOffertBezug(tx, params.organizationId, params.input);
  const totals = computeQuoteTotals(params.input.items, params.input.discountType, params.input.discountValue);
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
}

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
    await pruefeOffertBezug(tx, params.organizationId, params.input);
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
            ? `Wunschtermin: ${formatDate(new Date(input.preferredDate))}`
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

  /**
   * Signaturrelevant ist alles, was im Snapshot steht — Titel, Gültigkeit,
   * Texte, Bedingungen, Positionen, Rabatt. Eine interne Notiz nicht.
   *
   * Läuft gerade eine Unterzeichnung, wird sie mit der Änderung abgebrochen
   * (in derselben Transaktion, nach der Offerte — Sperrreihenfolge): Der
   * alte Snapshot darf nicht still weiter unterschrieben werden, wenn die
   * Offerte inzwischen etwas anderes sagt. Er bleibt als Beleg; ein neuer
   * Versand führt zu einem neuen Vorgang mit neuem Snapshot (§ 12).
   */
  const signaturrelevant =
    params.input.title !== undefined ||
    params.input.validUntil !== undefined ||
    params.input.introText !== undefined ||
    params.input.outroText !== undefined ||
    params.input.terms !== undefined ||
    params.input.items !== undefined ||
    params.input.discountType !== undefined ||
    params.input.discountValue !== undefined;

  const { updated, abgebrochen } = await prisma.$transaction(async (tx) => {
    const updated = await tx.quote.update({ where: { id: quote.id }, data });
    const abgebrochen = signaturrelevant
      ? await cancelActiveQuoteAcceptanceInTx(tx, { quoteId: quote.id, reason: 'quote_changed', cancelledById: params.actorId })
      : 0;
    return { updated, abgebrochen };
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Quote',
    entityId: quote.id,
    summary:
      abgebrochen > 0
        ? `Offerte ${quote.number} bearbeitet — laufende Unterzeichnung abgebrochen`
        : `Offerte ${quote.number} bearbeitet`,
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
  /**
   * Versendet wird nur, was noch eine Antwort erwartet.
   *
   * Bis 2026-09-26 fehlte diese Prüfung: Eine angenommene Offerte liess sich
   * erneut versenden, der Versand setzte sie auf SENT zurück — und die
   * tragende Gleichung „Offerte angenommen ⇔ abgeschlossener
   * Annahmevorgang" (Gate 4C) war gebrochen, ohne dass jemand etwas
   * rückgängig gemacht hätte. Gefunden hat es die Integritätsprüfung
   * (`offerte_annahme`), nachdem eine Prüfreihe die erste Offerte der Liste
   * versandt hatte. Eine abgelehnte, abgelaufene oder umgewandelte Offerte
   * wird ebenso wenig wiederbelebt: Wer neu anbieten will, legt eine neue an.
   */
  if (!['DRAFT', 'SENT', 'VIEWED'].includes(quote.status)) {
    throw new BusinessRuleError(
      `Die Offerte ${quote.number} ist ${quote.status === 'ACCEPTED' || quote.status === 'CONVERTED' ? 'bereits angenommen' : quote.status === 'REJECTED' ? 'abgelehnt' : 'abgelaufen'} und wird nicht erneut versendet.`,
    );
  }
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

  // Statuswechsel und Ereignis gemeinsam (Outbox, 2026-09-27).
  const updated = await prisma.$transaction(async (tx) => {
    const gesendet = await tx.quote.update({
      where: { id: quote.id },
      data: { status: 'SENT', sentAt: new Date() },
    });
    await automationEreignisVormerken(tx, { organizationId: params.organizationId, trigger: 'QUOTE_SENT', entityId: quote.id });
    return gesendet;
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Quote',
    entityId: quote.id,
    summary: `Offerte ${quote.number} an ${recipientEmail} versendet`,
  });

  await automationEreignisseAbarbeiten({ organizationId: params.organizationId });

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

/**
 * Ergebnis einer Antwort: Eine Ablehnung ist sofort entschieden; eine Annahme
 * beginnt einen Unterzeichnungsvorgang und liefert den Weg dorthin — über
 * den Link als rohen Zugangstoken (nur für das Fragment der Adresse), aus
 * dem Kundenkonto als fertige Sitzung.
 */
export type QuoteAntwort =
  | { kind: 'DECLINED'; status: string; rejectedAt: Date | null }
  | { kind: 'SIGNATURE'; publicId: string; expiresAt: Date; raw: string | null; sessionToken: string | null };

/**
 * Den Annahmevorgang starten oder fortsetzen — für beide Eingänge.
 *
 * **Reihenfolge.** Offerte laden und prüfen (Zustand, Frist), offenen Vorgang
 * suchen; gibt es keinen: Snapshot rendern — **jetzt**, nicht beim
 * Abschluss —, ablegen, Vorgang anlegen. Verliert das Anlegen das Rennen
 * gegen einen gleichzeitigen Start (Teilindex), wird der Vorgang des
 * Gewinners weiterverwendet: Mehrfaches Klicken erzeugt einen Vorgang, nicht
 * vier (§ 11, § 27).
 *
 * **Wer unterzeichnet**, bestimmt der Server aus Kundschaft bzw. Lead der
 * Offerte — nicht der Browser (§ 14). Der eingegebene Name landet später
 * getrennt als `signedName` am Teilnehmer.
 */
async function startQuoteAcceptanceCore(params: {
  quoteId: string;
  organizationId: string;
  herkunft: AntwortHerkunft;
  ctx: AnfrageKontext;
}): Promise<{ requestId: string; publicId: string; participantId: string; expiresAt: Date }> {
  const quote = await prisma.quote.findFirst({
    where: { id: params.quoteId, organizationId: params.organizationId },
    include: {
      customer: { select: { id: true, firstName: true, lastName: true, companyName: true, email: true } },
      lead: { select: { firstName: true, lastName: true, email: true } },
    },
  });
  if (!quote || quote.deletedAt) throw new NotFoundError('Offerte');
  assertQuoteAnnehmbar(quote);

  const vorhanden = await findActiveQuoteAcceptance(quote.id);
  if (vorhanden && vorhanden.status === 'PENDING' && vorhanden.expiresAt.getTime() > Date.now()) {
    const p = vorhanden.participants[0];
    if (p) return { requestId: vorhanden.id, publicId: vorhanden.publicId, participantId: p.id, expiresAt: vorhanden.expiresAt };
  }
  if (vorhanden && vorhanden.status === 'FINALIZING') {
    throw new BusinessRuleError('Die Unterzeichnung dieser Offerte wird gerade abgeschlossen.');
  }

  const name =
    quote.customer?.companyName ??
    `${quote.customer?.firstName ?? quote.lead?.firstName ?? ''} ${quote.customer?.lastName ?? quote.lead?.lastName ?? ''}`.trim();
  const email = quote.customer?.email ?? quote.lead?.email ?? null;
  if (!name || !email) {
    throw new BusinessRuleError('Für diese Offerte ist keine Empfängerin und keine E-Mail-Adresse hinterlegt.');
  }

  const snapshot = await renderQuoteSnapshot(quote.id);
  const expiresAt = quoteAcceptanceExpiresAt(quote.validUntil);
  const actorSource = params.herkunft.art === 'KUNDENKONTO' ? 'AUTHENTICATED_CUSTOMER' : 'PUBLIC_LINK';

  const angelegt = await createQuoteAcceptanceRequest({
    quote: { id: quote.id, organizationId: quote.organizationId, number: quote.number, title: quote.title, validUntil: quote.validUntil, createdById: quote.createdById },
    participant: { name, email, customerId: quote.customer?.id ?? null },
    // Die Naht zwischen zwei Sprachgebräuchen: `src/lib/pdf` liefert seit je
    // `buffer`, der Signaturkern spricht von `bytes`. Hier umbenannt statt in
    // einem der beiden Module — ein Renderer, der plötzlich `bytes` zurückgibt,
    // fiele aus der Reihe der übrigen `render*Pdf`.
    snapshot: { bytes: snapshot.buffer, filename: snapshot.filename },
    expiresAt,
    actorSource,
    actorUserId: params.herkunft.art === 'KUNDENKONTO' ? params.herkunft.userId : null,
    ctx: params.ctx,
  });
  if (angelegt) {
    await audit.updated({
      organizationId: quote.organizationId,
      userId: params.herkunft.art === 'KUNDENKONTO' ? params.herkunft.userId : undefined,
      entity: 'Quote',
      entityId: quote.id,
      summary: `Annahme der Offerte ${quote.number} begonnen (Vorgang ${angelegt.id}, ${actorSource === 'AUTHENTICATED_CUSTOMER' ? 'Kundenkonto' : 'Link'})`,
      ip: params.ctx.ip,
      userAgent: params.ctx.userAgent,
    });
    return { requestId: angelegt.id, publicId: angelegt.publicId, participantId: angelegt.participantId, expiresAt };
  }

  // Jemand war schneller — dessen Vorgang gilt.
  const gewinner = await findActiveQuoteAcceptance(quote.id);
  const p = gewinner?.participants[0];
  if (!gewinner || !p) throw new BusinessRuleError('Der Annahmevorgang konnte nicht begonnen werden. Bitte erneut versuchen.');
  return { requestId: gewinner.id, publicId: gewinner.publicId, participantId: p.id, expiresAt: gewinner.expiresAt };
}

/**
 * Antwort über den öffentlichen Link.
 *
 * Prüft die Capability (`QUOTE_RESPOND`, kein Altbestand) und entscheidet:
 * Ablehnung direkt, Annahme als Start des Unterzeichnungsvorgangs. Der
 * `QUOTE_RESPOND`-Link wird dabei **nicht** zum Signatur-Token: Für den
 * Vorgang wird ein eigener `SIGNATURE_ACCESS` ausgestellt, den der Browser
 * nur als Fragment sieht (§ 15, § 16).
 */
export async function respondToQuote(params: {
  token: string;
  input: RespondQuoteInput;
  ctx: AnfrageKontext;
}): Promise<QuoteAntwort> {
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

  const herkunft: AntwortHerkunft = { art: 'LINK', tokenId: aufgeloest.tokenId };
  if (params.input.decision === 'REJECT') {
    const abgelehnt = await declineQuoteCore({
      quoteId: aufgeloest.resourceId,
      organizationId: aufgeloest.organizationId,
      reason: params.input.reason,
      herkunft,
      ctx: params.ctx,
    });
    if (aufgeloest.tokenId) await noteTokenUse(aufgeloest.tokenId).catch(() => undefined);
    return { kind: 'DECLINED', status: abgelehnt.status, rejectedAt: abgelehnt.rejectedAt };
  }

  const start = await startQuoteAcceptanceCore({
    quoteId: aufgeloest.resourceId,
    organizationId: aufgeloest.organizationId,
    herkunft,
    ctx: params.ctx,
  });
  if (aufgeloest.tokenId) await noteTokenUse(aufgeloest.tokenId).catch(() => undefined);
  const zugang = await issueSignatureAccess({
    organizationId: aufgeloest.organizationId,
    requestId: start.requestId,
    participantId: start.participantId,
    expiresAt: start.expiresAt,
    actorSource: 'PUBLIC_LINK',
    ctx: params.ctx,
  });
  return { kind: 'SIGNATURE', publicId: start.publicId, expiresAt: zugang.expiresAt, raw: zugang.raw, sessionToken: null };
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
  ctx: AnfrageKontext;
}): Promise<QuoteAntwort> {
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

  const herkunft: AntwortHerkunft = { art: 'KUNDENKONTO', userId: params.userId };
  if (params.input.decision === 'REJECT') {
    const abgelehnt = await declineQuoteCore({
      quoteId: eigene.id,
      organizationId: params.organizationId,
      reason: params.input.reason,
      herkunft,
      ctx: params.ctx,
    });
    return { kind: 'DECLINED', status: abgelehnt.status, rejectedAt: abgelehnt.rejectedAt };
  }

  /**
   * Angemeldet heisst: Berechtigung bereits nachgewiesen. Statt eines Links
   * an die eigene Adresse bekommt die Person direkt eine an den Teilnehmer
   * gebundene Sitzung (§ 29, § 30) — das Protokoll hält den Zugangsweg fest.
   */
  const start = await startQuoteAcceptanceCore({
    quoteId: eigene.id,
    organizationId: params.organizationId,
    herkunft,
    ctx: params.ctx,
  });
  const sitzung = await issueQuoteAcceptanceSession({
    organizationId: params.organizationId,
    requestId: start.requestId,
    participantId: start.participantId,
    expiresAt: start.expiresAt,
    userId: params.userId,
    ctx: params.ctx,
  });
  return { kind: 'SIGNATURE', publicId: start.publicId, expiresAt: sitzung.expiresAt, raw: null, sessionToken: sitzung.sessionToken };
}

/**
 * Der Annahmezustand einer Offerte — für Seiten und PDF-Routen.
 *
 * `active`: ein offener Vorgang (Maske zeigt „Unterzeichnung fortsetzen").
 * `completed`: der abgeschlossene Vorgang mit Artefakten (die PDF-Routen
 * liefern dann das signierte Artefakt B statt einer Neuberechnung).
 * `legacy`: ACCEPTED aus der Zeit vor Gate 4C, nur mit den Altfeldern —
 * wird als solches ausgewiesen und nicht als Signaturbeweis dargestellt.
 */
export async function getQuoteAcceptanceState(quote: {
  id: string;
  status: string;
  signatureName: string | null;
  signedAt: Date | null;
}) {
  const [active, completed] = await Promise.all([findActiveQuoteAcceptance(quote.id), findCompletedQuoteAcceptance(quote.id)]);
  const signer = completed?.participants[0] ?? null;
  return {
    active: active && active.status === 'PENDING' ? { publicId: active.publicId, expiresAt: active.expiresAt } : null,
    completed: completed
      ? {
          requestId: completed.id,
          publicId: completed.publicId,
          signedName: signer?.signedName ?? signer?.nameSnapshot ?? null,
          method: signer?.signatureMethod ?? null,
          signedAt: signer?.signedAt ?? completed.completedAt,
          hashes: { original: completed.originalDocumentHash, signed: completed.signedArtifactHash, evidence: completed.evidenceArtifactHash },
          hasSigned: completed.signedArtifactId !== null,
          hasEvidence: completed.evidenceArtifactId !== null,
        }
      : null,
    legacy: quote.status === 'ACCEPTED' && !completed && Boolean(quote.signatureName || quote.signedAt),
  };
}

/**
 * Die Bytes des signierten Artefakts (B) einer angenommenen Offerte — oder
 * `null`, wenn die Annahme nicht über den Signaturkern lief. Die PDF-Routen
 * liefern in diesem Fall das gewöhnliche Dokument.
 */
export async function getSignedQuoteArtifact(quoteId: string): Promise<{ bytes: Buffer; filename: string } | null> {
  const completed = await findCompletedQuoteAcceptance(quoteId);
  if (!completed?.signedArtifact) return null;
  const asset = completed.signedArtifact;
  let bytes: Buffer | null = null;
  if (asset.storedFile) {
    bytes = await readStoredBytes(asset.storedFile);
  } else {
    const treffer = /^\/api\/files\/blob\/([A-Za-z0-9_-]+)$/.exec(asset.url);
    bytes = treffer ? await readLocalBytes(treffer[1]!) : null;
  }
  if (!bytes) return null;
  return { bytes, filename: asset.filename };
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

    /**
     * Beide Buchungsereignisse, in dieser Transaktion (F-12, 2026-09-27).
     *
     * Die Umwandlung legt die Buchung in einem Schritt an **und** bestätigt
     * sie — `status: 'CONFIRMED'` —, sie durchläuft also weder
     * `createBooking` noch `confirmBooking`, wo die beiden Vermerke sonst
     * entstehen. Bis hierher lief deshalb keine Regel auf „Buchung angelegt"
     * oder „Buchung bestätigt", wenn die Buchung aus einer Offerte kam: die
     * Bestätigungsmail an die Kundschaft blieb aus, ohne Fehler und ohne
     * Spur. Der Paritätstest sah das nicht, weil er nur nach dem Quelltext
     * `trigger: 'X'` sucht und beide Auslöser anderswo vorkommen.
     *
     * Beide und nicht nur BOOKING_CONFIRMED: Eine Regel „bei neuer Buchung
     * die Disposition benachrichtigen" soll nicht davon abhängen, auf welchem
     * Weg die Buchung entstand. Vermerkt in der Transaktion, damit die
     * Buchung ohne ihre Ereignisse nicht festgeschrieben werden kann.
     */
    await automationEreignisVormerken(tx, { organizationId: params.organizationId, trigger: 'BOOKING_CREATED', entityId: created.id });
    await automationEreignisVormerken(tx, { organizationId: params.organizationId, trigger: 'BOOKING_CONFIRMED', entityId: created.id });

    // Buchungszahl und letzte Buchung wie in `createBooking` (2026-09-27).
    // Vorher fehlten sie hier; das Stornieren zählt aber auf jedem Weg
    // herunter — eine stornierte umgewandelte Buchung drückte die Zahl unter
    // den wahren Wert.
    await tx.customer.update({
      where: { id: created.customerId },
      data: { totalBookings: { increment: 1 }, lastBookingAt: new Date() },
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

  /**
   * Nach dem Commit abarbeiten — wie `createBooking` und `confirmBooking`:
   * Die Maschine lädt die Buchung neu und sähe sie innerhalb der Transaktion
   * nicht, und eine Regel darf die Umwandlung nicht scheitern lassen (wirft
   * nie). Bleibt dieser Aufruf aus, holt der stündliche Lauf den Vermerk nach.
   */
  await automationEreignisseAbarbeiten({ organizationId: params.organizationId });

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
      /** Die Annahmevorgänge (Gate 4C) — Kennungen, Zustände, Prüfsummen; nie Tokens. */
      signatureRequests: {
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          publicId: true,
          status: true,
          assuranceLevel: true,
          artifactMode: true,
          createdAt: true,
          expiresAt: true,
          completedAt: true,
          cancelledAt: true,
          originalDocumentHash: true,
          signedArtifactHash: true,
          evidenceArtifactHash: true,
          participants: {
            orderBy: { order: 'asc' },
            select: { id: true, nameSnapshot: true, emailSnapshot: true, status: true, signedName: true, signatureMethod: true, signedAt: true },
          },
        },
      },
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

  /**
   * Ablauf — je Offerte in einer Transaktion, damit ein offener
   * Annahmevorgang mitgeht (Sperrreihenfolge Offerte → Vorgang). Ein
   * Vorgang, dessen Offerte abgelaufen ist, darf nicht weiter unterschrieben
   * werden; der Abschluss würde ohnehin an `validUntil` scheitern, aber der
   * Link soll gar nicht erst „gültig" wirken.
   */
  const faellig = await prisma.quote.findMany({
    where: { organizationId, deletedAt: null, status: { in: ['SENT', 'VIEWED'] }, validUntil: { lt: now } },
    select: { id: true },
  });
  let expiredCount = 0;
  for (const q of faellig) {
    await prisma.$transaction(async (tx) => {
      const u = await tx.quote.updateMany({
        where: { id: q.id, status: { in: ['SENT', 'VIEWED'] }, validUntil: { lt: now } },
        data: { status: 'EXPIRED' },
      });
      if (u.count === 0) return;
      expiredCount += 1;
      await cancelActiveQuoteAcceptanceInTx(tx, { quoteId: q.id, reason: 'quote_expired' });
    });
  }
  const expiredResult = { count: expiredCount };

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

    /**
     * Hier stand `/offerte/${quote.publicToken}` — der alte cuid-Link, der
     * seit Gate 2.5 ohne ausdrückliche Freigabe nichts mehr öffnet. Die
     * Erinnerung bekommt einen frischen Capability-Link; der ursprüngliche
     * bleibt gültig (kein Widerruf), beide enden mit der Offerte.
     */
    const link = await issuePublicToken({
      organizationId: quote.organizationId,
      purpose: 'QUOTE_RESPOND',
      resourceId: quote.id,
      expiresAt: new Date(quote.validUntil.getTime() + 14 * 24 * 60 * 60 * 1000),
    });

    await notify({
      userId: quote.customer?.user?.id ?? null,
      email,
      channels: ['EMAIL'],
      title: 'Offerte läuft ab',
      body: `Offerte ${quote.number} läuft am ${formatDate(quote.validUntil)} ab.`,
      emailContent: quoteExpiringEmail({
        firstName: quote.customer?.firstName ?? quote.lead?.firstName ?? 'Kundin/Kunde',
        quoteNumber: quote.number,
        validUntil: quote.validUntil,
        quoteUrl: absoluteUrl(`/offerte/${link.raw}`),
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

