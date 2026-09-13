/**
 * Anzeigetexte der Unternehmensführung.
 *
 * Ein Modul für Server und Client: Listen, Detailseiten, PDF-Berichte und
 * Auswahlfelder zeigen dieselben Wörter. Die technischen Schlüssel bleiben
 * englisch (sie stehen in der Datenbank), die Anzeige ist durchgehend deutsch.
 */

export const KPI_UNIT_LABELS: Record<string, string> = {
  CURRENCY: 'CHF',
  PERCENT: '%',
  COUNT: 'Stück',
  DAYS: 'Tage',
  HOURS: 'Stunden',
  RATIO: 'Verhältnis',
};

export const KPI_PERIOD_LABELS: Record<string, string> = {
  DAY: 'Tag',
  WEEK: 'Woche',
  MONTH: 'Monat',
  QUARTER: 'Quartal',
  YEAR: 'Jahr',
};

export const KPI_DIRECTIONS_LABELS: Record<string, string> = {
  UP_IS_GOOD: 'Mehr ist besser',
  DOWN_IS_GOOD: 'Weniger ist besser',
};

export const KPI_SOURCE_LABELS: Record<string, string> = {
  DERIVED: 'Berechnet',
  MANUAL: 'Manuell erfasst',
};

export const HEALTH_STATUS_LABELS: Record<string, string> = {
  EXCELLENT: 'Ausgezeichnet',
  GOOD: 'Gut',
  ATTENTION: 'Aufmerksamkeit nötig',
  CRITICAL: 'Kritisch',
};

export const OBJECTIVE_HORIZON_LABELS: Record<string, string> = {
  STRATEGY: 'Strategie',
  OBJECTIVE: 'Ziel',
  INITIATIVE: 'Initiative',
};

export const OBJECTIVE_LEVEL_LABELS: Record<string, string> = {
  COMPANY: 'Firma',
  DEPARTMENT: 'Bereich',
  PERSONAL: 'Persönlich',
};

export const OBJECTIVE_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Entwurf',
  ACTIVE: 'Aktiv',
  AT_RISK: 'Gefährdet',
  ACHIEVED: 'Erreicht',
  MISSED: 'Verfehlt',
  CANCELLED: 'Abgebrochen',
};

export const PRIORITY_LABELS: Record<string, string> = {
  LOW: 'Tief',
  NORMAL: 'Normal',
  HIGH: 'Hoch',
  URGENT: 'Dringend',
};

export const EXPENSE_CATEGORY_LABELS: Record<string, string> = {
  MATERIAL: 'Material',
  EQUIPMENT: 'Geräte',
  VEHICLE: 'Fahrzeuge',
  FUEL: 'Treibstoff',
  INSURANCE: 'Versicherungen',
  RENT: 'Miete',
  SALARY: 'Löhne',
  SOCIAL_SECURITY: 'Sozialversicherungen',
  MARKETING: 'Marketing',
  SOFTWARE: 'Software',
  TRAINING: 'Weiterbildung',
  TAXES: 'Steuern',
  OTHER: 'Übriges',
};

export const BUDGET_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Entwurf',
  APPROVED: 'Genehmigt',
  CLOSED: 'Abgeschlossen',
};

export const INVESTMENT_STATUS_LABELS: Record<string, string> = {
  PLANNED: 'Geplant',
  APPROVED: 'Bewilligt',
  ORDERED: 'Bestellt',
  ACTIVE: 'In Betrieb',
  DISPOSED: 'Ausgebucht',
  CANCELLED: 'Verworfen',
};

export const DEPRECIATION_METHOD_LABELS: Record<string, string> = {
  NONE: 'Keine Abschreibung',
  STRAIGHT_LINE: 'Linear',
  DECLINING: 'Degressiv',
};

export const SCENARIO_KIND_LABELS: Record<string, string> = {
  BEST: 'Bester Fall',
  EXPECTED: 'Erwarteter Fall',
  WORST: 'Schlechtester Fall',
};

export const SCENARIO_DRIVER_LABELS: Record<string, { label: string; unit: string; hint: string }> = {
  jobsPerMonth: { label: 'Aufträge je Monat', unit: 'COUNT', hint: 'Abgeschlossene Einsätze je Monat.' },
  averageTicket: { label: 'Ø Erlös je Auftrag', unit: 'CURRENCY', hint: 'Nettoerlös je abgeschlossenem Einsatz.' },
  laborCostPct: { label: 'Lohnkosten', unit: 'PERCENT', hint: 'In Prozent des Umsatzes.' },
  materialCostPct: { label: 'Materialkosten', unit: 'PERCENT', hint: 'In Prozent des Umsatzes.' },
  overheadPerMonth: { label: 'Fixkosten je Monat', unit: 'CURRENCY', hint: 'Miete, Versicherungen, Software, Fahrzeuge.' },
  investmentPerMonth: { label: 'Investitionen je Monat', unit: 'CURRENCY', hint: 'Geräte, Fahrzeuge — wirkt nur auf die Liquidität.' },
  churnPct: { label: 'Kundenverlust je Monat', unit: 'PERCENT', hint: 'Anteil der Aufträge, der monatlich wegfällt.' },
  paymentDelayDays: { label: 'Zahlungsverzug', unit: 'DAYS', hint: 'Tage zwischen Rechnung und Zahlungseingang.' },
  hoursPerJob: { label: 'Stunden je Auftrag', unit: 'HOURS', hint: 'Für die benötigten Mitarbeitenden.' },
  targetUtilizationPct: { label: 'Zielauslastung', unit: 'PERCENT', hint: 'Anteil der Sollstunden, der verrechenbar ist.' },
};

export const RISK_CATEGORY_LABELS: Record<string, string> = {
  FINANCIAL: 'Finanzen',
  OPERATIONAL: 'Betrieb',
  PERSONNEL: 'Personal',
  LEGAL: 'Recht',
  DATA_PROTECTION: 'Datenschutz',
  IT_SECURITY: 'IT-Sicherheit',
  REPUTATION: 'Reputation',
  MARKET: 'Markt',
  ENVIRONMENT: 'Umwelt',
};

export const RISK_STATUS_LABELS: Record<string, string> = {
  IDENTIFIED: 'Erkannt',
  ASSESSED: 'Bewertet',
  MITIGATING: 'In Bearbeitung',
  ACCEPTED: 'Akzeptiert',
  CLOSED: 'Geschlossen',
};

export const RISK_BAND_LABELS: Record<string, string> = {
  LOW: 'Gering',
  MEDIUM: 'Mittel',
  HIGH: 'Hoch',
  CRITICAL: 'Kritisch',
};

export const CONTROL_KIND_LABELS: Record<string, string> = {
  SOP: 'Ablauf / Standard',
  QUALITY_STANDARD: 'Qualitätsnorm',
  COMPLIANCE: 'Compliance-Pflicht',
  CONTINUITY: 'Notfallplan',
};

export const CONTROL_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Entwurf',
  ACTIVE: 'Aktiv',
  DUE: 'Prüfung fällig',
  NON_COMPLIANT: 'Abweichung',
  RETIRED: 'Ausser Kraft',
};

export const ACTION_KIND_LABELS: Record<string, string> = {
  CORRECTIVE: 'Korrektur',
  PREVENTIVE: 'Vorbeugung',
  IMPROVEMENT: 'Verbesserung',
};

export const DOCUMENT_CATEGORY_LABELS: Record<string, string> = {
  BUSINESS_PLAN: 'Businessplan',
  CONTRACT: 'Vertrag',
  INSURANCE: 'Versicherung',
  EMPLOYEE: 'Personal',
  CERTIFICATE: 'Zertifikat',
  LICENSE: 'Bewilligung',
  SUPPLIER: 'Lieferant',
  TAX: 'Steuern',
  LEGAL: 'Recht',
  POLICY: 'Richtlinie',
  OTHER: 'Übriges',
};

export const DOCUMENT_VISIBILITY_LABELS: Record<string, string> = {
  MANAGEMENT: 'Geschäftsleitung',
  OPERATIONS: 'Geschäftsleitung und Betriebsleitung',
  STAFF: 'Alle Mitarbeitenden',
  EMPLOYEE_PRIVATE: 'Betroffene Person und Geschäftsleitung',
};

export const ARTICLE_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Entwurf',
  PUBLISHED: 'Veröffentlicht',
  ARCHIVED: 'Archiviert',
};

export const INSIGHT_KIND_LABELS: Record<string, string> = {
  INDUSTRY: 'Branche',
  CUSTOMER: 'Kundschaft',
  COMPETITOR: 'Wettbewerb',
  TECHNOLOGY: 'Technologie',
  ECONOMY: 'Wirtschaft',
  LEGAL: 'Recht',
  ENVIRONMENT: 'Umwelt',
};

export const ANALYSIS_KIND_LABELS: Record<string, string> = {
  SWOT: 'SWOT-Analyse',
  PESTEL: 'PESTEL-Analyse',
};

export const ANALYSIS_BUCKET_LABELS: Record<string, string> = {
  STRENGTH: 'Stärken',
  WEAKNESS: 'Schwächen',
  OPPORTUNITY: 'Chancen',
  THREAT: 'Risiken',
  POLITICAL: 'Politisch',
  ECONOMIC: 'Wirtschaftlich',
  SOCIAL: 'Gesellschaftlich',
  TECHNOLOGICAL: 'Technologisch',
  ENVIRONMENTAL: 'Ökologisch',
  LEGAL: 'Rechtlich',
};

export const REPORT_KIND_LABELS: Record<string, string> = {
  BUSINESS_PERFORMANCE: 'Geschäftsverlauf',
  FINANCIAL: 'Finanzen',
  MARKETING: 'Marketing',
  SALES: 'Vertrieb',
  EMPLOYEE: 'Personal',
  CUSTOMER: 'Kundschaft',
  QUARTERLY_REVIEW: 'Quartalsrückblick',
};

export const REPORT_CADENCE_LABELS: Record<string, string> = {
  WEEKLY: 'Wöchentlich',
  MONTHLY: 'Monatlich',
  QUARTERLY: 'Quartalsweise',
  YEARLY: 'Jährlich',
};

export const REPORT_FORMAT_LABELS: Record<string, string> = {
  PDF: 'PDF',
  XLSX: 'Excel',
  DOCX: 'Word',
};

export const REPORT_STATUS_LABELS: Record<string, string> = {
  PENDING: 'In Arbeit',
  READY: 'Bereit',
  FAILED: 'Fehlgeschlagen',
};

/** Optionen für Auswahlfelder aus einer Beschriftungstabelle. */
export function optionsOf(labels: Record<string, string>): { value: string; label: string }[] {
  return Object.entries(labels).map(([value, label]) => ({ value, label }));
}

/** Kennzahlwert in der Einheit formatieren — Anzeigekante, nicht Rechnung. */
export function formatKpiValue(value: number | null | undefined, unit: string): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const de = 'de-CH';
  switch (unit) {
    case 'CURRENCY':
      return new Intl.NumberFormat(de, { style: 'currency', currency: 'CHF', maximumFractionDigits: 0 }).format(value);
    case 'PERCENT':
      return `${new Intl.NumberFormat(de, { maximumFractionDigits: 1 }).format(value)} %`;
    case 'DAYS':
      return `${new Intl.NumberFormat(de, { maximumFractionDigits: 1 }).format(value)} Tage`;
    case 'HOURS':
      return `${new Intl.NumberFormat(de, { maximumFractionDigits: 1 }).format(value)} h`;
    case 'RATIO':
      return new Intl.NumberFormat(de, { maximumFractionDigits: 2 }).format(value);
    default:
      return new Intl.NumberFormat(de, { maximumFractionDigits: 0 }).format(value);
  }
}
