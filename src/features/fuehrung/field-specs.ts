import {
  CONTROL_KIND_LABELS,
  CONTROL_STATUS_LABELS,
  DEPRECIATION_METHOD_LABELS,
  EXPENSE_CATEGORY_LABELS,
  INVESTMENT_STATUS_LABELS,
  optionsOf,
  RISK_CATEGORY_LABELS,
  RISK_STATUS_LABELS,
} from '@/lib/bi/labels';
import type { FieldSpec } from './resource-form';

/**
 * Feldbeschreibungen, die Liste und Detailseite teilen.
 *
 * Nicht in den Seiten selbst: Next.js erlaubt aus `page.tsx` nur die
 * bekannten Exporte, und ein zweiter Export bricht den Build. Hier sind es
 * reine Daten ohne `'use client'` — lesbar von beiden Seiten der Grenze.
 */

type Option = { id: string; name: string };
const LEVELS = [1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: `${n}` }));

export function investmentFields(options: { suppliers: Option[]; staff: Option[]; editing?: boolean }): FieldSpec[] {
  const nullable = options.editing;
  return [
    { name: 'name', label: 'Bezeichnung', required: true, placeholder: 'z. B. Scheuersaugmaschine Kärcher B 40' },
    { name: 'category', label: 'Kategorie', type: 'select', required: true, half: true, options: optionsOf(EXPENSE_CATEGORY_LABELS) },
    { name: 'status', label: 'Status', type: 'select', required: true, half: true, options: optionsOf(INVESTMENT_STATUS_LABELS) },
    { name: 'purchaseAmount', label: 'Anschaffungswert', type: 'number', required: true, half: true, suffix: 'CHF' },
    { name: 'expectedAnnualBenefit', label: 'Erwarteter Jahresnutzen', type: 'number', half: true, suffix: 'CHF', hint: 'Schätzung — Grundlage für ROI und Amortisation.', nullable },
    { name: 'method', label: 'Abschreibung', type: 'select', required: true, half: true, options: optionsOf(DEPRECIATION_METHOD_LABELS) },
    { name: 'usefulLifeYears', label: 'Nutzungsdauer', type: 'number', half: true, suffix: 'Jahre', nullable },
    { name: 'residualValue', label: 'Restwert', type: 'number', half: true, suffix: 'CHF', hint: 'Degressiv braucht einen Restwert über null.' },
    { name: 'assetTag', label: 'Inventarnummer', half: true, nullable },
    { name: 'plannedOn', label: 'Geplant für', type: 'date', half: true, nullable },
    { name: 'purchasedOn', label: 'Gekauft am', type: 'date', half: true, nullable },
    { name: 'commissionedOn', label: 'In Betrieb seit', type: 'date', half: true, hint: 'Ab hier läuft die Abschreibung.', nullable },
    { name: 'disposedOn', label: 'Ausgebucht am', type: 'date', half: true, nullable },
    { name: 'location', label: 'Standort', half: true, nullable },
    { name: 'supplierId', label: 'Lieferant', type: 'select', half: true, options: options.suppliers.map((s) => ({ value: s.id, label: s.name })), placeholder: 'Keiner', nullable },
    { name: 'ownerId', label: 'Verantwortlich', type: 'select', half: true, options: options.staff.map((s) => ({ value: s.id, label: s.name })), placeholder: 'Niemand', nullable },
    { name: 'description', label: 'Beschreibung', type: 'textarea', rows: 3, nullable },
  ];
}

export function riskFields(staff: Option[], editing = false): FieldSpec[] {
  return [
    { name: 'title', label: 'Risiko', required: true, placeholder: 'z. B. Ausfall des Hauptfahrzeugs in der Hochsaison' },
    { name: 'category', label: 'Kategorie', type: 'select', required: true, half: true, options: optionsOf(RISK_CATEGORY_LABELS) },
    { name: 'status', label: 'Status', type: 'select', required: true, half: true, options: optionsOf(RISK_STATUS_LABELS) },
    { name: 'probability', label: 'Wahrscheinlichkeit (1–5)', type: 'select', required: true, half: true, options: LEVELS },
    { name: 'impact', label: 'Auswirkung (1–5)', type: 'select', required: true, half: true, options: LEVELS },
    { name: 'residualProbability', label: 'Restwahrscheinlichkeit', type: 'select', half: true, options: LEVELS, placeholder: 'Nach Massnahmen', nullable: editing },
    { name: 'residualImpact', label: 'Restauswirkung', type: 'select', half: true, options: LEVELS, placeholder: 'Nach Massnahmen', nullable: editing },
    { name: 'potentialLoss', label: 'Schaden im Eintrittsfall', type: 'number', half: true, suffix: 'CHF', nullable: editing },
    { name: 'ownerId', label: 'Verantwortlich', type: 'select', half: true, options: staff.map((s) => ({ value: s.id, label: s.name })), placeholder: 'Niemand', nullable: editing },
    { name: 'reviewIntervalDays', label: 'Prüfzyklus', type: 'number', half: true, suffix: 'Tage', required: true },
    { name: 'description', label: 'Beschreibung', type: 'textarea', rows: 3, nullable: editing },
    { name: 'mitigationPlan', label: 'Gegenmassnahmen', type: 'textarea', rows: 3, nullable: editing },
  ];
}

export function controlFields(staff: Option[], editing = false): FieldSpec[] {
  return [
    { name: 'title', label: 'Titel', required: true, placeholder: 'z. B. Reinigungsstandard Sanitärräume' },
    { name: 'kind', label: 'Art', type: 'select', required: true, half: true, options: optionsOf(CONTROL_KIND_LABELS) },
    { name: 'status', label: 'Status', type: 'select', required: true, half: true, options: optionsOf(CONTROL_STATUS_LABELS) },
    { name: 'reference', label: 'Referenz', half: true, placeholder: 'ISO 9001:2015 8.5.1 · nDSG Art. 7', nullable: editing },
    { name: 'reviewIntervalDays', label: 'Prüfzyklus', type: 'number', required: true, half: true, suffix: 'Tage' },
    { name: 'ownerId', label: 'Verantwortlich', type: 'select', half: true, options: staff.map((s) => ({ value: s.id, label: s.name })), placeholder: 'Niemand', nullable: editing },
    { name: 'evidenceNote', label: 'Was gilt als Nachweis?', half: true, placeholder: 'Checkliste, Foto, Zertifikat …', nullable: editing },
    { name: 'description', label: 'Beschreibung / Ablauf', type: 'textarea', rows: 6, hint: 'Markdown erlaubt.', nullable: editing },
  ];
}
