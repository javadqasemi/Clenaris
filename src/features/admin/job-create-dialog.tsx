'use client';

import { FormDialog, type FieldSpec } from '@/components/app/resource-form';

/**
 * Einsatz ohne Buchung anlegen.
 *
 * **Wofür.** Der übliche Weg zu einem Einsatz führt über eine Buchung, und so
 * soll es bleiben — dort hängen Preis, Kundenbestätigung und Rechnung dran.
 * Es gibt aber Einsätze, denen keine Buchung vorausgeht: eine Nachbesserung
 * nach einer Reklamation, ein Sonderauftrag auf Zuruf, eine Hauswartung, die
 * jemand am Telefon bestellt. Bis hierher liess sich so etwas gar nicht
 * erfassen — `createJob` war im Dienst fertig, aber über HTTP nicht
 * erreichbar.
 *
 * **Warum ein Dialog und keine eigene Seite.** Ein zweites Dispositionsmodul
 * wäre der falsche Weg; die Liste und der Kalender bleiben der Ort, an dem
 * Einsätze leben. Die Anlage ist ein kurzer Vorgang mit acht Feldern und
 * gehört deshalb in denselben `FormDialog`, den die übrigen Listen benutzen.
 *
 * **Ohne Team.** Wer hier einen Einsatz anlegt, legt ihn unbesetzt an; die
 * Einteilung passiert danach im Kalender oder auf der Detailseite, wo
 * Verfügbarkeit und Abwesenheiten sichtbar sind. Das Formular hier zeigt das
 * Feld gar nicht erst — ein Auswahlfeld mit allen Mitarbeitenden, das die
 * Serverregel anschliessend ablehnt, wäre eine Einladung zum Fehlversuch.
 */
export interface JobCreateCustomer {
  id: string;
  label: string;
}

export function JobCreateButton({
  customers,
  services,
}: {
  customers: JobCreateCustomer[];
  services: { id: string; name: string }[];
}) {
  const fields: FieldSpec[] = [
    {
      name: 'customerId',
      label: 'Kundschaft',
      type: 'select',
      required: true,
      options: customers.map((customer) => ({ value: customer.id, label: customer.label })),
      hint: 'Adresse und Objekt übernimmt der Einsatz aus der Kundenakte.',
    },
    { name: 'title', label: 'Titel', required: true, placeholder: 'z. B. Nachreinigung Büro Länggasse' },
    {
      name: 'serviceId',
      label: 'Leistung',
      type: 'select',
      options: [{ value: '', label: 'Ohne Zuordnung' }, ...services.map((s) => ({ value: s.id, label: s.name }))],
      half: true,
    },
    { name: 'crewSize', label: 'Personen', type: 'number', half: true },
    { name: 'scheduledStart', label: 'Beginn', type: 'datetime', required: true, half: true },
    { name: 'scheduledEnd', label: 'Ende', type: 'datetime', required: true, half: true },
    { name: 'estimatedMin', label: 'Geplante Dauer', type: 'number', suffix: 'Min.', half: true },
    { name: 'travelMin', label: 'Anfahrt', type: 'number', suffix: 'Min.', half: true },
    { name: 'description', label: 'Auftrag', type: 'textarea', rows: 3 },
    {
      name: 'internalNote',
      label: 'Interne Notiz',
      type: 'textarea',
      rows: 2,
      hint: 'Nur für das Büro und das eingeteilte Team — die Kundschaft sieht sie nie.',
    },
  ];

  return (
    <FormDialog
      title="Einsatz anlegen"
      description="Für Aufträge ohne vorangehende Buchung. Das Team teilen Sie danach im Kalender ein."
      triggerLabel="Einsatz anlegen"
      endpoint="/api/jobs"
      fields={fields}
      values={{ crewSize: 1, estimatedMin: 120, travelMin: 0 }}
      successMessage="Einsatz angelegt."
    />
  );
}

