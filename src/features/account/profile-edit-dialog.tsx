'use client';

import { FormDialog } from '@/features/fuehrung/resource-form';
import type { ProfileContactValues } from './profile-details';

const LOCALES = [
  { value: 'DE', label: 'Deutsch' },
  { value: 'FR', label: 'Französisch' },
  { value: 'IT', label: 'Italienisch' },
  { value: 'EN', label: 'Englisch' },
];

/**
 * Kontaktdaten in einem Dialog bearbeiten.
 *
 * Die Zeilen der Karte lassen sich weiterhin einzeln ändern — der Stift
 * erscheint aber erst beim Überfahren, und wer die Seite zum ersten Mal
 * öffnet, sieht keinen Weg zum Bearbeiten. Der Knopf in der Kopfzeile ist
 * dieser sichtbare Weg: alle vier Angaben auf einmal, für den Fall, dass
 * jemand nach einem Umzug oder einer Heirat mehr als eine Zeile nachführt.
 *
 * Gespeichert wird über denselben Endpunkt wie die Einzelzeilen
 * (`PATCH /api/account/profile`); Vor- und Nachname sind dort Pflicht.
 */
export function ProfileEditDialog({ values }: { values: ProfileContactValues }) {
  return (
    <FormDialog
      title="Kontaktdaten bearbeiten"
      description="Name, Telefon und Sprache. Die E-Mail-Adresse ändern Sie über einen Bestätigungslink."
      triggerLabel="Bearbeiten"
      triggerVariant="outline"
      triggerSize="sm"
      plainTrigger
      size="md"
      endpoint="/api/account/profile"
      method="PATCH"
      successMessage="Kontaktdaten gespeichert."
      fields={[
        { name: 'firstName', label: 'Vorname', required: true, half: true },
        { name: 'lastName', label: 'Nachname', required: true, half: true },
        { name: 'phone', label: 'Telefon', type: 'text', half: true, placeholder: '079 123 45 67', hint: 'Für Terminerinnerungen per SMS und Rückfragen.', nullable: true },
        { name: 'locale', label: 'Sprache', type: 'select', half: true, options: LOCALES, required: true, hint: 'Für E-Mails und Dokumente.' },
      ]}
      values={{ firstName: values.firstName, lastName: values.lastName, phone: values.phone, locale: values.locale }}
    />
  );
}
