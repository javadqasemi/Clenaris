'use client';

import { Pencil } from 'lucide-react';

import { FormDialog, type FieldSpec } from '@/components/app/resource-form';

/**
 * Einsatz bearbeiten — Titel, Termin, Dauer, Besetzung und Notizen.
 *
 * **Warum ein Dialog und keine eigene Seite.** Einsätze entstehen aus
 * Buchungen, nicht über ein Anlegeformular; es gibt also kein `/neu`, dessen
 * Formular eine Bearbeitungsseite wiederverwenden könnte. Die Felder, die man
 * an einem bestehenden Einsatz ändert, sind wenige und flach — das Team hat
 * seinen eigenen Editor in der Seitenspalte, die Checkliste ihren, das
 * Material seinen. Was hier steht, ist der Rest: die Angaben zum Auftrag.
 *
 * Die Notizfelder senden eine leere Zeichenkette statt nichts
 * (`emptyAsString`), damit sich eine Notiz auch *löschen* lässt; der Dienst
 * legt daraus `null` ab.
 */
export interface JobEditValues {
  title: string;
  scheduledStart: string;
  scheduledEnd: string;
  crewSize: number;
  estimatedMin: number;
  travelMin: number;
  description: string | null;
  customerNote: string | null;
  internalNote: string | null;
}

const FIELDS: FieldSpec[] = [
  { name: 'title', label: 'Titel', required: true },
  { name: 'scheduledStart', label: 'Beginn', type: 'datetime', required: true, half: true },
  { name: 'scheduledEnd', label: 'Ende', type: 'datetime', required: true, half: true },
  {
    name: 'estimatedMin',
    label: 'Geplante Dauer',
    type: 'number',
    suffix: 'Min.',
    half: true,
    min: 15,
    max: 1440,
    hint: 'Je Person; zählt bei der Herleitung der Lohnkosten, solange keine Zeit erfasst ist.',
  },
  {
    name: 'travelMin',
    label: 'Anfahrt',
    type: 'number',
    suffix: 'Min.',
    half: true,
    min: 0,
    max: 480,
  },
  {
    name: 'crewSize',
    label: 'Vorgesehene Besetzung',
    type: 'number',
    suffix: 'Personen',
    half: true,
    min: 1,
    max: 20,
    hint: 'Wer tatsächlich eingeteilt ist, steht im Team rechts.',
  },
  { name: 'description', label: 'Beschreibung', type: 'textarea', rows: 3, emptyAsString: true },
  {
    name: 'customerNote',
    label: 'Anmerkung der Kundschaft',
    type: 'textarea',
    rows: 2,
    emptyAsString: true,
  },
  { name: 'internalNote', label: 'Interne Notiz', type: 'textarea', rows: 2, emptyAsString: true },
];

export function JobEditDialog({ jobId, values }: { jobId: string; values: JobEditValues }) {
  return (
    <FormDialog
      title="Einsatz bearbeiten"
      description="Termin, Dauer und Notizen. Team, Checkliste und Material bearbeiten Sie direkt in den jeweiligen Abschnitten."
      triggerLabel="Bearbeiten"
      triggerVariant="outline"
      triggerIcon={<Pencil aria-hidden />}
      plainTrigger
      endpoint={`/api/jobs/${jobId}`}
      method="PATCH"
      submitLabel="Änderungen speichern"
      successMessage="Einsatz gespeichert."
      fields={FIELDS}
      values={{ ...values }}
    />
  );
}
