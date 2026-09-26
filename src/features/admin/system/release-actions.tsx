'use client';

import { CalendarClock, CheckCircle2, Clock3, XCircle } from 'lucide-react';

import { ActionButton } from '@/components/app/action-button';
import { FormDialog, type FieldSpec } from '@/components/app/resource-form';

/**
 * Die Entscheidungen zu einer Version: freigeben, terminieren, Termin
 * stornieren, zurückstellen.
 *
 * Welche Schaltfläche erscheint, entscheidet der Zustand, den der Server
 * mitgibt — der Endpunkt prüft denselben Übergang ein zweites Mal und
 * antwortet mit 422, falls jemand in einem zweiten Fenster schneller war.
 * Keine dieser Schaltflächen rollt etwas aus; der Hinweis dazu steht auf der
 * Seite, nicht in jedem Dialog, damit er nicht zur überlesenen Floskel wird.
 */

const TERMIN_FELDER: FieldSpec[] = [
  {
    name: 'scheduledFor',
    label: 'Zeitpunkt (Ortszeit Zürich)',
    type: 'datetime',
    required: true,
    hint: 'Frühestens in 15 Minuten, spätestens in 90 Tagen. Ausserhalb der Einsatzzeiten wählen.',
  },
];

export function ReleaseActions({
  releaseId,
  version,
  zustand,
  termin,
}: {
  releaseId: string;
  version: string;
  zustand: 'AVAILABLE' | 'APPROVED' | 'SCHEDULED' | 'INSTALLED' | 'OLDER';
  /** Bestehender Termin als ISO-Zeichenkette, zum Vorbelegen beim Verschieben. */
  termin: string | null;
}) {
  const basis = `/api/system/releases/${releaseId}`;

  if (zustand === 'INSTALLED' || zustand === 'OLDER') return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {zustand === 'AVAILABLE' ? (
        <>
          <ActionButton
            endpoint={`${basis}/zurueckstellen`}
            label="Nicht jetzt"
            variant="ghost"
            confirmTitle={`Version ${version} zurückstellen?`}
            confirm="Das Dashboard blendet den Hinweis sieben Tage lang aus. Die Entscheidung steht im Prüfprotokoll; freigeben lässt sich die Version jederzeit."
            successMessage="Für sieben Tage zurückgestellt."
          >
            <Clock3 aria-hidden />
          </ActionButton>
          <ActionButton
            endpoint={`${basis}/freigabe`}
            label="Freigeben"
            variant="default"
            confirmTitle={`Version ${version} freigeben?`}
            confirm="Die Freigabe legt einen Aktualisierungsauftrag an und steht mit Ihrem Namen im Prüfprotokoll. Ausgerollt wird dadurch nichts — erst ein Termin macht den Auftrag für das Deployment-Werkzeug ausführbar."
            successMessage={`Version ${version} freigegeben.`}
          >
            <CheckCircle2 aria-hidden />
          </ActionButton>
        </>
      ) : null}

      {zustand !== 'SCHEDULED' ? (
        <FormDialog
          title={`Version ${version} terminieren`}
          description={
            zustand === 'AVAILABLE'
              ? 'Ein Termin schliesst die Freigabe ein. Das Update wird durch das externe Deployment-Werkzeug ausgeführt, nicht durch diese Anwendung.'
              : 'Das Update wird zum gewählten Zeitpunkt durch das externe Deployment-Werkzeug ausgeführt, nicht durch diese Anwendung.'
          }
          triggerLabel="Terminieren"
          triggerVariant="outline"
          triggerIcon={<CalendarClock aria-hidden />}
          size="md"
          fields={TERMIN_FELDER}
          endpoint={`${basis}/termin`}
          method="PUT"
          submitLabel="Termin setzen"
          successMessage="Termin gesetzt."
        />
      ) : (
        <>
          <FormDialog
            title={`Termin für ${version} verschieben`}
            triggerLabel="Verschieben"
            triggerVariant="outline"
            triggerIcon={<CalendarClock aria-hidden />}
            size="md"
            fields={TERMIN_FELDER}
            values={{ scheduledFor: termin }}
            endpoint={`${basis}/termin`}
            method="PUT"
            submitLabel="Termin verschieben"
            successMessage="Termin verschoben."
          />
          <ActionButton
            endpoint={`${basis}/termin/stornieren`}
            label="Termin stornieren"
            variant="outline"
            withNote
            noteField="grund"
            noteLabel="Grund (steht im Prüfprotokoll)"
            confirmTitle={`Termin für ${version} stornieren?`}
            confirm="Der Auftrag wird storniert und bleibt als Nachweis stehen. Die Version ist danach wieder verfügbar und kann erneut freigegeben werden."
            successMessage="Termin storniert."
          >
            <XCircle aria-hidden />
          </ActionButton>
        </>
      )}
    </div>
  );
}
