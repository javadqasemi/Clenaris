import 'server-only';

import type { Frequency, PriceRule, Service, ServiceExtra } from '@prisma/client';

import { prisma, toNumber } from '@/lib/db';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { round2 } from '@/lib/utils';
import type { PriceBreakdown, PriceInput, PriceLine, PriceRuleCondition } from './types';

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
 *   1. Grundpreis nach Preismodell (Stunden / m² / Pauschale)
 *   2. Zusatzleistungen
 *   3. Anfahrtspauschale nach PLZ
 *   4. Preisregeln (Multiplikatoren + Fixzuschläge, nach Priorität)
 *   5. Frequenzrabatt
 *   6. Gutschein & Kundenrabatt
 *   7. Mindestpreis, MwSt., Rundung
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

interface EngineData {
  service: Service & { priceRules: PriceRule[] };
  extras: ServiceExtra[];
  travelFee: number;
  travelMinutes: number;
  globalRules: PriceRule[];
}

async function loadData(input: PriceInput, organizationId: string): Promise<EngineData> {
  const [service, extras, area, globalRules] = await Promise.all([
    prisma.service.findFirst({
      where: { id: input.serviceId, organizationId, active: true },
      include: { priceRules: { where: { active: true }, orderBy: { priority: 'asc' } } },
    }),
    input.extras.length
      ? prisma.serviceExtra.findMany({
          where: {
            organizationId,
            active: true,
            id: { in: input.extras.map((e) => e.extraId) },
          },
        })
      : Promise.resolve([]),
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

  if (!service) throw new NotFoundError('Dienstleistung');

  if (input.postalCode && !area) {
    throw new BusinessRuleError(
      `Die Postleitzahl ${input.postalCode} liegt ausserhalb unseres Einsatzgebiets. Kontaktieren Sie uns für eine individuelle Offerte.`,
    );
  }

  return {
    service,
    extras,
    travelFee: area ? toNumber(area.travelFee) : 0,
    travelMinutes: area?.travelMinutes ?? 0,
    globalRules,
  };
}

/** Einsatzdauer schätzen — Basis für Stundenpreis *und* Kapazitätsplanung. */
function estimateMinutes(service: Service, input: PriceInput): number {
  if (input.manualHours && input.manualHours > 0) {
    return Math.round(input.manualHours * 60);
  }

  const minutesPerSqm = toNumber(service.minutesPerSqm);
  let minutes = service.defaultDurationMin;

  if (input.squareMeters && input.squareMeters > 0 && minutesPerSqm > 0) {
    minutes = Math.round(input.squareMeters * minutesPerSqm);
  } else if (input.rooms && input.rooms > 0) {
    // Fallback über Zimmerzahl: ca. 45 Minuten pro Zimmer.
    minutes = Math.round(input.rooms * 45);
  }

  // Zusätzliche Bäder sind überproportional aufwendig.
  if (input.bathrooms && input.bathrooms > 1) {
    minutes += (input.bathrooms - 1) * 25;
  }

  // Fensterreinigung rechnet nach Anzahl Fenster.
  if (service.kind === 'WINDOW_CLEANING' && input.windows && input.windows > 0) {
    minutes = input.windows * 8;
  }

  if (input.hasPets) minutes = Math.round(minutes * 1.1);

  const minMinutes = Math.round(toNumber(service.minHours) * 60);
  return Math.max(minMinutes, minutes);
}

function evaluateCondition(condition: PriceRuleCondition, input: PriceInput): boolean {
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

export async function calculatePrice(
  input: PriceInput,
  organizationId: string,
): Promise<PriceBreakdown> {
  const { service, extras, travelFee, travelMinutes, globalRules } = await loadData(
    input,
    organizationId,
  );

  const lines: PriceLine[] = [];
  const notes: string[] = [];
  const appliedRules: PriceBreakdown['appliedRules'] = [];

  const durationMinutes = estimateMinutes(service, input);
  const crewSize = Math.max(
    1,
    Math.min(service.defaultCrewSize, Math.ceil(durationMinutes / 240)) || 1,
  );
  const laborHours = round2(durationMinutes / 60);

  // --- 1) Grundpreis --------------------------------------------------------
  let subtotal = 0;
  const basePrice = toNumber(service.basePrice);

  switch (service.pricingModel) {
    case 'PER_HOUR': {
      const rate = toNumber(service.hourlyRate);
      const amount = round2(rate * laborHours);
      lines.push({
        key: 'labor',
        label: `${service.name} · ${laborHours.toFixed(2)} Std.`,
        quantity: laborHours,
        unit: 'Std.',
        unitPrice: rate,
        amount,
        kind: 'base',
      });
      subtotal += amount;
      break;
    }

    case 'PER_SQM': {
      const sqm = input.squareMeters ?? 0;
      if (sqm <= 0) {
        throw new BusinessRuleError('Für diese Dienstleistung ist die Fläche in m² erforderlich.');
      }
      const rate = toNumber(service.pricePerSqm);
      const amount = round2(rate * sqm);
      lines.push({
        key: 'area',
        label: `${service.name} · ${sqm} m²`,
        quantity: sqm,
        unit: 'm²',
        unitPrice: rate,
        amount,
        kind: 'base',
      });
      subtotal += amount;
      break;
    }

    case 'PER_UNIT': {
      const units = input.windows ?? input.rooms ?? 1;
      const rate = toNumber(service.hourlyRate) || basePrice;
      const amount = round2(rate * units);
      lines.push({
        key: 'units',
        label: `${service.name} · ${units} Einheiten`,
        quantity: units,
        unit: 'Stk.',
        unitPrice: rate,
        amount,
        kind: 'base',
      });
      subtotal += amount;
      break;
    }

    case 'FLAT': {
      lines.push({
        key: 'flat',
        label: `${service.name} · Pauschale`,
        quantity: 1,
        unit: 'Pauschal',
        unitPrice: basePrice,
        amount: basePrice,
        kind: 'base',
      });
      subtotal += basePrice;
      break;
    }

    case 'ON_REQUEST':
    default: {
      // Kein verbindlicher Preis — die Offerte wird manuell erstellt.
      return {
        service: {
          id: service.id,
          name: service.name,
          kind: service.kind,
          pricingModel: service.pricingModel,
        },
        lines: [],
        durationMinutes,
        crewSize,
        laborHours,
        subtotal: 0,
        extrasTotal: 0,
        travelFee: 0,
        surchargeTotal: 0,
        discountTotal: 0,
        netTotal: 0,
        vatRate: toNumber(service.vatRate),
        vatAmount: 0,
        grossTotal: 0,
        currency: 'CHF',
        onRequest: true,
        notes: [
          'Diese Dienstleistung wird individuell offeriert. Wir melden uns innerhalb von 24 Stunden mit einem verbindlichen Angebot.',
        ],
        appliedRules: [],
      };
    }
  }

  // Grundpauschale zusätzlich zum variablen Anteil (z. B. Anrückpauschale).
  if (service.pricingModel !== 'FLAT' && basePrice > 0) {
    lines.push({
      key: 'base-fee',
      label: 'Grundpauschale',
      quantity: 1,
      unit: 'Pauschal',
      unitPrice: basePrice,
      amount: basePrice,
      kind: 'base',
    });
    subtotal += basePrice;
  }

  // --- 2) Zusatzleistungen --------------------------------------------------
  let extrasTotal = 0;
  let extrasMinutes = 0;

  for (const requested of input.extras) {
    const extra = extras.find((e) => e.id === requested.extraId);
    if (!extra) continue;
    const quantity = Math.max(1, Math.min(50, Math.floor(requested.quantity)));
    const unitPrice = toNumber(extra.price);
    const amount = round2(unitPrice * quantity);

    lines.push({
      key: `extra:${extra.slug}`,
      label: extra.name,
      quantity,
      unit: 'Stk.',
      unitPrice,
      amount,
      kind: 'extra',
      meta: { extraId: extra.id },
    });

    extrasTotal += amount;
    extrasMinutes += extra.durationMin * quantity;
  }

  // --- 3) Anfahrt -----------------------------------------------------------
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
  const workingBase = subtotal + extrasTotal;
  let surchargeTotal = 0;

  const rules = [...service.priceRules, ...globalRules].sort((a, b) => a.priority - b.priority);

  for (const rule of rules) {
    const condition = (rule.condition ?? {}) as PriceRuleCondition;
    if (!evaluateCondition(condition, input)) continue;

    const multiplier = toNumber(rule.multiplier);
    const flat = toNumber(rule.surcharge);
    const multiplierAmount = round2(workingBase * (multiplier - 1));
    const amount = round2(multiplierAmount + flat);
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

    surchargeTotal += amount;
    appliedRules.push({ name: rule.name, multiplier, surcharge: flat });
  }

  // Express-Aufschlag, falls nicht bereits über eine Regel abgedeckt.
  if (input.urgent && !rules.some((r) => (r.condition as PriceRuleCondition)?.urgent)) {
    const amount = round2(workingBase * (URGENT_MULTIPLIER - 1));
    lines.push({
      key: 'urgent',
      label: 'Express-Zuschlag (Termin innert 48 Std.)',
      quantity: 1,
      unit: 'Pauschal',
      unitPrice: amount,
      amount,
      kind: 'surcharge',
    });
    surchargeTotal += amount;
    appliedRules.push({ name: 'Express-Zuschlag', multiplier: URGENT_MULTIPLIER, surcharge: 0 });
  }

  // --- 5) Frequenzrabatt ----------------------------------------------------
  let discountTotal = 0;
  const frequencyRate = FREQUENCY_DISCOUNT[input.frequency] ?? 0;

  if (frequencyRate > 0) {
    const amount = -round2((workingBase + surchargeTotal) * frequencyRate);
    lines.push({
      key: 'frequency-discount',
      label: `Abo-Rabatt · ${FREQUENCY_LABEL[input.frequency]} (${Math.round(frequencyRate * 100)} %)`,
      quantity: 1,
      unit: 'Pauschal',
      unitPrice: amount,
      amount,
      kind: 'discount',
    });
    discountTotal += amount;
    notes.push(
      `Sie sparen ${Math.round(frequencyRate * 100)} % dank wiederkehrender Reinigung. Jederzeit kündbar.`,
    );
  }

  // --- 6) Kundenrabatt & Gutschein -----------------------------------------
  const customerDiscount = input.customerDiscountPercent ?? 0;
  if (customerDiscount > 0) {
    const amount = -round2((workingBase + surchargeTotal) * (customerDiscount / 100));
    lines.push({
      key: 'customer-discount',
      label: `Stammkundenrabatt (${customerDiscount} %)`,
      quantity: 1,
      unit: 'Pauschal',
      unitPrice: amount,
      amount,
      kind: 'discount',
    });
    discountTotal += amount;
  }

  if (input.couponCode) {
    const coupon = await prisma.coupon.findFirst({
      where: {
        organizationId,
        code: input.couponCode.toUpperCase().trim(),
        status: 'ACTIVE',
        validFrom: { lte: new Date() },
        OR: [{ validUntil: null }, { validUntil: { gte: new Date() } }],
      },
    });

    if (!coupon) {
      notes.push('Der eingegebene Gutscheincode ist ungültig oder abgelaufen.');
    } else if (coupon.usageLimit !== null && coupon.usageCount >= coupon.usageLimit) {
      notes.push('Dieser Gutscheincode wurde bereits vollständig eingelöst.');
    } else if (workingBase + surchargeTotal < toNumber(coupon.minOrderValue)) {
      notes.push(
        `Der Gutschein gilt ab einem Auftragswert von CHF ${toNumber(coupon.minOrderValue).toFixed(2)}.`,
      );
    } else if (coupon.serviceKinds.length > 0 && !coupon.serviceKinds.includes(service.kind)) {
      notes.push('Dieser Gutschein gilt nicht für die gewählte Dienstleistung.');
    } else {
      const beforeCoupon = workingBase + surchargeTotal + discountTotal;
      let amount =
        coupon.discountType === 'PERCENT'
          ? round2(beforeCoupon * (toNumber(coupon.discountValue) / 100))
          : toNumber(coupon.discountValue);

      const maxDiscount = coupon.maxDiscount ? toNumber(coupon.maxDiscount) : null;
      if (maxDiscount !== null) amount = Math.min(amount, maxDiscount);
      amount = Math.min(amount, beforeCoupon);

      lines.push({
        key: 'coupon',
        label: `Gutschein ${coupon.code}`,
        quantity: 1,
        unit: 'Pauschal',
        unitPrice: -amount,
        amount: -amount,
        kind: 'discount',
        meta: { couponId: coupon.id },
      });
      discountTotal -= amount;
    }
  }

  // --- 7) Totale, Mindestpreis, MwSt. --------------------------------------
  let netTotal = round2(workingBase + travelFee + surchargeTotal + discountTotal);

  const minPrice = toNumber(service.minPrice);
  if (minPrice > 0 && netTotal < minPrice) {
    const adjustment = round2(minPrice - netTotal);
    lines.push({
      key: 'min-price',
      label: `Mindestauftragswert CHF ${minPrice.toFixed(2)}`,
      quantity: 1,
      unit: 'Pauschal',
      unitPrice: adjustment,
      amount: adjustment,
      kind: 'surcharge',
    });
    surchargeTotal += adjustment;
    netTotal = minPrice;
    notes.push(`Es gilt ein Mindestauftragswert von CHF ${minPrice.toFixed(2)}.`);
  }

  netTotal = Math.max(0, netTotal);
  const vatRate = toNumber(service.vatRate);
  const vatAmount = round2(netTotal * (vatRate / 100));
  const grossTotal = round2(netTotal + vatAmount);

  if (travelMinutes > 0) {
    notes.push(`Anfahrtszeit ca. ${travelMinutes} Minuten ab unserem Standort in Bern.`);
  }

  return {
    service: {
      id: service.id,
      name: service.name,
      kind: service.kind,
      pricingModel: service.pricingModel,
    },
    lines,
    durationMinutes: durationMinutes + extrasMinutes,
    crewSize,
    laborHours,
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
    notes,
    appliedRules,
  };
}

export { FREQUENCY_DISCOUNT, FREQUENCY_LABEL };
