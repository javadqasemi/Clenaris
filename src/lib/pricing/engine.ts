import 'server-only';

import type { Frequency, PriceRule, Service, ServiceExtra, ServiceKind } from '@prisma/client';

import { prisma, toNumber } from '@/lib/db';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { round2 } from '@/lib/utils';
import { aufRappen, geld, produkt, prozentVon, summeZahl } from '@/lib/money';
import type {
  BookingPriceInput,
  CouponCheck,
  LeistungInput,
  PriceBreakdown,
  PriceInput,
  PriceLine,
  PricePosition,
  PriceRuleCondition,
} from './types';

/**
 * Preis-Engine.
 *
 * Architekturentscheid: Preise werden *ausschliesslich* serverseitig berechnet.
 * Das Frontend ruft `/api/public/pricing/estimate` auf und zeigt das Ergebnis an
 * — es rechnet nie selbst. So kann ein manipulierter Client keinen Preis
 * unterschieben, und die Logik existiert genau einmal (Instant-Quote,
 * Buchungsabschluss, Offerte und Rechnung nutzen dieselbe Funktion).
 *
 * Ablauf:
 *   1. Grundpreis nach Preismodell (Stunden / m² / Pauschale) — je Leistung
 *   2. Zusatzleistungen — je Leistung
 *   3. Anfahrtspauschale nach PLZ — einmal je Buchung
 *   4. Preisregeln (Multiplikatoren + Fixzuschläge, nach Priorität)
 *   5. Frequenzrabatt
 *   6. Gutschein & Kundenrabatt
 *   7. Mindestpreis, MwSt., Rundung
 *
 * ---------------------------------------------------------------------------
 *  Mehrere Leistungen in einer Buchung (Produktsprint 2026-09-26)
 * ---------------------------------------------------------------------------
 *
 * Eine Buchung kann seither Büroreinigung *und* Fensterreinigung umfassen.
 * Die naheliegende Umsetzung — `calculatePrice` je Leistung aufrufen und die
 * Summen addieren, wie es `site-visit.service.ts` für Besichtigungen tut —
 * wäre für eine Buchung falsch: Anfahrt, Gutschein, Mindestauftragswert und
 * globale Fixzuschläge gälten dann einmal *je Leistung*. Wer zwei Leistungen
 * bucht, fährt aber nur einmal hin.
 *
 * Deshalb trennt die Engine, was je Leistung gilt, von dem, was je Buchung
 * gilt:
 *
 *  • **je Leistung:** Dauer, Teamgrösse, Grundpreis, Grundpauschale,
 *    Zusatzleistungen und die Preisregeln *dieser* Leistung (auf ihren
 *    eigenen Arbeitswert, mit ihrer eigenen Fläche geprüft);
 *  • **je Buchung:** Anfahrt, globale Preisregeln (auf den Gesamtwert, einmal),
 *    Express-Zuschlag, Frequenz- und Kundenrabatt, Gutschein, Mindest-
 *    auftragswert (der höchste der gebuchten Leistungen) und die MwSt.
 *
 * Mit genau einer Leistung ergibt das Zeile für Zeile dieselbe Herleitung wie
 * vorher — dieselben Schlüssel, dieselben Beschriftungen, dieselben Beträge.
 * Das ist die Rückwärtsverträglichkeit, auf die sich bestehende Buchungen,
 * Offerten und Prüfungen verlassen.
 *
 * Zwei Kombinationsregeln, beide aus einem Sachgrund und keine davon eine
 * Regelmaschine: Jede Leistung höchstens einmal (eine zweite Zeile derselben
 * Leistung wäre eine Mengenangabe, keine zweite Leistung), und alle Leistungen
 * mit demselben MwSt.-Satz (eine Buchung trägt genau einen Satz; zwei Sätze
 * auf einem Beleg verlangten eine Aufteilung der Rabatte, die es heute nicht
 * gibt — die Kundschaft bucht dann getrennt).
 */

/** Rabatt bei wiederkehrender Reinigung — Bindung lohnt sich für beide Seiten. */
const FREQUENCY_DISCOUNT: Record<Frequency, number> = {
  ONCE: 0,
  WEEKLY: 0.15,
  BIWEEKLY: 0.1,
  MONTHLY: 0.05,
  QUARTERLY: 0.03,
  SEMIANNUAL: 0,
  ANNUAL: 0,
  CUSTOM: 0,
};

const FREQUENCY_LABEL: Record<Frequency, string> = {
  ONCE: 'Einmalig',
  WEEKLY: 'Wöchentlich',
  BIWEEKLY: 'Alle zwei Wochen',
  MONTHLY: 'Monatlich',
  QUARTERLY: 'Vierteljährlich',
  SEMIANNUAL: 'Halbjährlich',
  ANNUAL: 'Jährlich',
  CUSTOM: 'Individuell',
};

/** Aufschlag für Express-Termine innerhalb von 48 Stunden. */
const URGENT_MULTIPLIER = 1.2;

/**
 * Höchstens so viele Leistungen je Buchung. Mehr ist in der Praxis ein
 * Rahmenauftrag und gehört in eine Offerte oder einen Vertrag, nicht in den
 * Buchungsassistenten.
 */
export const MAX_LEISTUNGEN = 5;

type ServiceMitRegeln = Service & { priceRules: PriceRule[] };

interface Posten {
  service: ServiceMitRegeln;
  eingabe: LeistungInput;
}

interface EngineData {
  posten: Posten[];
  extras: ServiceExtra[];
  travelFee: number;
  travelMinutes: number;
  globalRules: PriceRule[];
}

/** Die gemeinsamen Kombinationsregeln — vor jeder Datenbankabfrage. */
function pruefeAuswahl(leistungen: LeistungInput[]): void {
  if (leistungen.length === 0) {
    throw new BusinessRuleError('Bitte wählen Sie mindestens eine Dienstleistung.');
  }
  if (leistungen.length > MAX_LEISTUNGEN) {
    throw new BusinessRuleError(
      `Höchstens ${MAX_LEISTUNGEN} Leistungen je Buchung. Für umfangreichere Aufträge erstellen wir gerne eine Offerte.`,
    );
  }
  const ids = leistungen.map((l) => l.serviceId);
  if (new Set(ids).size !== ids.length) {
    throw new BusinessRuleError('Jede Dienstleistung lässt sich nur einmal pro Buchung wählen.');
  }
}

async function ladeLeistungen(leistungen: LeistungInput[], organizationId: string) {
  const ids = leistungen.map((l) => l.serviceId);
  const alleExtras = leistungen.flatMap((l) => l.extras.map((e) => e.extraId));
  const [services, extras] = await Promise.all([
    prisma.service.findMany({
      where: { id: { in: ids }, organizationId, active: true },
      include: { priceRules: { where: { active: true }, orderBy: { priority: 'asc' } } },
    }),
    alleExtras.length
      ? prisma.serviceExtra.findMany({
          where: { organizationId, active: true, id: { in: alleExtras } },
        })
      : Promise.resolve([]),
  ]);
  // Nicht gefunden heisst auch: fremde Organisation oder inaktiv. Die
  // Antwort unterscheidet das nicht — sie verrät nicht, ob es die ID anderswo gibt.
  const posten = leistungen.map((eingabe) => {
    const service = services.find((s) => s.id === eingabe.serviceId);
    if (!service) throw new NotFoundError('Dienstleistung');
    return { service, eingabe };
  });
  return { posten, extras };
}

async function loadData(input: BookingPriceInput, organizationId: string): Promise<EngineData> {
  pruefeAuswahl(input.leistungen);

  const [{ posten, extras }, area, globalRules] = await Promise.all([
    ladeLeistungen(input.leistungen, organizationId),
    input.postalCode
      ? prisma.serviceArea.findFirst({
          where: { organizationId, postalCode: input.postalCode, active: true },
        })
      : Promise.resolve(null),
    prisma.priceRule.findMany({
      where: { serviceId: null, active: true },
      orderBy: { priority: 'asc' },
    }),
  ]);

  if (input.postalCode && !area) {
    throw new BusinessRuleError(
      `Die Postleitzahl ${input.postalCode} liegt ausserhalb unseres Einsatzgebiets. Kontaktieren Sie uns für eine individuelle Offerte.`,
    );
  }

  return {
    posten,
    extras,
    travelFee: area ? toNumber(area.travelFee) : 0,
    travelMinutes: area?.travelMinutes ?? 0,
    globalRules,
  };
}

/** Einsatzdauer schätzen — Basis für Stundenpreis *und* Kapazitätsplanung. */
function estimateMinutes(service: Service, eingabe: LeistungInput, hasPets: boolean | undefined): number {
  if (eingabe.manualHours && eingabe.manualHours > 0) {
    return Math.round(eingabe.manualHours * 60);
  }

  const minutesPerSqm = toNumber(service.minutesPerSqm);
  let minutes = service.defaultDurationMin;

  if (eingabe.squareMeters && eingabe.squareMeters > 0 && minutesPerSqm > 0) {
    minutes = Math.round(eingabe.squareMeters * minutesPerSqm);
  } else if (eingabe.rooms && eingabe.rooms > 0) {
    // Fallback über Zimmerzahl: ca. 45 Minuten pro Zimmer.
    minutes = Math.round(eingabe.rooms * 45);
  }

  // Zusätzliche Bäder sind überproportional aufwendig.
  if (eingabe.bathrooms && eingabe.bathrooms > 1) {
    minutes += (eingabe.bathrooms - 1) * 25;
  }

  // Fensterreinigung rechnet nach Anzahl Fenster.
  if (service.kind === 'WINDOW_CLEANING' && eingabe.windows && eingabe.windows > 0) {
    minutes = eingabe.windows * 8;
  }

  if (hasPets) minutes = Math.round(minutes * 1.1);

  const minMinutes = Math.round(toNumber(service.minHours) * 60);
  return Math.max(minMinutes, minutes);
}

function crewFuer(service: Service, minuten: number): number {
  return Math.max(1, Math.min(service.defaultCrewSize, Math.ceil(minuten / 240)) || 1);
}

/** Minuten der Zusatzleistungen einer Leistung, mit derselben Mengenklammer wie der Preis. */
function extrasMinuten(eingabe: LeistungInput, extras: ServiceExtra[]): number {
  let summe = 0;
  for (const requested of eingabe.extras) {
    const extra = extras.find((e) => e.id === requested.extraId);
    if (!extra) continue;
    summe += extra.durationMin * Math.max(1, Math.min(50, Math.floor(requested.quantity)));
  }
  return summe;
}

interface RegelKontext {
  frequency: Frequency;
  propertyKind: PriceInput['propertyKind'];
  hasPets?: boolean;
  urgent?: boolean;
  squareMeters?: number | null;
  postalCode?: string | null;
  scheduledStart?: Date | null;
}

function evaluateCondition(condition: PriceRuleCondition, input: RegelKontext): boolean {
  if (condition.frequency && !condition.frequency.includes(input.frequency)) return false;
  if (condition.propertyKind && !condition.propertyKind.includes(input.propertyKind)) return false;
  if (condition.hasPets !== undefined && Boolean(input.hasPets) !== condition.hasPets) return false;
  if (condition.urgent !== undefined && Boolean(input.urgent) !== condition.urgent) return false;

  if (condition.minSqm !== undefined && (input.squareMeters ?? 0) < condition.minSqm) return false;
  if (condition.maxSqm !== undefined && (input.squareMeters ?? 0) > condition.maxSqm) return false;

  if (condition.postalCode && input.postalCode && !condition.postalCode.includes(input.postalCode)) {
    return false;
  }

  if (input.scheduledStart) {
    // Zeitbezogene Regeln immer in Schweizer Ortszeit auswerten.
    const local = new Date(
      input.scheduledStart.toLocaleString('en-US', { timeZone: 'Europe/Zurich' }),
    );
    if (condition.weekday && !condition.weekday.includes(local.getDay())) return false;
    if (condition.hourFrom !== undefined && local.getHours() < condition.hourFrom) return false;
    if (condition.hourTo !== undefined && local.getHours() > condition.hourTo) return false;
  } else if (condition.weekday || condition.hourFrom !== undefined || condition.hourTo !== undefined) {
    // Ohne Termin können zeitbezogene Regeln nicht greifen.
    return false;
  }

  return true;
}

/** Eine Buchung mit genau einer Leistung — die Form, die es vor 2026-09-26 allein gab. */
export function alsBuchungseingabe(input: PriceInput): BookingPriceInput {
  const { serviceId, squareMeters, rooms, bathrooms, windows, manualHours, extras, ...gemeinsam } = input;
  return {
    ...gemeinsam,
    leistungen: [{ serviceId, squareMeters, rooms, bathrooms, windows, manualHours, extras }],
  };
}

/** Preis für genau eine Leistung. Unverändert in Signatur und Ergebnis. */
export async function calculatePrice(
  input: PriceInput,
  organizationId: string,
): Promise<PriceBreakdown> {
  return calculateBookingPrice(alsBuchungseingabe(input), organizationId);
}

/**
 * Dauer, Teamgrösse und Puffer einer Auswahl — ohne Preis.
 *
 * Für die Verfügbarkeit: Der Terminwähler braucht die Dauer der ganzen
 * Auswahl, bevor es eine Postleitzahl oder einen Gutschein gibt. Die Rechnung
 * ist dieselbe wie im Preis (`estimateMinutes`, `crewFuer`, Zusatzminuten),
 * damit die angebotenen Zeitfenster genau zu der Dauer passen, die die Buchung
 * danach speichert — die Abweichung zwischen beiden war die Ursache dafür,
 * dass ein dreistündiger Einsatz um 20 Uhr angeboten wurde.
 */
export async function estimateBookingEffort(
  input: { leistungen: LeistungInput[]; hasPets?: boolean },
  organizationId: string,
): Promise<{ durationMinutes: number; crewSize: number; bufferMinutes: number }> {
  pruefeAuswahl(input.leistungen);
  const { posten, extras } = await ladeLeistungen(input.leistungen, organizationId);
  let dauer = 0;
  let crew = 1;
  let puffer = 0;
  for (const p of posten) {
    const minuten = estimateMinutes(p.service, p.eingabe, input.hasPets);
    dauer += minuten + extrasMinuten(p.eingabe, extras);
    crew = Math.max(crew, crewFuer(p.service, minuten));
    puffer = Math.max(puffer, p.service.bufferMinutes);
  }
  return { durationMinutes: dauer, crewSize: crew, bufferMinutes: puffer };
}

export async function calculateBookingPrice(
  input: BookingPriceInput,
  organizationId: string,
): Promise<PriceBreakdown> {
  const { posten, extras, travelFee, travelMinutes, globalRules } = await loadData(input, organizationId);
  const mehrere = posten.length > 1;

  const lines: PriceLine[] = [];
  const notes: string[] = [];
  const appliedRules: PriceBreakdown['appliedRules'] = [];

  // Dauer und Team je Leistung zuerst — auch eine Leistung „auf Anfrage"
  // braucht sie für die Planung.
  const grund = posten.map((p) => {
    const minuten = estimateMinutes(p.service, p.eingabe, input.hasPets);
    return { minuten, crew: crewFuer(p.service, minuten), laborHours: round2(minuten / 60) };
  });
  const erste = posten[0]!.service;
  const serviceKopf = { id: erste.id, name: erste.name, kind: erste.kind, pricingModel: erste.pricingModel };

  const positionOhnePreis = (p: Posten, i: number, onRequest: boolean): PricePosition => ({
    serviceId: p.service.id,
    name: p.service.name,
    kind: p.service.kind,
    pricingModel: p.service.pricingModel,
    durationMinutes: grund[i]!.minuten + extrasMinuten(p.eingabe, extras),
    crewSize: grund[i]!.crew,
    subtotal: 0,
    extrasTotal: 0,
    bufferMinutes: p.service.bufferMinutes,
    onRequest,
  });

  // --- Auf Anfrage ----------------------------------------------------------
  const aufAnfrage = posten.filter((p) => p.service.pricingModel === 'ON_REQUEST');
  if (aufAnfrage.length > 0) {
    // Kein verbindlicher Preis — die Offerte wird manuell erstellt. Eine
    // einzige Leistung „auf Anfrage" genügt: Ein Teilpreis für den Rest wäre
    // eine Zahl, auf die sich niemand verlassen kann.
    return {
      service: serviceKopf,
      positionen: posten.map((p, i) => positionOhnePreis(p, i, p.service.pricingModel === 'ON_REQUEST')),
      lines: [],
      // Mit einer Leistung wie seit jeher ohne Zusatzminuten; mit mehreren die
      // Summe dessen, was der Terminwähler auch rechnet.
      durationMinutes: mehrere
        ? posten.reduce((s, p, i) => s + positionOhnePreis(p, i, false).durationMinutes, 0)
        : grund[0]!.minuten,
      bufferMinutes: Math.max(...posten.map((p) => p.service.bufferMinutes)),
      crewSize: Math.max(...grund.map((g) => g.crew)),
      laborHours: round2(grund.reduce((s, g) => s + g.minuten, 0) / 60),
      subtotal: 0,
      extrasTotal: 0,
      travelFee: 0,
      surchargeTotal: 0,
      discountTotal: 0,
      netTotal: 0,
      vatRate: toNumber(erste.vatRate),
      vatAmount: 0,
      grossTotal: 0,
      currency: 'CHF',
      onRequest: true,
      coupon: null,
      notes: [
        mehrere
          ? `${aufAnfrage.map((p) => p.service.name).join(', ')} wird individuell offeriert. Wir melden uns innerhalb von 24 Stunden mit einem verbindlichen Angebot für die ganze Auswahl.`
          : 'Diese Dienstleistung wird individuell offeriert. Wir melden uns innerhalb von 24 Stunden mit einem verbindlichen Angebot.',
      ],
      appliedRules: [],
    };
  }

  // --- MwSt.: ein Satz je Buchung -------------------------------------------
  const saetze = new Set(posten.map((p) => toNumber(p.service.vatRate)));
  if (saetze.size > 1) {
    throw new BusinessRuleError(
      'Diese Leistungen haben unterschiedliche Mehrwertsteuersätze und lassen sich nicht in einer Buchung zusammenfassen. Bitte buchen Sie sie getrennt.',
    );
  }

  // --- 1) + 2) Grundpreis und Zusatzleistungen je Leistung -------------------
  let subtotal = 0;
  let extrasTotal = 0;
  let extrasMinutesTotal = 0;
  const positionen: PricePosition[] = [];
  const arbeitswerte: number[] = [];

  posten.forEach((p, index) => {
    const { service, eingabe } = p;
    const { minuten, laborHours } = grund[index]!;
    // Mit einer Leistung bleiben die Schlüssel, wie sie immer waren; mit
    // mehreren bekommen sie die Position angehängt, damit sie eindeutig sind.
    const k = (key: string) => (mehrere ? `${key}@${index}` : key);
    const meta = { serviceId: service.id };
    const basePrice = toNumber(service.basePrice);
    let postenSubtotal = 0;

    switch (service.pricingModel) {
      case 'PER_HOUR': {
        const rate = toNumber(service.hourlyRate);
        // Dezimal (Phase 25): 30.15 × 1.5 ergab binär 45.22 statt 45.23.
        const amount = produkt(rate, laborHours);
        lines.push({ key: k('labor'), label: `${service.name} · ${laborHours.toFixed(2)} Std.`, quantity: laborHours, unit: 'Std.', unitPrice: rate, amount, kind: 'base', meta });
        postenSubtotal = summeZahl(postenSubtotal, amount);
        break;
      }
      case 'PER_SQM': {
        const sqm = eingabe.squareMeters ?? 0;
        if (sqm <= 0) {
          throw new BusinessRuleError(
            mehrere
              ? `Für ${service.name} ist die Fläche in m² erforderlich.`
              : 'Für diese Dienstleistung ist die Fläche in m² erforderlich.',
          );
        }
        const rate = toNumber(service.pricePerSqm);
        const amount = produkt(rate, sqm);
        lines.push({ key: k('area'), label: `${service.name} · ${sqm} m²`, quantity: sqm, unit: 'm²', unitPrice: rate, amount, kind: 'base', meta });
        postenSubtotal = summeZahl(postenSubtotal, amount);
        break;
      }
      case 'PER_UNIT': {
        const units = eingabe.windows ?? eingabe.rooms ?? 1;
        const rate = toNumber(service.hourlyRate) || basePrice;
        const amount = produkt(rate, units);
        lines.push({ key: k('units'), label: `${service.name} · ${units} Einheiten`, quantity: units, unit: 'Stk.', unitPrice: rate, amount, kind: 'base', meta });
        postenSubtotal = summeZahl(postenSubtotal, amount);
        break;
      }
      case 'FLAT':
      default: {
        lines.push({ key: k('flat'), label: `${service.name} · Pauschale`, quantity: 1, unit: 'Pauschal', unitPrice: basePrice, amount: basePrice, kind: 'base', meta });
        postenSubtotal = summeZahl(postenSubtotal, basePrice);
        break;
      }
    }

    // Grundpauschale zusätzlich zum variablen Anteil (z. B. Anrückpauschale).
    if (service.pricingModel !== 'FLAT' && basePrice > 0) {
      lines.push({
        key: k('base-fee'),
        label: mehrere ? `Grundpauschale · ${service.name}` : 'Grundpauschale',
        quantity: 1,
        unit: 'Pauschal',
        unitPrice: basePrice,
        amount: basePrice,
        kind: 'base',
        meta,
      });
      postenSubtotal = summeZahl(postenSubtotal, basePrice);
    }

    let postenExtras = 0;
    let postenExtrasMinuten = 0;
    for (const requested of eingabe.extras) {
      const extra = extras.find((e) => e.id === requested.extraId);
      if (!extra) continue;
      const quantity = Math.max(1, Math.min(50, Math.floor(requested.quantity)));
      const unitPrice = toNumber(extra.price);
      const amount = produkt(unitPrice, quantity);
      lines.push({
        key: k(`extra:${extra.slug}`),
        label: extra.name,
        quantity,
        unit: 'Stk.',
        unitPrice,
        amount,
        kind: 'extra',
        meta: { extraId: extra.id, serviceId: service.id },
      });
      postenExtras = summeZahl(postenExtras, amount);
      postenExtrasMinuten += extra.durationMin * quantity;
    }

    subtotal = summeZahl(subtotal, postenSubtotal);
    extrasTotal = summeZahl(extrasTotal, postenExtras);
    extrasMinutesTotal += postenExtrasMinuten;
    arbeitswerte.push(summeZahl(postenSubtotal, postenExtras));
    positionen.push({
      serviceId: service.id,
      name: service.name,
      kind: service.kind,
      pricingModel: service.pricingModel,
      durationMinutes: minuten + postenExtrasMinuten,
      crewSize: grund[index]!.crew,
      subtotal: round2(postenSubtotal),
      extrasTotal: round2(postenExtras),
      bufferMinutes: service.bufferMinutes,
      onRequest: false,
    });
  });

  // --- 3) Anfahrt — einmal je Buchung ---------------------------------------
  if (travelFee > 0) {
    lines.push({
      key: 'travel',
      label: `Anfahrt ${input.postalCode ?? ''}`.trim(),
      quantity: 1,
      unit: 'Pauschal',
      unitPrice: travelFee,
      amount: travelFee,
      kind: 'travel',
      meta: { travelMinutes },
    });
  }

  // --- 4) Preisregeln -------------------------------------------------------
  const workingBase = summeZahl(subtotal, extrasTotal);
  let surchargeTotal = 0;

  const flaechen = posten.map((p) => p.eingabe.squareMeters ?? 0).filter((f) => f > 0);
  const gemeinsam: RegelKontext = {
    frequency: input.frequency,
    propertyKind: input.propertyKind,
    hasPets: input.hasPets,
    urgent: input.urgent,
    postalCode: input.postalCode,
    scheduledStart: input.scheduledStart,
    // Für globale Regeln (`minSqm`) zählt die grösste angegebene Fläche — sie
    // beschreibt das Objekt, und bei einer Leistung ist es genau deren Fläche.
    squareMeters: flaechen.length ? Math.max(...flaechen) : null,
  };

  /**
   * Die Regeln einer Leistung wirken auf deren Arbeitswert, die globalen auf
   * den Gesamtwert — einmal. Sortiert wird über alle gemeinsam nach
   * Priorität, stabil in der Reihenfolge „Leistungsregeln, dann globale",
   * wie früher `[...service.priceRules, ...globalRules]`.
   */
  const regeln = [
    ...posten.flatMap((p, i) =>
      p.service.priceRules.map((rule) => ({
        rule,
        basis: arbeitswerte[i]!,
        kontext: { ...gemeinsam, squareMeters: p.eingabe.squareMeters },
      })),
    ),
    ...globalRules.map((rule) => ({ rule, basis: workingBase, kontext: gemeinsam })),
  ].sort((a, b) => a.rule.priority - b.rule.priority);

  for (const { rule, basis, kontext } of regeln) {
    const condition = (rule.condition ?? {}) as PriceRuleCondition;
    if (!evaluateCondition(condition, kontext)) continue;

    const multiplier = toNumber(rule.multiplier);
    const flat = toNumber(rule.surcharge);
    // Der Faktor dezimal: `multiplier - 1` wäre bei 1.15 binär 0.1499999…
    const multiplierAmount = aufRappen(geld(basis).times(geld(rule.multiplier).minus(1))).toNumber();
    const amount = summeZahl(multiplierAmount, flat);
    if (amount === 0) continue;

    lines.push({
      key: `rule:${rule.id}`,
      label: rule.name,
      quantity: 1,
      unit: 'Pauschal',
      unitPrice: amount,
      amount,
      kind: amount >= 0 ? 'surcharge' : 'discount',
      meta: { multiplier, flat },
    });

    surchargeTotal = summeZahl(surchargeTotal, amount);
    appliedRules.push({ name: rule.name, multiplier, surcharge: flat });
  }

  // Express-Aufschlag, falls nicht bereits über eine Regel abgedeckt.
  if (input.urgent && !regeln.some((r) => (r.rule.condition as PriceRuleCondition)?.urgent)) {
    const amount = aufRappen(geld(workingBase).times(geld(URGENT_MULTIPLIER).minus(1))).toNumber();
    lines.push({
      key: 'urgent',
      label: 'Express-Zuschlag (Termin innert 48 Std.)',
      quantity: 1,
      unit: 'Pauschal',
      unitPrice: amount,
      amount,
      kind: 'surcharge',
    });
    surchargeTotal = summeZahl(surchargeTotal, amount);
    appliedRules.push({ name: 'Express-Zuschlag', multiplier: URGENT_MULTIPLIER, surcharge: 0 });
  }

  // --- 5) Frequenzrabatt ----------------------------------------------------
  let discountTotal = 0;
  const frequencyRate = FREQUENCY_DISCOUNT[input.frequency] ?? 0;

  if (frequencyRate > 0) {
    const amount = -produkt(summeZahl(workingBase, surchargeTotal), frequencyRate);
    lines.push({
      key: 'frequency-discount',
      label: `Abo-Rabatt · ${FREQUENCY_LABEL[input.frequency]} (${Math.round(frequencyRate * 100)} %)`,
      quantity: 1,
      unit: 'Pauschal',
      unitPrice: amount,
      amount,
      kind: 'discount',
    });
    discountTotal = summeZahl(discountTotal, amount);
    notes.push(
      `Sie sparen ${Math.round(frequencyRate * 100)} % dank wiederkehrender Reinigung. Jederzeit kündbar.`,
    );
  }

  // --- 6) Kundenrabatt & Gutschein -----------------------------------------
  const customerDiscount = input.customerDiscountPercent ?? 0;
  if (customerDiscount > 0) {
    const amount = -prozentVon(summeZahl(workingBase, surchargeTotal), customerDiscount);
    lines.push({
      key: 'customer-discount',
      label: `Stammkundenrabatt (${customerDiscount} %)`,
      quantity: 1,
      unit: 'Pauschal',
      unitPrice: amount,
      amount,
      kind: 'discount',
    });
    discountTotal = summeZahl(discountTotal, amount);
  }

  // Das Ergebnis der Prüfung wandert als eigenes Feld in die Herleitung, nicht
  // als Hinweistext: Früher stand „ungültig" nur in `notes`, das Formular
  // zeigte daneben dauerhaft „Wird geprüft" und der Abschluss buchte still
  // zum vollen Preis. Wer einen Code eingibt, muss wissen, ob er gilt — und
  // eine Buchung mit ungültigem Code darf nicht durchgehen.
  const couponCheck = input.couponCode
    ? await checkCoupon({
        organizationId,
        code: input.couponCode,
        serviceKinds: posten.map((p) => p.service.kind),
        orderValue: summeZahl(workingBase, surchargeTotal),
        beforeCoupon: summeZahl(workingBase, surchargeTotal, discountTotal),
        customer: input.customer ?? null,
      })
    : null;

  if (couponCheck?.status === 'APPLIED') {
    lines.push({
      key: 'coupon',
      label: `Gutschein ${couponCheck.code}`,
      quantity: 1,
      unit: 'Pauschal',
      unitPrice: -couponCheck.amount,
      amount: -couponCheck.amount,
      kind: 'discount',
      meta: { couponId: couponCheck.couponId },
    });
    discountTotal = summeZahl(discountTotal, -couponCheck.amount);
  }

  // --- 7) Totale, Mindestpreis, MwSt. --------------------------------------
  let netTotal = summeZahl(workingBase, travelFee, surchargeTotal, discountTotal);

  // Der Mindestauftragswert gilt je Auftrag, nicht je Leistung: Es gilt der
  // höchste der gebuchten Leistungen.
  const minPrice = Math.max(...posten.map((p) => toNumber(p.service.minPrice)));
  if (minPrice > 0 && netTotal < minPrice) {
    const adjustment = summeZahl(minPrice, -netTotal);
    lines.push({
      key: 'min-price',
      label: `Mindestauftragswert CHF ${minPrice.toFixed(2)}`,
      quantity: 1,
      unit: 'Pauschal',
      unitPrice: adjustment,
      amount: adjustment,
      kind: 'surcharge',
    });
    surchargeTotal = summeZahl(surchargeTotal, adjustment);
    netTotal = minPrice;
    notes.push(`Es gilt ein Mindestauftragswert von CHF ${minPrice.toFixed(2)}.`);
  }

  netTotal = Math.max(0, netTotal);
  const vatRate = toNumber(erste.vatRate);
  const vatAmount = prozentVon(netTotal, vatRate);
  const grossTotal = summeZahl(netTotal, vatAmount);

  if (travelMinutes > 0) {
    notes.push(`Anfahrtszeit ca. ${travelMinutes} Minuten ab unserem Standort in Bern.`);
  }
  if (mehrere) {
    notes.push('Die Leistungen werden nacheinander vom selben Team ausgeführt; die Dauer ist ihre Summe.');
  }

  return {
    service: serviceKopf,
    positionen,
    lines,
    durationMinutes: grund.reduce((s, g) => s + g.minuten, 0) + extrasMinutesTotal,
    bufferMinutes: Math.max(...posten.map((p) => p.service.bufferMinutes)),
    crewSize: Math.max(...grund.map((g) => g.crew)),
    laborHours: round2(grund.reduce((s, g) => s + g.minuten, 0) / 60),
    subtotal: round2(subtotal),
    extrasTotal: round2(extrasTotal),
    travelFee: round2(travelFee),
    surchargeTotal: round2(surchargeTotal),
    discountTotal: round2(discountTotal),
    netTotal,
    vatRate,
    vatAmount,
    grossTotal,
    currency: 'CHF',
    onRequest: false,
    coupon: couponCheck
      ? {
          code: couponCheck.code,
          status: couponCheck.status,
          message: couponCheck.message,
          amount: couponCheck.amount,
        }
      : null,
    notes,
    appliedRules,
  };
}

/**
 * Prüft einen Gutscheincode gegen alle Bedingungen des Datensatzes.
 *
 * Reihenfolge der Prüfungen ist die der Wahrscheinlichkeit einer Ablehnung:
 * Tippfehler zuerst, dann Kontingent, dann Auftragsbedingungen, zuletzt die
 * kundenbezogenen Regeln. So sieht die Kundschaft die *nächstliegende*
 * Begründung, nicht die zufällig erste.
 *
 * `firstOrderOnly` und `perCustomerLimit` lassen sich nur mit bekannter
 * Kundschaft prüfen. Bei der anonymen Sofortschätzung gelten sie als erfüllt;
 * der Buchungsabschluss kennt die Kundschaft immer und holt die Prüfung nach.
 *
 * Ein auf Leistungsarten beschränkter Gutschein gilt bei mehreren Leistungen
 * nur, wenn **jede** gebuchte Leistung dazugehört. Der Rabatt wirkt auf den
 * ganzen Auftrag; ein Gutschein für Fensterreinigung, der eine beigefügte
 * Umzugsreinigung mitverbilligt, wäre ein anderer Gutschein als der, den
 * jemand angelegt hat.
 */
async function checkCoupon(params: {
  organizationId: string;
  code: string;
  serviceKinds: ServiceKind[];
  orderValue: number;
  beforeCoupon: number;
  customer: { id: string; totalBookings: number } | null;
}): Promise<CouponCheck & { couponId: string | null }> {
  const code = params.code.toUpperCase().trim();
  const reject = (status: CouponCheck['status'], message: string) => ({
    code,
    status,
    message,
    amount: 0,
    couponId: null,
  });

  const coupon = await prisma.coupon.findFirst({
    where: {
      organizationId: params.organizationId,
      code,
      status: 'ACTIVE',
      validFrom: { lte: new Date() },
      OR: [{ validUntil: null }, { validUntil: { gte: new Date() } }],
    },
  });

  if (!coupon) {
    return reject('INVALID', 'Dieser Gutscheincode ist ungültig oder abgelaufen.');
  }
  if (coupon.usageLimit !== null && coupon.usageCount >= coupon.usageLimit) {
    return reject('EXHAUSTED', 'Dieser Gutscheincode wurde bereits vollständig eingelöst.');
  }
  if (params.orderValue < toNumber(coupon.minOrderValue)) {
    return reject(
      'MIN_ORDER',
      `Der Gutschein gilt ab einem Auftragswert von CHF ${toNumber(coupon.minOrderValue).toFixed(2)}.`,
    );
  }
  if (
    coupon.serviceKinds.length > 0 &&
    !params.serviceKinds.every((kind) => coupon.serviceKinds.includes(kind))
  ) {
    return reject(
      'NOT_APPLICABLE',
      params.serviceKinds.length > 1
        ? 'Dieser Gutschein gilt nicht für alle gewählten Dienstleistungen.'
        : 'Dieser Gutschein gilt nicht für die gewählte Dienstleistung.',
    );
  }
  if (params.customer) {
    if (coupon.firstOrderOnly && params.customer.totalBookings > 0) {
      return reject('FIRST_ORDER_ONLY', 'Dieser Gutschein gilt nur für die erste Buchung.');
    }
    // Stornierte Buchungen zählen nicht: Wer storniert, hat den Rabatt nicht
    // erhalten und darf ihn beim zweiten Anlauf wieder einsetzen.
    const redeemed = await prisma.booking.count({
      where: {
        organizationId: params.organizationId,
        customerId: params.customer.id,
        // Ohne Rücksicht auf die Schreibweise: Buchungen vor 2026-09-28
        // speicherten den Code, wie er getippt war.
        couponCode: { equals: code, mode: 'insensitive' },
        status: { not: 'CANCELLED' },
      },
    });
    if (redeemed >= coupon.perCustomerLimit) {
      return reject(
        'PER_CUSTOMER_LIMIT',
        coupon.perCustomerLimit === 1
          ? 'Sie haben diesen Gutschein bereits eingelöst.'
          : `Dieser Gutschein lässt sich höchstens ${coupon.perCustomerLimit}× pro Kundschaft einlösen.`,
      );
    }
  }

  let amount =
    coupon.discountType === 'PERCENT'
      ? prozentVon(params.beforeCoupon, coupon.discountValue)
      : toNumber(coupon.discountValue);

  const maxDiscount = coupon.maxDiscount ? toNumber(coupon.maxDiscount) : null;
  if (maxDiscount !== null) amount = Math.min(amount, maxDiscount);
  amount = round2(Math.min(amount, params.beforeCoupon));

  return {
    code,
    status: 'APPLIED',
    message: coupon.description ?? `Gutschein ${code} eingelöst.`,
    amount,
    couponId: coupon.id,
  };
}

export { FREQUENCY_DISCOUNT, FREQUENCY_LABEL };
