'use client';

import { PenLine, UserRoundX } from 'lucide-react';

import { ActionButton } from '@/components/app/action-button';
import { FormDialog, type FieldSpec } from '@/components/app/resource-form';

/**
 * Personalakte ändern und stilllegen.
 *
 * `PATCH /api/employees/:id` bestand; die Akte war trotzdem nur lesbar. Ein
 * geändertes Pensum oder eine neue Aufenthaltsbewilligung brauchte den
 * Umweg über die API.
 *
 * Lohn, AHV-Nummer und IBAN erscheinen nur, wenn die Seite sie auch liefert
 * (`sensitive`): Die Betriebsleitung bekommt sie vom Dienst gar nicht erst,
 * und ein Formularfeld, das leer ankommt und leer zurückgeht, würde beim
 * Speichern still eine gültige AHV-Nummer löschen.
 *
 * Stilllegen ist kein Löschen (siehe `DELETE /api/employees/:id`): Die Akte
 * bleibt für Zeiterfassung und Lohnabrechnung erhalten, der Zugang wird
 * entzogen.
 */
export interface EmployeeEditValues {
  position: string;
  department: string | null;
  employmentType: string;
  hiredAt: string;
  workloadPct: number;
  vacationDaysPerYear: number;
  permitType: string | null;
  permitValidUntil: string | null;
  emergencyContact: string | null;
  emergencyPhone: string | null;
  driverLicense: boolean;
  vehiclePlate: string | null;
  languages: string[];
  color: string;
  hourlyRate?: number | null;
  monthlySalary?: number | null;
  ahvNumber?: string | null;
  iban?: string | null;
}

const EMPLOYMENT_OPTIONS = [
  { value: 'FULL_TIME', label: 'Vollzeit' },
  { value: 'PART_TIME', label: 'Teilzeit' },
  { value: 'HOURLY', label: 'Im Stundenlohn' },
  { value: 'TEMPORARY', label: 'Befristet' },
  { value: 'APPRENTICE', label: 'Lernende/r' },
  { value: 'CONTRACTOR', label: 'Auf Mandat' },
];

const PERMIT_OPTIONS = ['CH', 'B', 'C', 'G', 'L', 'F', 'N'].map((value) => ({ value, label: value }));

const BASE_FIELDS: FieldSpec[] = [
  { name: 'position', label: 'Funktion', required: true, half: true },
  { name: 'department', label: 'Abteilung', half: true, nullable: true },
  { name: 'employmentType', label: 'Anstellung', type: 'select', required: true, half: true, options: EMPLOYMENT_OPTIONS },
  { name: 'hiredAt', label: 'Eintritt', type: 'date', required: true, half: true },
  { name: 'workloadPct', label: 'Pensum', type: 'number', suffix: '%', half: true, min: 10, max: 100 },
  { name: 'vacationDaysPerYear', label: 'Ferienanspruch', type: 'number', suffix: 'Tage', half: true, min: 0, max: 60 },
  { name: 'permitType', label: 'Bewilligung', type: 'select', half: true, options: PERMIT_OPTIONS, nullable: true },
  { name: 'permitValidUntil', label: 'Bewilligung gültig bis', type: 'date', half: true, nullable: true },
  { name: 'emergencyContact', label: 'Notfallkontakt', half: true, nullable: true },
  { name: 'emergencyPhone', label: 'Notfallnummer', type: 'tel', half: true, nullable: true },
  { name: 'driverLicense', label: 'Führerausweis', type: 'checkbox' },
  { name: 'vehiclePlate', label: 'Kontrollschild', half: true, nullable: true },
  { name: 'languages', label: 'Sprachen', type: 'tags', half: true, hint: 'DE, FR, IT, EN — mit Komma trennen.' },
  { name: 'color', label: 'Kalenderfarbe', half: true, placeholder: '#0B7285' },
];

const SENSITIVE_FIELDS: FieldSpec[] = [
  { name: 'hourlyRate', label: 'Stundenansatz', type: 'number', suffix: 'CHF', half: true, nullable: true },
  { name: 'monthlySalary', label: 'Monatslohn', type: 'number', suffix: 'CHF', half: true, nullable: true },
  { name: 'ahvNumber', label: 'AHV-Nummer', half: true, nullable: true, placeholder: '756.1234.5678.90' },
  { name: 'iban', label: 'IBAN', half: true, nullable: true },
];

export function EmployeeEditDialog({
  employeeId,
  values,
  sensitive,
}: {
  employeeId: string;
  values: EmployeeEditValues;
  sensitive: boolean;
}) {
  return (
    <FormDialog
      title="Personalakte bearbeiten"
      triggerLabel="Bearbeiten"
      triggerVariant="outline"
      plainTrigger
      triggerIcon={<PenLine aria-hidden />}
      endpoint={`/api/employees/${employeeId}`}
      method="PATCH"
      fields={sensitive ? [...BASE_FIELDS, ...SENSITIVE_FIELDS] : BASE_FIELDS}
      values={{
        ...values,
        department: values.department ?? '',
        permitType: values.permitType ?? '',
        permitValidUntil: values.permitValidUntil ?? '',
        emergencyContact: values.emergencyContact ?? '',
        emergencyPhone: values.emergencyPhone ?? '',
        vehiclePlate: values.vehiclePlate ?? '',
        hourlyRate: values.hourlyRate ?? '',
        monthlySalary: values.monthlySalary ?? '',
        ahvNumber: values.ahvNumber ?? '',
        iban: values.iban ?? '',
      }}
      successMessage="Personalakte gespeichert."
    />
  );
}

export function EmployeeDeactivateButton({
  employeeId,
  name,
  active,
}: {
  employeeId: string;
  name: string;
  active: boolean;
}) {
  if (!active) {
    return (
      <ActionButton
        endpoint={`/api/employees/${employeeId}`}
        method="PATCH"
        body={{ active: true }}
        label="Wieder aktivieren"
        variant="outline"
        size="default"
        confirmTitle="Person wieder aktivieren?"
        confirm={`${name} erscheint wieder in Disposition und Zuteilung. Den Zugang zum Portal schalten Sie in der Benutzerverwaltung frei.`}
        successMessage="Person wieder aktiviert."
      />
    );
  }

  return (
    <ActionButton
      endpoint={`/api/employees/${employeeId}`}
      method="DELETE"
      label="Stilllegen"
      variant="outline"
      size="default"
      confirmTitle="Person stilllegen?"
      confirm={`${name} wird als ausgetreten geführt und kann sich nicht mehr anmelden. Zeiterfassung, Lohnabrechnungen und Einsatzrapporte bleiben erhalten. Sind noch Einsätze zugeteilt, verweigert der Server den Schritt.`}
      successMessage="Person stillgelegt."
    >
      <UserRoundX aria-hidden />
    </ActionButton>
  );
}
