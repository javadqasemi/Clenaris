import type { FieldSpec } from '@/components/app/resource-form';

/**
 * Feldbeschreibungen der Besichtigung (Wave 12). Ohne `'use client'`.
 * Kein Preisfeld — den Preis rechnet der Server.
 */

type Option = { value: string; label: string };

export const OBJEKTART: Option[] = [
  { value: 'OFFICE', label: 'Büro' },
  { value: 'PRACTICE', label: 'Praxis' },
  { value: 'COMMERCIAL', label: 'Gewerbe' },
  { value: 'RESTAURANT', label: 'Gastronomie' },
  { value: 'SCHOOL', label: 'Schule' },
  { value: 'INDUSTRIAL', label: 'Industrie' },
  { value: 'APARTMENT', label: 'Wohnung' },
  { value: 'HOUSE', label: 'Haus' },
  { value: 'CONSTRUCTION_SITE', label: 'Baustelle' },
  { value: 'OTHER', label: 'Anderes' },
];

export const TURNUS: Option[] = [
  { value: 'ONCE', label: 'Einmalig' },
  { value: 'WEEKLY', label: 'Wöchentlich' },
  { value: 'BIWEEKLY', label: 'Alle zwei Wochen' },
  { value: 'MONTHLY', label: 'Monatlich' },
  { value: 'QUARTERLY', label: 'Quartalsweise' },
  { value: 'SEMIANNUAL', label: 'Halbjährlich' },
  { value: 'ANNUAL', label: 'Jährlich' },
];

export function siteVisitFields(anfragen: Option[], kunden: Option[], personen: Option[]): FieldSpec[] {
  return [
    { name: 'customerId', label: 'Kundschaft', type: 'select', options: kunden, hint: 'Oder eine Anfrage.' },
    { name: 'leadId', label: 'Anfrage', type: 'select', options: anfragen },
    { name: 'scheduledAt', label: 'Termin', type: 'datetime', required: true, half: true },
    { name: 'assessorId', label: 'Begutachtung durch', type: 'select', options: personen, half: true },
    { name: 'propertyKind', label: 'Objektart', type: 'select', options: OBJEKTART, half: true },
    { name: 'postalCode', label: 'PLZ', half: true, hint: 'Für die Anfahrt, falls kein Objekt erfasst ist.' },
    { name: 'street', label: 'Strasse', half: true },
    { name: 'city', label: 'Ort', half: true },
    { name: 'hasPets', label: 'Haustiere im Objekt', type: 'checkbox' },
    { name: 'accessNotes', label: 'Zugang', type: 'textarea', rows: 2 },
  ];
}

export function areaFields(leistungen: Option[]): FieldSpec[] {
  return [
    { name: 'label', label: 'Bereich', required: true, placeholder: 'z. B. Empfang und Büros 1. OG' },
    { name: 'serviceId', label: 'Leistung', type: 'select', options: leistungen, required: true },
    { name: 'frequency', label: 'Turnus', type: 'select', options: TURNUS, half: true },
    { name: 'squareMeters', label: 'Fläche', type: 'number', step: 1, suffix: 'm²', half: true },
    { name: 'rooms', label: 'Räume', type: 'number', step: 0.5, half: true },
    { name: 'bathrooms', label: 'Sanitärräume', type: 'number', step: 1, half: true },
    { name: 'windows', label: 'Fenster', type: 'number', step: 1, half: true },
    { name: 'manualHours', label: 'Stunden (statt Schätzung)', type: 'number', step: 0.25, half: true },
    { name: 'note', label: 'Notiz', type: 'textarea', rows: 2 },
  ];
}
