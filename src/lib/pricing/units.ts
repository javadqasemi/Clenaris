/**
 * Mengeneinheiten je Leistung.
 *
 * Das Problem, das dieses Modul löst: Eine Offertposition hatte bisher pauschal
 * die Einheit „Std." und ein nacktes Mengenfeld. Für eine Büroreinigung ist die
 * Menge aber die *Fläche*, für Fensterreinigung die *Anzahl Fenster*, für eine
 * Bauendreinigung tatsächlich die Stundenzahl. Wer „120" in ein Feld tippt,
 * das „Menge" heisst, meint je nach Leistung drei völlig verschiedene Dinge —
 * und der Preis wird entsprechend falsch.
 *
 * Zwei Entscheide:
 *
 *  1. **Die Einheit folgt dem Preismodell, nicht dem Namen der Leistung.** Was
 *     eine Leistung kostet, hängt an `pricingModel`; die Einheit muss dieselbe
 *     Bezugsgrösse benennen, sonst multipliziert man Äpfel mit Birnen. Die
 *     Leistungsart (`kind`) verfeinert nur die Beschriftung — „Fenster" statt
 *     „Stück", „Wohnungsgrösse" statt „Fläche".
 *
 *  2. **Ein Modul für Website, Offerte und Auftrag.** Die drei Masken zeigten
 *     vorher drei verschiedene Vorstellungen davon, was eine Menge ist. Eine
 *     Offerte, die anders rechnet als der Preisrechner auf der Website, ist
 *     schlimmer als gar keine Offerte.
 */

export type PricingModel = 'PER_HOUR' | 'PER_SQM' | 'FLAT' | 'PER_UNIT' | 'ON_REQUEST';

export type ServiceKind =
  | 'OFFICE_CLEANING'
  | 'MOVE_OUT_CLEANING'
  | 'RESIDENTIAL_CLEANING'
  | 'WINDOW_CLEANING'
  | 'CONSTRUCTION_CLEANING'
  | 'BUILDING_MAINTENANCE'
  | 'SPECIAL';

export interface ServiceUnit {
  /** Kurzform hinter dem Eingabefeld und in der Positionszeile: „m²", „Std.". */
  unit: string;
  /** Beschriftung des Mengenfeldes: „Fläche", „Anzahl Fenster", „Aufwand". */
  quantityLabel: string;
  /** Ein Satz unter dem Feld, der die Erwartung klärt. */
  hint: string;
  /** Schrittweite des Zahlenfeldes. */
  step: number;
  /** Sinnvolle Untergrenze — verhindert die versehentliche Null. */
  min: number;
  max: number;
  /** Vorgabe, wenn eine Position neu entsteht. */
  defaultQuantity: number;
  /** Ganzzahlig (Fenster, Stück) oder mit Nachkommastellen (Stunden, Fläche). */
  integer: boolean;
}

const PER_HOUR: ServiceUnit = {
  unit: 'Std.',
  quantityLabel: 'Aufwand',
  hint: 'Geschätzter Aufwand in Stunden — für das ganze Team zusammen.',
  step: 0.25,
  min: 0.25,
  max: 2000,
  defaultQuantity: 2,
  integer: false,
};

const PER_SQM: ServiceUnit = {
  unit: 'm²',
  quantityLabel: 'Fläche',
  hint: 'Zu reinigende Fläche in Quadratmetern.',
  step: 1,
  min: 1,
  max: 100_000,
  defaultQuantity: 100,
  integer: true,
};

const FLAT: ServiceUnit = {
  unit: 'Pauschal',
  quantityLabel: 'Anzahl',
  hint: 'Pauschale je Durchgang — bei wiederkehrenden Einsätzen die Anzahl Durchgänge.',
  step: 1,
  min: 1,
  max: 500,
  defaultQuantity: 1,
  integer: true,
};

const PER_UNIT: ServiceUnit = {
  unit: 'Stk.',
  quantityLabel: 'Anzahl',
  hint: 'Anzahl der abzurechnenden Einheiten.',
  step: 1,
  min: 1,
  max: 10_000,
  defaultQuantity: 1,
  integer: true,
};

/**
 * Verfeinerungen je Leistungsart.
 *
 * Nur dort, wo die generische Beschriftung tatsächlich in die Irre führt.
 * „Anzahl" bei einer Fensterreinigung lässt offen, ob Fenster, Flügel oder
 * Gebäude gemeint sind — und diese Frage kommt sonst per Telefon zurück.
 */
const KIND_OVERRIDES: Partial<Record<ServiceKind, Partial<ServiceUnit>>> = {
  WINDOW_CLEANING: {
    unit: 'Fenster',
    quantityLabel: 'Anzahl Fenster',
    hint: 'Anzahl Fensterflügel, innen und aussen zusammen gezählt.',
    defaultQuantity: 10,
  },
  MOVE_OUT_CLEANING: {
    quantityLabel: 'Wohnungsgrösse',
    hint: 'Wohnfläche in Quadratmetern — Keller und Balkon nicht mitgerechnet.',
  },
  OFFICE_CLEANING: {
    quantityLabel: 'Bürofläche',
    hint: 'Zu reinigende Bürofläche in Quadratmetern.',
  },
  CONSTRUCTION_CLEANING: {
    quantityLabel: 'Aufwand',
    hint: 'Geschätzter Aufwand in Stunden — Bauendreinigungen werden nach Zeit abgerechnet.',
  },
  BUILDING_MAINTENANCE: {
    quantityLabel: 'Durchgänge',
    hint: 'Anzahl Durchgänge im Abrechnungszeitraum.',
  },
};

const BY_MODEL: Record<PricingModel, ServiceUnit> = {
  PER_HOUR: PER_HOUR,
  PER_SQM: PER_SQM,
  FLAT: FLAT,
  PER_UNIT: PER_UNIT,
  // Auf Anfrage heisst: Der Preis entsteht im Gespräch. Bis dahin ist Zeit die
  // ehrlichste Bezugsgrösse — sie unterstellt keine Fläche, die niemand kennt.
  ON_REQUEST: PER_HOUR,
};

/**
 * Die Mengeneinheit für eine Leistung.
 *
 * `kind` ist freiwillig: Freitextpositionen in einer Offerte haben keine
 * Leistungsart, aber sehr wohl ein Preismodell.
 */
export function unitForService(
  pricingModel: PricingModel | string,
  kind?: ServiceKind | string | null,
): ServiceUnit {
  const base = BY_MODEL[pricingModel as PricingModel] ?? PER_HOUR;
  const override = kind ? KIND_OVERRIDES[kind as ServiceKind] : undefined;
  return override ? { ...base, ...override } : base;
}

/**
 * Der Ansatz, der zur Einheit gehört.
 *
 * Bisher wurde überall der Stundensatz übernommen — auch für Leistungen, die
 * nach Quadratmetern abgerechnet werden. Das Ergebnis war eine Position
 * „120 m² × CHF 65.00" statt „120 m² × CHF 4.20": ein Faktor 15 im Angebot,
 * und zwar zugunsten eines Preises, den niemand annimmt.
 */
export function rateForService(service: {
  pricingModel: PricingModel | string;
  hourlyRate: number | null;
  pricePerSqm: number | null;
  basePrice: number;
}): number {
  switch (service.pricingModel) {
    case 'PER_SQM':
      return service.pricePerSqm ?? 0;
    case 'FLAT':
    case 'PER_UNIT':
      return service.basePrice;
    default:
      return service.hourlyRate ?? service.basePrice;
  }
}

/** Menge auf die Regeln der Einheit bringen — Grenzen und Nachkommastellen. */
export function clampQuantity(value: number, unit: ServiceUnit): number {
  if (!Number.isFinite(value)) return unit.defaultQuantity;
  const bounded = Math.min(Math.max(value, unit.min), unit.max);
  return unit.integer ? Math.round(bounded) : Math.round(bounded * 100) / 100;
}
