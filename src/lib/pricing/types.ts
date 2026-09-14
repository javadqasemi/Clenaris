import type { Frequency, PricingModel, PropertyKind, ServiceKind } from '@prisma/client';

/** Eingabe der Preisberechnung — identisch für Instant-Quote und Buchung. */
export interface PriceInput {
  serviceId: string;
  /** Wohnfläche in m². */
  squareMeters?: number | null;
  rooms?: number | null;
  bathrooms?: number | null;
  windows?: number | null;
  propertyKind: PropertyKind;
  frequency: Frequency;
  /** IDs der gewählten Zusatzleistungen mit Menge. */
  extras: { extraId: string; quantity: number }[];
  /** Wunschtermin — steuert Wochenend-/Abendzuschläge. */
  scheduledStart?: Date | null;
  postalCode?: string | null;
  hasPets?: boolean;
  /** Vom Kunden gewünschte Dauer (überschreibt die Schätzung). */
  manualHours?: number | null;
  couponCode?: string | null;
  /**
   * Die Kundschaft, für die gerechnet wird — falls bekannt. Nur damit lassen
   * sich `firstOrderOnly` und `perCustomerLimit` eines Gutscheins prüfen; ohne
   * Kundschaft (anonyme Sofortschätzung) gelten diese beiden Regeln als
   * erfüllt und werden spätestens beim Buchungsabschluss nachgeholt.
   */
  customer?: { id: string; totalBookings: number } | null;
  /** Kundenspezifischer Dauerrabatt in Prozent. */
  customerDiscountPercent?: number;
  urgent?: boolean;
}

/**
 * Warum ein Gutschein greift oder nicht. `APPLIED` ist der einzige Zustand,
 * in dem eine Rabattzeile entsteht; jeder andere trägt eine Begründung, die
 * das Formular direkt neben dem Feld anzeigt und die der Buchungsabschluss
 * als 422 zurückgibt.
 */
export type CouponCheckStatus =
  | 'APPLIED'
  | 'INVALID'
  | 'EXHAUSTED'
  | 'MIN_ORDER'
  | 'NOT_APPLICABLE'
  | 'FIRST_ORDER_ONLY'
  | 'PER_CUSTOMER_LIMIT';

export interface CouponCheck {
  code: string;
  status: CouponCheckStatus;
  /** Begründung in Kundensprache; bei `APPLIED` die Kurzbeschreibung. */
  message: string;
  /** Gewährter Rabatt als positiver Betrag, 0 wenn nicht angewandt. */
  amount: number;
}

export interface PriceLine {
  key: string;
  label: string;
  /** Menge in der jeweiligen Einheit (Std., m², Stk.). */
  quantity: number;
  unit: string;
  unitPrice: number;
  amount: number;
  kind: 'base' | 'extra' | 'surcharge' | 'discount' | 'travel';
  meta?: Record<string, unknown>;
}

export interface PriceBreakdown {
  service: {
    id: string;
    name: string;
    kind: ServiceKind;
    pricingModel: PricingModel;
  };
  lines: PriceLine[];
  /** Geschätzte Einsatzdauer in Minuten (inkl. Extras, ohne Anfahrt). */
  durationMinutes: number;
  crewSize: number;
  /** Kalkulierte Arbeitsstunden (durationMinutes × crewSize / 60). */
  laborHours: number;

  subtotal: number;
  extrasTotal: number;
  travelFee: number;
  surchargeTotal: number;
  discountTotal: number;

  netTotal: number;
  vatRate: number;
  vatAmount: number;
  grossTotal: number;
  currency: string;

  /** true, wenn kein verbindlicher Preis berechnet werden kann. */
  onRequest: boolean;
  /**
   * Ergebnis der Gutscheinprüfung — `null`, wenn kein Code eingegeben wurde.
   * Steht bewusst getrennt von `notes`: das Formular muss den Zustand
   * maschinell auswerten (Abschluss sperren, Badge einfärben), nicht nur
   * einen Hinweistext durchreichen.
   */
  coupon: CouponCheck | null;
  notes: string[];
  /** Angewandte Preisregeln — für Transparenz gegenüber dem Kunden. */
  appliedRules: { name: string; multiplier: number; surcharge: number }[];
}

/** Bedingungsobjekt einer `PriceRule`. */
export interface PriceRuleCondition {
  frequency?: Frequency[];
  propertyKind?: PropertyKind[];
  /** 0 = Sonntag … 6 = Samstag */
  weekday?: number[];
  /** Startstunde ≥ diesem Wert (Abendzuschlag). */
  hourFrom?: number;
  hourTo?: number;
  minSqm?: number;
  maxSqm?: number;
  hasPets?: boolean;
  urgent?: boolean;
  postalCode?: string[];
}
