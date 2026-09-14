'use client';

import { PenLine, Trash2 } from 'lucide-react';

import { ActionButton } from '@/components/app/action-button';
import { FormDialog, type FieldSpec } from '@/components/app/resource-form';

/**
 * Stammdaten einer Kundschaft ändern und die Akte in den Papierkorb legen.
 *
 * Beides gab es als Endpunkt (`PATCH`/`DELETE /api/customers/:id`), aber die
 * Kundenakte bot nur Adressen und Zusammenführen an. Eine falsch erfasste
 * Telefonnummer liess sich nicht korrigieren, ohne die Akte neu anzulegen.
 *
 * Die Adressen bleiben im eigenen Abschnitt (`AddressManager`): Eine
 * Kundschaft hat mehrere, und genau eine davon ist die Standardadresse — das
 * passt in kein einzelnes Formularfeld.
 */
export interface CustomerEditValues {
  type: string;
  companyName: string | null;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  mobile: string | null;
  vatNumber: string | null;
  language: string;
  paymentTermDays: number;
  discountPercent: number;
  taxExempt: boolean;
  blocked: boolean;
  blockedReason: string | null;
  notes: string | null;
  internalNotes: string | null;
}

const FIELDS: FieldSpec[] = [
  {
    name: 'type',
    label: 'Kundentyp',
    type: 'select',
    required: true,
    half: true,
    options: [
      { value: 'PRIVATE', label: 'Privatkunde' },
      { value: 'BUSINESS', label: 'Geschäftskunde' },
    ],
  },
  { name: 'companyName', label: 'Firma', half: true, emptyAsString: true, hint: 'Für Geschäftskunden erforderlich.' },
  { name: 'firstName', label: 'Vorname', required: true, half: true },
  { name: 'lastName', label: 'Nachname', required: true, half: true },
  { name: 'email', label: 'E-Mail', type: 'email', required: true, half: true },
  {
    name: 'language',
    label: 'Sprache',
    type: 'select',
    required: true,
    half: true,
    options: [
      { value: 'DE', label: 'Deutsch' },
      { value: 'FR', label: 'Französisch' },
      { value: 'IT', label: 'Italienisch' },
      { value: 'EN', label: 'Englisch' },
    ],
  },
  { name: 'phone', label: 'Telefon', type: 'tel', half: true, emptyAsString: true },
  { name: 'mobile', label: 'Mobil', type: 'tel', half: true, emptyAsString: true },
  { name: 'vatNumber', label: 'MWST-Nummer', half: true, emptyAsString: true },
  { name: 'paymentTermDays', label: 'Zahlungsfrist', type: 'number', suffix: 'Tage', half: true, min: 0, max: 180 },
  { name: 'discountPercent', label: 'Rabatt', type: 'number', suffix: '%', half: true, min: 0, max: 100 },
  { name: 'taxExempt', label: 'Von der MWST befreit', type: 'checkbox' },
  { name: 'blocked', label: 'Gesperrt — keine neuen Buchungen', type: 'checkbox' },
  { name: 'blockedReason', label: 'Grund der Sperre', emptyAsString: true },
  { name: 'notes', label: 'Notizen (für die Kundschaft sichtbar)', type: 'textarea', rows: 2, emptyAsString: true },
  { name: 'internalNotes', label: 'Interne Notizen', type: 'textarea', rows: 3, emptyAsString: true },
];

export function CustomerEditDialog({
  customerId,
  values,
}: {
  customerId: string;
  values: CustomerEditValues;
}) {
  return (
    <FormDialog
      title="Kundendaten bearbeiten"
      triggerLabel="Bearbeiten"
      triggerVariant="outline"
      plainTrigger
      triggerIcon={<PenLine aria-hidden />}
      endpoint={`/api/customers/${customerId}`}
      method="PATCH"
      fields={FIELDS}
      values={{
        ...values,
        companyName: values.companyName ?? '',
        phone: values.phone ?? '',
        mobile: values.mobile ?? '',
        vatNumber: values.vatNumber ?? '',
        blockedReason: values.blockedReason ?? '',
        notes: values.notes ?? '',
        internalNotes: values.internalNotes ?? '',
      }}
      successMessage="Kundendaten gespeichert."
    />
  );
}

export function CustomerDeleteButton({ customerId, name }: { customerId: string; name: string }) {
  return (
    <ActionButton
      endpoint={`/api/customers/${customerId}`}
      method="DELETE"
      label="In den Papierkorb"
      variant="outline"
      size="default"
      redirectTo="/admin/kunden"
      confirmTitle="Kundschaft in den Papierkorb legen?"
      confirm={`${name} verschwindet aus allen Listen, bleibt aber unter „Papierkorb" wiederherstellbar. Rechnungen und Buchungen werden nicht mitgelöscht. Bei offenen Posten oder geplanten Terminen verweigert der Server das Löschen.`}
      successMessage="Kundschaft in den Papierkorb gelegt."
    >
      <Trash2 aria-hidden />
    </ActionButton>
  );
}
