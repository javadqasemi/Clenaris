import type { FieldSpec } from '@/components/app/resource-form';

/**
 * Feldbeschreibung der Gutschrift zu einer Rechnung (Wave 13). Ohne
 * `'use client'` — die Rechnungsseite ist eine Serverkomponente.
 */
export function creditNoteFields(): FieldSpec[] {
  return [
    { name: 'reason', label: 'Grund', required: true, placeholder: 'z. B. Einsatz verspätet, Leistung nicht vollständig' },
    { name: 'name', label: 'Bezeichnung auf dem Beleg', required: true },
    { name: 'quantity', label: 'Menge', type: 'number', step: 0.5, half: true },
    { name: 'unitPrice', label: 'Betrag netto', type: 'number', step: 0.05, suffix: 'CHF', half: true, required: true },
    { name: 'vatRate', label: 'MWST', type: 'number', step: 0.1, suffix: '%', half: true },
  ];
}
