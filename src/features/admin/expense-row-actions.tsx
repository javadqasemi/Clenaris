'use client';

import { CheckCircle2, PenLine, Trash2 } from 'lucide-react';

import { ActionButton } from '@/components/app/action-button';
import { FormDialog, type FieldSpec } from '@/components/app/resource-form';

/**
 * Handlungen an einer Ausgabe: korrigieren, als bezahlt markieren, löschen.
 *
 * Die Erfassungsmaske (`ExpenseDialog`) rechnet MWST und Brutto live mit —
 * für die Korrektur genügt das Standardformular, weil der Server die Summen
 * ohnehin neu rechnet, sobald Netto oder Satz ankommen.
 *
 * Löschen verweigert der Endpunkt, sobald die Ausgabe in einem
 * Buchhaltungsexport enthalten war; die Rückfrage sagt das voraus.
 */
export interface ExpenseRow {
  id: string;
  description: string;
  category: string;
  reference: string | null;
  supplierId: string | null;
  expenseDate: string;
  netAmount: number;
  vatRate: number;
  paid: boolean;
  vatDeductible: boolean;
  notes: string | null;
}

const CATEGORY_OPTIONS = [
  { value: 'MATERIAL', label: 'Material' },
  { value: 'EQUIPMENT', label: 'Geräte' },
  { value: 'VEHICLE', label: 'Fahrzeuge' },
  { value: 'FUEL', label: 'Treibstoff' },
  { value: 'INSURANCE', label: 'Versicherungen' },
  { value: 'RENT', label: 'Miete' },
  { value: 'SALARY', label: 'Löhne' },
  { value: 'SOCIAL_SECURITY', label: 'Sozialversicherungen' },
  { value: 'MARKETING', label: 'Marketing' },
  { value: 'SOFTWARE', label: 'Software' },
  { value: 'TRAINING', label: 'Weiterbildung' },
  { value: 'TAXES', label: 'Steuern' },
  { value: 'OTHER', label: 'Übriges' },
];

export function ExpenseRowActions({
  expense,
  suppliers,
  canEdit,
  canDelete,
}: {
  expense: ExpenseRow;
  suppliers: { id: string; name: string }[];
  canEdit: boolean;
  canDelete: boolean;
}) {
  const fields: FieldSpec[] = [
    { name: 'description', label: 'Beschreibung', required: true },
    { name: 'category', label: 'Kategorie', type: 'select', required: true, options: CATEGORY_OPTIONS, half: true },
    { name: 'expenseDate', label: 'Belegdatum', type: 'date', required: true, half: true },
    {
      name: 'supplierId',
      label: 'Lieferant',
      type: 'select',
      half: true,
      options: suppliers.map((supplier) => ({ value: supplier.id, label: supplier.name })),
      placeholder: 'Kein Lieferant',
      emptyAsString: true,
    },
    { name: 'reference', label: 'Belegnummer', half: true, emptyAsString: true },
    { name: 'netAmount', label: 'Betrag netto', type: 'number', suffix: 'CHF', half: true, required: true },
    { name: 'vatRate', label: 'MWST-Satz', type: 'number', suffix: '%', half: true, hint: 'Normalsatz 8.1 %, reduziert 2.6 %.' },
    { name: 'paid', label: 'Bezahlt', type: 'checkbox' },
    { name: 'vatDeductible', label: 'Vorsteuer abziehbar', type: 'checkbox' },
    { name: 'notes', label: 'Notiz', type: 'textarea', rows: 2, emptyAsString: true },
  ];

  return (
    <div className="flex items-center justify-end gap-1">
      {canEdit && !expense.paid ? (
        <ActionButton
          endpoint={`/api/expenses/${expense.id}`}
          method="PATCH"
          body={{ paid: true }}
          label="Bezahlt"
          aria-label={`${expense.description} als bezahlt markieren`}
          variant="ghost"
          size="icon"
          successMessage="Als bezahlt markiert."
        >
          <CheckCircle2 aria-hidden />
        </ActionButton>
      ) : null}
      {canEdit ? (
        <FormDialog
          title="Ausgabe korrigieren"
          triggerLabel="Bearbeiten"
          triggerVariant="ghost"
          triggerSize="icon"
          triggerIcon={<PenLine aria-hidden />}
          size="md"
          endpoint={`/api/expenses/${expense.id}`}
          method="PATCH"
          fields={fields}
          values={{
            description: expense.description,
            category: expense.category,
            expenseDate: expense.expenseDate,
            supplierId: expense.supplierId ?? '',
            reference: expense.reference ?? '',
            netAmount: expense.netAmount,
            vatRate: expense.vatRate,
            paid: expense.paid,
            vatDeductible: expense.vatDeductible,
            notes: expense.notes ?? '',
          }}
          successMessage="Ausgabe geändert."
        />
      ) : null}
      {canDelete ? (
        <ActionButton
          endpoint={`/api/expenses/${expense.id}`}
          method="DELETE"
          label="Löschen"
          aria-label={`${expense.description} löschen`}
          variant="ghost"
          size="icon"
          confirmTitle="Ausgabe löschen?"
          confirm={`„${expense.description}" wird endgültig entfernt. Liegt der Beleg in einem bereits exportierten Zeitraum, verweigert der Server das Löschen.`}
          successMessage="Ausgabe gelöscht."
        >
          <Trash2 aria-hidden />
        </ActionButton>
      ) : null}
    </div>
  );
}
