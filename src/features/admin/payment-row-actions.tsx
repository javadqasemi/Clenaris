'use client';

import { PenLine, Trash2 } from 'lucide-react';

import { ActionButton } from '@/components/app/action-button';
import { FormDialog, type FieldSpec } from '@/components/app/resource-form';

/**
 * Zahlung korrigieren oder stornieren.
 *
 * Korrigierbar sind Beleg, Notiz und Datum — nie der Betrag; ein falscher
 * Betrag wird storniert und neu verbucht, sonst liefen Rechnungssaldo und
 * Zahlungssumme auseinander. Stornieren geht nur bei von Hand erfassten
 * Zahlungen: Was über den Zahlungsanbieter hereinkam, ist dort eine Tatsache.
 * Beides prüft der Endpunkt; die Schaltflächen zeigen die Regel vorab.
 */
const FIELDS: FieldSpec[] = [
  { name: 'reference', label: 'Referenz', emptyAsString: true, half: true },
  { name: 'paidAt', label: 'Zahlungsdatum', type: 'datetime', half: true },
  { name: 'note', label: 'Notiz', type: 'textarea', rows: 2, emptyAsString: true },
];

export function PaymentRowActions({
  paymentId,
  amountLabel,
  reference,
  note,
  paidAt,
  manual,
  canEdit,
  canDelete,
}: {
  paymentId: string;
  amountLabel: string;
  reference: string | null;
  note: string | null;
  paidAt: string | null;
  manual: boolean;
  canEdit: boolean;
  canDelete: boolean;
}) {
  return (
    <div className="flex items-center justify-end gap-1">
      {canEdit ? (
        <FormDialog
          title="Zahlung korrigieren"
          description="Beleg, Datum und Notiz. Der Betrag bleibt — ein falscher Betrag wird storniert und neu verbucht."
          triggerLabel="Korrigieren"
          triggerVariant="ghost"
          triggerSize="icon"
          triggerIcon={<PenLine aria-hidden />}
          size="md"
          endpoint={`/api/payments/${paymentId}`}
          method="PATCH"
          fields={FIELDS}
          values={{ reference: reference ?? '', note: note ?? '', paidAt: paidAt ?? '' }}
          successMessage="Zahlung korrigiert."
        />
      ) : null}
      {canDelete ? (
        <ActionButton
          endpoint={`/api/payments/${paymentId}`}
          method="DELETE"
          label="Stornieren"
          aria-label={`Zahlung über ${amountLabel} stornieren`}
          variant="ghost"
          size="icon"
          disabled={!manual}
          confirmTitle="Zahlung stornieren?"
          confirm={`Die Zahlung über ${amountLabel} wird entfernt und der offene Posten der Rechnung wieder erhöht. Das ist nur für von Hand erfasste Zahlungen möglich.`}
          successMessage="Zahlung storniert."
        >
          <Trash2 aria-hidden />
        </ActionButton>
      ) : null}
    </div>
  );
}
