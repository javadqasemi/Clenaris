import {
  OBJECTIVE_HORIZON_LABELS,
  OBJECTIVE_LEVEL_LABELS,
  OBJECTIVE_STATUS_LABELS,
  optionsOf,
  PRIORITY_LABELS,
} from '@/lib/bi/labels';
import type { FieldSpec } from './resource-form';

/**
 * Felder des Zielformulars — einmal definiert, für Anlegen und Bearbeiten.
 *
 * Kein `'use client'`: die Datei enthält nur Daten und wird von Server- wie
 * Client-Komponenten gelesen.
 */
export function objectiveFields(options: {
  staff: { id: string; name: string }[];
  parents: { id: string; title: string; horizon: string }[];
  editing?: boolean;
}): FieldSpec[] {
  const nullable = options.editing;
  return [
    { name: 'title', label: 'Titel', required: true, placeholder: 'z. B. Annahmequote der Offerten auf 45 % heben' },
    { name: 'horizon', label: 'Flughöhe', type: 'select', required: true, half: true, options: optionsOf(OBJECTIVE_HORIZON_LABELS), hint: 'Strategie = mehrjährig, Ziel = Quartal/Jahr, Initiative = Vorhaben mit Start und Ende.' },
    { name: 'level', label: 'Ebene', type: 'select', required: true, half: true, options: optionsOf(OBJECTIVE_LEVEL_LABELS) },
    { name: 'status', label: 'Status', type: 'select', required: true, half: true, options: optionsOf(OBJECTIVE_STATUS_LABELS) },
    { name: 'priority', label: 'Priorität', type: 'select', required: true, half: true, options: optionsOf(PRIORITY_LABELS) },
    { name: 'ownerId', label: 'Verantwortlich', type: 'select', half: true, options: options.staff.map((s) => ({ value: s.id, label: s.name })), placeholder: 'Niemand', nullable },
    { name: 'department', label: 'Bereich', half: true, placeholder: 'Vertrieb, Betrieb, Büro …', nullable },
    { name: 'parentId', label: 'Übergeordnetes Ziel', type: 'select', options: options.parents.map((p) => ({ value: p.id, label: `${OBJECTIVE_HORIZON_LABELS[p.horizon]}: ${p.title}` })), placeholder: 'Keines', nullable },
    { name: 'fiscalYear', label: 'Geschäftsjahr', type: 'number', half: true, nullable },
    { name: 'quarter', label: 'Quartal', type: 'select', half: true, options: [1, 2, 3, 4].map((q) => ({ value: String(q), label: `Q${q}` })), placeholder: 'Ganzes Jahr', nullable },
    { name: 'startsOn', label: 'Beginn', type: 'date', half: true, nullable },
    { name: 'endsOn', label: 'Ende', type: 'date', half: true, nullable },
    { name: 'reviewIntervalDays', label: 'Prüfzyklus in Tagen', type: 'number', half: true, hint: 'Ohne Zyklus keine Erinnerung.', nullable },
    { name: 'budgetAmount', label: 'Budget', type: 'number', half: true, suffix: 'CHF', nullable },
    { name: 'expectedRoiPct', label: 'Erwarteter ROI', type: 'number', half: true, suffix: '%', nullable },
    { name: 'description', label: 'Beschreibung', type: 'textarea', rows: 4, nullable },
  ];
}
