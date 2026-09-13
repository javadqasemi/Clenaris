'use client';

import { PenLine, Trash2 } from 'lucide-react';

import { ActionButton } from '@/components/app/action-button';
import { FormDialog, type FieldSpec } from '@/components/app/resource-form';

/**
 * Objekt erfassen, ändern, in den Papierkorb legen.
 *
 * Geteilt zwischen Kundenakte (Büro) und Kundenbereich (Kundschaft), weil
 * beide dieselben Endpunkte ansprechen und die Rechte dort geprüft werden:
 * die Kundschaft darf nur an die eigene Akte hängen, und der Endpunkt prüft
 * das über `mayManagePropertyOf` — nicht dieses Formular.
 *
 * Die Adresse wird aus den bereits erfassten Adressen gewählt. Eine neue
 * Adresse entsteht im Adressabschnitt daneben; sie hier ein zweites Mal
 * erfassbar zu machen hätte zwei Wege für dieselbe Angabe ergeben, und die
 * Standard- und Rechnungsadresse liessen sich in einem Objektformular nicht
 * abbilden.
 */
export interface PropertyValues {
  label: string;
  kind: string;
  addressId: string | null;
  squareMeters: number | null;
  rooms: number | null;
  bathrooms: number | null;
  windows: number | null;
  floor: number | null;
  hasBalcony: boolean;
  hasGarden: boolean;
  hasPets: boolean;
  hasElevator: boolean;
  parkingInfo: string | null;
  keyLocation: string | null;
  accessNote: string | null;
  notes: string | null;
}

const KIND_OPTIONS = [
  { value: 'APARTMENT', label: 'Wohnung' },
  { value: 'HOUSE', label: 'Haus' },
  { value: 'OFFICE', label: 'Büro' },
  { value: 'COMMERCIAL', label: 'Ladenlokal' },
  { value: 'INDUSTRIAL', label: 'Gewerbe' },
  { value: 'CONSTRUCTION_SITE', label: 'Baustelle' },
  { value: 'PRACTICE', label: 'Praxis' },
  { value: 'RESTAURANT', label: 'Gastronomie' },
  { value: 'SCHOOL', label: 'Schule' },
  { value: 'OTHER', label: 'Anderes' },
];

function fields(
  addresses: { id: string; label: string }[],
  editing: boolean,
): FieldSpec[] {
  return [
    { name: 'label', label: 'Bezeichnung', required: true, half: true, placeholder: 'z. B. Wohnung Länggasse' },
    { name: 'kind', label: 'Objektart', type: 'select', required: true, half: true, options: KIND_OPTIONS },
    ...(editing
      ? []
      : [
          {
            name: 'addressId',
            label: 'Adresse',
            type: 'select' as const,
            required: true,
            options: addresses.map((address) => ({ value: address.id, label: address.label })),
            hint: 'Fehlt die Adresse, erfassen Sie sie zuerst im Abschnitt „Adressen".',
          },
        ]),
    { name: 'squareMeters', label: 'Fläche', type: 'number', suffix: 'm²', half: true, nullable: true },
    { name: 'rooms', label: 'Zimmer', type: 'number', half: true, nullable: true, step: 0.5 },
    { name: 'bathrooms', label: 'Bäder', type: 'number', half: true, nullable: true },
    { name: 'windows', label: 'Fenster', type: 'number', half: true, nullable: true },
    { name: 'floor', label: 'Stockwerk', type: 'number', half: true, nullable: true },
    { name: 'hasElevator', label: 'Lift vorhanden', type: 'checkbox' },
    { name: 'hasBalcony', label: 'Balkon', type: 'checkbox' },
    { name: 'hasGarden', label: 'Garten', type: 'checkbox' },
    { name: 'hasPets', label: 'Haustiere', type: 'checkbox' },
    { name: 'parkingInfo', label: 'Parkieren', nullable: true },
    { name: 'keyLocation', label: 'Schlüsseldepot', nullable: true, hint: 'Wo der Schlüssel liegt — nur für zugeteilte Mitarbeitende sichtbar.' },
    { name: 'accessNote', label: 'Zugangshinweis', type: 'textarea', rows: 2, nullable: true },
    { name: 'notes', label: 'Notizen', type: 'textarea', rows: 2, nullable: true },
  ];
}

export function PropertyCreateButton({
  customerId,
  addresses,
}: {
  customerId: string;
  addresses: { id: string; label: string }[];
}) {
  return (
    <FormDialog
      title="Objekt erfassen"
      description="Fläche, Zimmerzahl und Zugangshinweise beschleunigen jede weitere Buchung."
      triggerLabel="Objekt erfassen"
      triggerVariant="outline"
      triggerSize="sm"
      endpoint="/api/properties"
      fields={fields(addresses, false)}
      values={{ kind: 'APARTMENT', addressId: addresses[0]?.id ?? '' }}
      extra={{ customerId }}
      successMessage="Objekt erfasst."
    />
  );
}

export function PropertyRowActions({
  propertyId,
  values,
  canDelete,
}: {
  propertyId: string;
  values: PropertyValues;
  canDelete: boolean;
}) {
  return (
    <div className="flex items-center gap-1">
      <FormDialog
        title="Objekt bearbeiten"
        triggerLabel="Bearbeiten"
        triggerVariant="ghost"
        triggerSize="icon"
        triggerIcon={<PenLine aria-hidden />}
        endpoint={`/api/properties/${propertyId}`}
        method="PATCH"
        fields={fields([], true)}
        values={{
          ...values,
          squareMeters: values.squareMeters ?? '',
          rooms: values.rooms ?? '',
          bathrooms: values.bathrooms ?? '',
          windows: values.windows ?? '',
          floor: values.floor ?? '',
          parkingInfo: values.parkingInfo ?? '',
          keyLocation: values.keyLocation ?? '',
          accessNote: values.accessNote ?? '',
          notes: values.notes ?? '',
        }}
        successMessage="Objekt geändert."
      />
      {canDelete ? (
        <ActionButton
          endpoint={`/api/properties/${propertyId}`}
          method="DELETE"
          label="In den Papierkorb"
          aria-label={`${values.label} in den Papierkorb legen`}
          variant="ghost"
          size="icon"
          confirmTitle="Objekt in den Papierkorb legen?"
          confirm={`„${values.label}" verschwindet aus den Listen, bleibt aber wiederherstellbar. Sind Einsätze geplant, verweigert der Server das Löschen.`}
          successMessage="Objekt in den Papierkorb gelegt."
        >
          <Trash2 aria-hidden />
        </ActionButton>
      ) : null}
    </div>
  );
}
