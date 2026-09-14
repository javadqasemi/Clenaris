'use client';

import { PenLine, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { ActionButton } from '@/components/app/action-button';
import { FormDialog, type FieldSpec } from '@/components/app/resource-form';
import { EmptyState } from '@/components/app/page-parts';

/**
 * Lieferanten pflegen.
 *
 * Die Endpunkte gab es; eine Maske nicht. Ein Lieferant liess sich deshalb
 * nur über den Seed anlegen — und die Ausgabenmaske bot in ihrer Auswahl
 * genau die Lieferanten an, die zufällig dort standen.
 *
 * Löschen ist nur ohne Belege möglich (der Endpunkt prüft das); der Weg für
 * einen Lieferanten, mit dem man nicht mehr arbeitet, ist „inaktiv" — er
 * verschwindet aus der Auswahl und bleibt in alten Belegen lesbar.
 */
export interface SupplierRow {
  id: string;
  name: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  street: string | null;
  postalCode: string | null;
  city: string | null;
  vatNumber: string | null;
  iban: string | null;
  paymentTermDays: number;
  notes: string | null;
  active: boolean;
  expenses: number;
}

const FIELDS: FieldSpec[] = [
  { name: 'name', label: 'Name', required: true },
  { name: 'contactName', label: 'Ansprechperson', half: true, nullable: true },
  { name: 'email', label: 'E-Mail', type: 'email', half: true, emptyAsString: true },
  { name: 'phone', label: 'Telefon', type: 'tel', half: true, nullable: true },
  { name: 'vatNumber', label: 'MWST-Nummer', half: true, nullable: true, placeholder: 'CHE-123.456.789 MWST' },
  { name: 'street', label: 'Strasse', nullable: true },
  { name: 'postalCode', label: 'PLZ', half: true, nullable: true },
  { name: 'city', label: 'Ort', half: true, nullable: true },
  { name: 'iban', label: 'IBAN', half: true, nullable: true },
  { name: 'paymentTermDays', label: 'Zahlungsfrist', type: 'number', suffix: 'Tage', half: true, min: 0, max: 180 },
  { name: 'notes', label: 'Notizen', type: 'textarea', rows: 2, nullable: true },
];

const EDIT_FIELDS: FieldSpec[] = [
  ...FIELDS,
  { name: 'active', label: 'Aktiv — in der Ausgabenmaske wählbar', type: 'checkbox' },
];

export function SupplierCreateButton() {
  return (
    <FormDialog
      title="Lieferant erfassen"
      triggerLabel="Lieferant erfassen"
      triggerVariant="outline"
      endpoint="/api/suppliers"
      fields={FIELDS}
      values={{ paymentTermDays: 30 }}
      successMessage="Lieferant erfasst."
    />
  );
}

export function SupplierList({ suppliers, canEdit, canDelete }: { suppliers: SupplierRow[]; canEdit: boolean; canDelete: boolean }) {
  if (suppliers.length === 0) {
    return (
      <EmptyState
        title="Keine Lieferanten"
        description="Ein Lieferant am Beleg macht die Ausgabe im Buchhaltungsexport zuordenbar."
      />
    );
  }

  return (
    <dl className="protocol-list">
      {suppliers.map((supplier) => (
        <div key={supplier.id} className="protocol-row">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <dt className="protocol-label">{supplier.name}</dt>
              <dd className="protocol-value flex flex-wrap items-center gap-2 font-normal">
                <Badge variant={supplier.active ? 'success' : 'neutral'} size="sm">
                  {supplier.active ? 'Aktiv' : 'Inaktiv'}
                </Badge>
                <span className="text-sm text-muted-foreground">
                  {[
                    supplier.contactName,
                    supplier.email,
                    supplier.city ? `${supplier.postalCode ?? ''} ${supplier.city}`.trim() : null,
                    `${supplier.expenses} ${supplier.expenses === 1 ? 'Beleg' : 'Belege'}`,
                    `${supplier.paymentTermDays} Tage`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </dd>
            </div>
            {canEdit ? (
              <div className="flex shrink-0 items-center gap-1">
                <FormDialog
                  title={`${supplier.name} bearbeiten`}
                  triggerLabel="Bearbeiten"
                  triggerVariant="ghost"
                  triggerSize="icon"
                  triggerIcon={<PenLine aria-hidden />}
                  endpoint={`/api/suppliers/${supplier.id}`}
                  method="PATCH"
                  fields={EDIT_FIELDS}
                  values={{
                    name: supplier.name,
                    contactName: supplier.contactName ?? '',
                    email: supplier.email ?? '',
                    phone: supplier.phone ?? '',
                    vatNumber: supplier.vatNumber ?? '',
                    street: supplier.street ?? '',
                    postalCode: supplier.postalCode ?? '',
                    city: supplier.city ?? '',
                    iban: supplier.iban ?? '',
                    paymentTermDays: supplier.paymentTermDays,
                    notes: supplier.notes ?? '',
                    active: supplier.active,
                  }}
                  successMessage="Lieferant geändert."
                />
                {canDelete ? (
                  <ActionButton
                    endpoint={`/api/suppliers/${supplier.id}`}
                    method="DELETE"
                    label="Löschen"
                    aria-label={`${supplier.name} löschen`}
                    variant="ghost"
                    size="icon"
                    disabled={supplier.expenses > 0}
                    confirmTitle="Lieferant löschen?"
                    confirm={`„${supplier.name}" wird entfernt. Ein Lieferant mit Belegen lässt sich nur auf inaktiv setzen.`}
                    successMessage="Lieferant gelöscht."
                  >
                    <Trash2 aria-hidden />
                  </ActionButton>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ))}
    </dl>
  );
}
