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
 * Eine Leistung innerhalb einer Buchung mit ihren eigenen Angaben
 * (Produktsprint 2026-09-26).
 *
 * Die Angaben stehen *je Leistung*, weil sie je Leistung etwas anderes
 * bedeuten: Für die Büroreinigung zählt die Fläche, für die Fensterreinigung
 * die Zahl der Fenster, und eine Zusatzleistung wie „Backofen" gehört zur
 * Umzugsreinigung, nicht zur Fensterreinigung daneben.
 */
export interface LeistungInput {
  serviceId: string;
  squareMeters?: number | null;
  rooms?: number | null;
  bathrooms?: number | null;
  windows?: number | null;
  manualHours?: number | null;
  extras: { extraId: string; quantity: number }[];
}

/**
 * Eingabe für eine Buchung mit einer oder mehreren Leistungen.
 *
 * Was nicht je Leistung gilt — Objektart, Haustiere, Termin, Rhythmus,
 * Postleitzahl, Gutschein, Kundschaft —, steht einmal für die ganze Buchung.
 */
export interface BookingPriceInput
  extends Omit<PriceInput, 'serviceId' | 'squareMeters' | 'rooms' | 'bathrooms' | 'windows' | 'manualHours' | 'extras'> {
  leistungen: LeistungInput[];
}

/** Was eine einzelne Leistung zur Buchung beiträgt. */
export interface PricePosition {
  serviceId: string;
  name: string;
  kind: ServiceKind;
  pricingModel: PricingModel;
  /** Dauer dieser Leistung einschliesslich ihrer Zusatzleistungen. */
  durationMinutes: number;
  crewSize: number;
  /** Grundpreis dieser Leistung (Arbeit, Fläche, Stück, Pauschale, Grundpauschale). */
  subtotal: number;
  extrasTotal: number;
  /** „Puffer zwischen Einsätzen" aus dem Katalog. */
  bufferMinutes: number;
  onRequest: boolean;
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
  /**
   * Die erste Leistung — für Stellen, die aus der Zeit mit genau einer
   * Leistung stammen. Wer alle Leistungen braucht, liest `positionen`.
   */
  service: {
    id: string;
    name: string;
    kind: ServiceKind;
    pricingModel: PricingModel;
  };
  /** Alle Leistungen der Buchung, in der gewählten Reihenfolge. */
  positionen: PricePosition[];
  lines: PriceLine[];
  /**
   * Geschätzte Einsatzdauer in Minuten (inkl. Extras, ohne Anfahrt). Bei
   * mehreren Leistungen die Summe: Sie werden nacheinander vom selben Team
   * ausgeführt, nicht parallel von mehreren.
   */
  durationMinutes: number;
  /** Grösster „Puffer zwischen Einsätzen" der gebuchten Leistungen. */
  bufferMinutes: number;
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
