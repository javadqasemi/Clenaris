import type { FieldSpec } from '@/components/app/resource-form';

/**
 * Feldbeschreibungen der Lohnverwaltung (`/admin/lohn`).
 *
 * Eigenes Modul ohne `'use client'`: Die Seite ist eine Serverkomponente und
 * baut die Felder selbst; eine Konstante aus einer Client-Datei käme dort als
 * Referenz an, nicht als Liste (siehe Memory „client-module-exports").
 *
 * **Kein Feld für einen Abrechnungsbetrag.** Erfasst werden Positionen,
 * Vereinbarungen, Profile und Sätze — die Abrechnung rechnet der Server.
 */

type Option = { value: string; label: string };

export const POSITIONSARTEN: Option[] = [
  { value: 'OVERTIME', label: 'Überstunden (Betrag rechnet der Server)' },
  { value: 'ALLOWANCE', label: 'Zulage (beitragspflichtig)' },
  { value: 'FAMILY_ALLOWANCE', label: 'Familienzulage (nicht AHV-pflichtig)' },
  { value: 'EXPENSE', label: 'Spesen' },
  { value: 'CORRECTION', label: 'Lohnkorrektur (±, beitragspflichtig)' },
  { value: 'NET_CORRECTION', label: 'Korrektur der Auszahlung (±, ohne Beiträge)' },
  { value: 'DEDUCTION', label: 'Abzug (Vorschuss, Pfändung …)' },
  { value: 'WITHHOLDING_TAX_MANUAL', label: 'Quellensteuer von Hand' },
];

export const POSITIONSART_LABEL: Record<string, string> = Object.fromEntries(
  POSITIONSARTEN.map((o) => [o.value, o.label.replace(/ \(.*\)$/, '')]),
);

export function payrollItemFields(personen: Option[]): FieldSpec[] {
  return [
    { name: 'employeeId', label: 'Person', type: 'select', options: personen, required: true },
    { name: 'type', label: 'Art', type: 'select', options: POSITIONSARTEN, required: true },
    { name: 'label', label: 'Bezeichnung', required: true, placeholder: 'z. B. Nachtzulage März' },
    { name: 'amount', label: 'Betrag', type: 'number', step: 0.05, suffix: 'CHF', half: true, hint: 'Nicht bei Überstunden.' },
    { name: 'quantity', label: 'Stunden', type: 'number', step: 0.25, half: true, hint: 'Nur Überstunden.' },
    { name: 'rate', label: 'Ansatz', type: 'number', step: 0.05, suffix: 'CHF/h', half: true, hint: 'Nur Überstunden.' },
    { name: 'surchargePct', label: 'Zuschlag', type: 'number', step: 1, suffix: '%', half: true, hint: 'Nur Überstunden.' },
    { name: 'note', label: 'Notiz', type: 'textarea', rows: 2 },
  ];
}

export const DREIZEHNTER_ARTEN: Option[] = [
  { value: 'NONE', label: 'Keiner vereinbart' },
  { value: 'ANNUAL', label: 'Einmal jährlich (ein Monatslohn, anteilig)' },
  { value: 'PRO_RATA', label: '1/12 der Jahresgrundlöhne im Auszahlungsmonat' },
  { value: 'MONTHLY', label: 'Monatlich 1/12' },
];

export function payrollProfileFields(): FieldSpec[] {
  return [
    { name: 'thirteenthMode', label: '13. Monatslohn', type: 'select', options: DREIZEHNTER_ARTEN, required: true },
    { name: 'thirteenthPayoutMonth', label: 'Auszahlungsmonat', type: 'number', min: 1, max: 12, half: true },
    { name: 'holidayPayPct', label: 'Feiertagsentschädigung', type: 'number', step: 0.01, suffix: '%', half: true, nullable: true, hint: 'Nur Stundenlohn, gemäss Vertrag/GAV.' },
    { name: 'vacationPayInWage', label: 'Ferienentschädigung mit dem Stundenlohn ausrichten', type: 'checkbox' },
    { name: 'note', label: 'Notiz', type: 'textarea', rows: 2, nullable: true },
  ];
}

export const BEITRAGSARTEN: Option[] = [
  { value: 'AHV_IV_EO', label: 'AHV/IV/EO' },
  { value: 'ALV', label: 'ALV bis Grenze' },
  { value: 'ALV_SOLIDARITY', label: 'ALV über Grenze' },
  { value: 'UVG_NBU', label: 'UVG Nichtberufsunfall' },
  { value: 'UVG_BU', label: 'UVG Berufsunfall' },
  { value: 'KTG', label: 'Krankentaggeld' },
  { value: 'FAK', label: 'Familienausgleichskasse' },
  { value: 'VK', label: 'Verwaltungskosten' },
];

/** Neue Satzversion — ohne BVG, dessen Schwellen und Bänder die Schnittstelle als Ganzes verlangt. */
export function payrollRateFields(): FieldSpec[] {
  return [
    { name: 'code', label: 'Beitragsart', type: 'select', options: BEITRAGSARTEN, required: true },
    { name: 'validFrom', label: 'Gültig ab', type: 'date', required: true, half: true },
    { name: 'validUntil', label: 'Gültig bis', type: 'date', half: true },
    { name: 'employeePct', label: 'Anteil Arbeitnehmende', type: 'number', step: 0.0001, suffix: '%', half: true },
    { name: 'employerPct', label: 'Anteil Betrieb', type: 'number', step: 0.0001, suffix: '%', half: true },
    { name: 'thresholdMax', label: 'Obergrenze Jahreslohn', type: 'number', step: 1, suffix: 'CHF', half: true, hint: 'ALV-Grenze.' },
    { name: 'thresholdMin', label: 'Untergrenze Jahreslohn', type: 'number', step: 1, suffix: 'CHF', half: true },
    { name: 'source', label: 'Quelle', required: true, placeholder: 'z. B. UVG-Police Nr. …, Kreisschreiben …' },
    { name: 'reference', label: 'Referenz', placeholder: 'Dokument, Seite, Datum' },
  ];
}

export function withholdingProfileFields(personen: Option[]): FieldSpec[] {
  return [
    { name: 'employeeId', label: 'Person', type: 'select', options: personen, required: true },
    { name: 'validFrom', label: 'Gültig ab', type: 'date', required: true, half: true },
    { name: 'validUntil', label: 'Gültig bis', type: 'date', half: true },
    { name: 'canton', label: 'Kanton', required: true, half: true, placeholder: 'BE' },
    { name: 'tariffCode', label: 'Tarifcode', required: true, half: true, placeholder: 'A0N' },
    { name: 'children', label: 'Kinder', type: 'number', min: 0, max: 20, half: true },
    { name: 'churchTax', label: 'Kirchensteuerpflichtig', type: 'checkbox' },
    { name: 'note', label: 'Notiz', type: 'textarea', rows: 2 },
  ];
}

/**
 * Profil ändern — ohne Person und Beginn: Wer ein Profil einer anderen Person
 * oder ab einem anderen Tag will, beendet dieses und erfasst ein neues (der
 * Dienst verweigert inhaltliche Änderungen über veröffentlichte Monate).
 */
export function withholdingProfileEditFields(): FieldSpec[] {
  return [
    { name: 'validUntil', label: 'Gültig bis', type: 'date', half: true, nullable: true },
    { name: 'canton', label: 'Kanton', half: true },
    { name: 'tariffCode', label: 'Tarifcode', half: true },
    { name: 'children', label: 'Kinder', type: 'number', min: 0, max: 20, half: true },
    { name: 'churchTax', label: 'Kirchensteuerpflichtig', type: 'checkbox' },
    { name: 'note', label: 'Notiz', type: 'textarea', rows: 2, nullable: true },
  ];
}

export function salaryCertificateFields(personen: Option[]): FieldSpec[] {
  return [
    { name: 'employeeId', label: 'Person', type: 'select', options: personen, required: true },
    { name: 'year', label: 'Jahr', type: 'number', min: 2020, max: 2100, required: true },
  ];
}
