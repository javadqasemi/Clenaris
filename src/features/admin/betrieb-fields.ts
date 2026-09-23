import type { FieldSpec } from '@/components/app/resource-form';

/**
 * Feldbeschreibungen für Reklamationen, Material und Geräte (Wave 11).
 * Ohne `'use client'` — die Seiten sind Serverkomponenten.
 *
 * Kein Feld für eine Frist und keines für einen Bestand: Beides rechnet der
 * Server (Vertragsfassung bzw. Summe der Bewegungen).
 */

type Option = { value: string; label: string };

export const ART_OPTIONEN: Option[] = [
  { value: 'COMPLAINT', label: 'Reklamation' },
  { value: 'INCIDENT', label: 'Vorfall' },
  { value: 'DAMAGE', label: 'Schaden' },
];
export const SCHWERE_OPTIONEN: Option[] = [
  { value: 'LOW', label: 'Gering' },
  { value: 'MEDIUM', label: 'Mittel' },
  { value: 'HIGH', label: 'Hoch' },
  { value: 'CRITICAL', label: 'Kritisch' },
];
export const KANAL_OPTIONEN: Option[] = [
  { value: 'PHONE', label: 'Telefon' },
  { value: 'EMAIL', label: 'E-Mail' },
  { value: 'PORTAL', label: 'Kundenbereich' },
  { value: 'ON_SITE', label: 'Vor Ort' },
  { value: 'OTHER', label: 'Anderes' },
];

export const LABEL = (optionen: Option[]) => Object.fromEntries(optionen.map((o) => [o.value, o.label])) as Record<string, string>;

export function complaintFields(kunden: Option[], zustaendige: Option[]): FieldSpec[] {
  return [
    { name: 'customerId', label: 'Kundschaft', type: 'select', options: kunden, required: true },
    { name: 'kind', label: 'Art', type: 'select', options: ART_OPTIONEN, half: true },
    { name: 'severity', label: 'Schweregrad', type: 'select', options: SCHWERE_OPTIONEN, half: true },
    { name: 'channel', label: 'Eingang über', type: 'select', options: KANAL_OPTIONEN, half: true },
    { name: 'assigneeId', label: 'Zuständig', type: 'select', options: zustaendige, half: true },
    { name: 'title', label: 'Betreff', required: true },
    { name: 'description', label: 'Beschreibung', type: 'textarea', rows: 4, required: true },
  ];
}

export function ownComplaintFields(objekte: Option[]): FieldSpec[] {
  return [
    { name: 'propertyId', label: 'Objekt', type: 'select', options: objekte },
    { name: 'kind', label: 'Art', type: 'select', options: ART_OPTIONEN },
    { name: 'title', label: 'Betreff', required: true },
    { name: 'description', label: 'Was ist passiert?', type: 'textarea', rows: 5, required: true },
  ];
}

export function correctiveActionFields(): FieldSpec[] {
  return [
    { name: 'title', label: 'Massnahme', required: true },
    { name: 'rootCause', label: 'Ursache', type: 'textarea', rows: 3 },
    { name: 'dueOn', label: 'Fällig am', type: 'date' },
  ];
}

export function materialFields(): FieldSpec[] {
  return [
    { name: 'sku', label: 'Artikelnummer', required: true, half: true },
    { name: 'unit', label: 'Einheit', half: true, placeholder: 'Stk., l, kg' },
    { name: 'name', label: 'Bezeichnung', required: true },
    { name: 'unitCost', label: 'Einstandspreis', type: 'number', step: 0.05, suffix: 'CHF', half: true },
    { name: 'minStock', label: 'Meldebestand', type: 'number', step: 1, half: true },
    { name: 'note', label: 'Notiz', type: 'textarea', rows: 2 },
  ];
}

export const BEWEGUNG_OPTIONEN: Option[] = [
  { value: 'RECEIPT', label: 'Eingang' },
  { value: 'ISSUE', label: 'Entnahme' },
  { value: 'RETURN', label: 'Rückgabe' },
  { value: 'ADJUSTMENT', label: 'Inventurkorrektur (±)' },
];

export function movementFields(): FieldSpec[] {
  return [
    { name: 'kind', label: 'Art', type: 'select', options: BEWEGUNG_OPTIONEN, required: true, half: true },
    { name: 'quantity', label: 'Menge', type: 'number', step: 0.5, required: true, half: true, hint: 'Ohne Vorzeichen — ausser bei der Inventurkorrektur.' },
    { name: 'reference', label: 'Beleg / Lieferschein' },
    { name: 'note', label: 'Begründung', type: 'textarea', rows: 2, hint: 'Pflicht bei Inventurkorrektur und bei Entnahmen ohne Einsatz.' },
  ];
}

export function equipmentFields(): FieldSpec[] {
  return [
    { name: 'name', label: 'Bezeichnung', required: true },
    { name: 'category', label: 'Kategorie', half: true },
    { name: 'serialNumber', label: 'Seriennummer', half: true },
    { name: 'purchasedOn', label: 'Angeschafft am', type: 'date', half: true },
    { name: 'purchaseCost', label: 'Anschaffungspreis', type: 'number', step: 1, suffix: 'CHF', half: true },
    { name: 'maintenanceIntervalDays', label: 'Wartungsintervall', type: 'number', step: 1, suffix: 'Tage', half: true },
    { name: 'nextMaintenanceOn', label: 'Nächste Wartung', type: 'date', half: true },
    { name: 'note', label: 'Notiz', type: 'textarea', rows: 2 },
  ];
}

export function maintenanceFields(): FieldSpec[] {
  return [
    { name: 'performedOn', label: 'Durchgeführt am', type: 'date', required: true, half: true },
    { name: 'kind', label: 'Art', half: true, placeholder: 'Wartung, Reparatur, Prüfung' },
    { name: 'cost', label: 'Kosten', type: 'number', step: 0.05, suffix: 'CHF', half: true },
    { name: 'note', label: 'Notiz', type: 'textarea', rows: 2 },
  ];
}

export function assignFields(personen: Option[]): FieldSpec[] {
  return [{ name: 'employeeId', label: 'Person', type: 'select', options: personen, required: true }];
}
