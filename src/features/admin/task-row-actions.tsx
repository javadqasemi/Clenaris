'use client';

import { PenLine, Trash2 } from 'lucide-react';

import { ActionButton } from '@/components/app/action-button';
import { FormDialog, type FieldSpec } from '@/components/app/resource-form';

/**
 * Aufgabe bearbeiten und entfernen.
 *
 * Abhaken und Anlegen gab es (`TaskToggle`, `TaskComposer`); eine falsch
 * terminierte oder falsch zugewiesene Aufgabe liess sich aber nur
 * abschliessen und neu erfassen. `PATCH` und `DELETE /api/tasks/:id`
 * bestanden dafür längst.
 */
export interface TaskValues {
  title: string;
  description: string | null;
  priority: string;
  dueAt: string | null;
  assigneeId: string | null;
}

const PRIORITY_OPTIONS = [
  { value: 'LOW', label: 'Tief' },
  { value: 'NORMAL', label: 'Normal' },
  { value: 'HIGH', label: 'Hoch' },
  { value: 'URGENT', label: 'Dringend' },
];

export function TaskRowActions({
  taskId,
  values,
  staff,
  canEdit,
  canDelete,
}: {
  taskId: string;
  values: TaskValues;
  staff: { id: string; name: string }[];
  canEdit: boolean;
  canDelete: boolean;
}) {
  const fields: FieldSpec[] = [
    { name: 'title', label: 'Was ist zu tun?', required: true },
    { name: 'description', label: 'Details', type: 'textarea', rows: 2, emptyAsString: true },
    {
      name: 'assigneeId',
      label: 'Zuständig',
      type: 'select',
      half: true,
      options: staff.map((person) => ({ value: person.id, label: person.name })),
      placeholder: 'Niemand',
    },
    { name: 'priority', label: 'Priorität', type: 'select', required: true, half: true, options: PRIORITY_OPTIONS },
    { name: 'dueAt', label: 'Fällig am', type: 'datetime', half: true },
  ];

  return (
    <div className="flex shrink-0 items-center gap-1">
      {canEdit ? (
        <FormDialog
          title="Aufgabe bearbeiten"
          triggerLabel="Bearbeiten"
          triggerVariant="ghost"
          triggerSize="icon"
          triggerIcon={<PenLine aria-hidden />}
          size="md"
          endpoint={`/api/tasks/${taskId}`}
          method="PATCH"
          fields={fields}
          values={{
            ...values,
            description: values.description ?? '',
            dueAt: values.dueAt ?? '',
            assigneeId: values.assigneeId ?? '',
          }}
          successMessage="Aufgabe geändert."
        />
      ) : null}
      {canDelete ? (
        <ActionButton
          endpoint={`/api/tasks/${taskId}`}
          method="DELETE"
          label="Löschen"
          aria-label={`Aufgabe „${values.title}" löschen`}
          variant="ghost"
          size="icon"
          confirmTitle="Aufgabe löschen?"
          confirm={`„${values.title}" wird entfernt. Erledigtes markieren Sie besser mit dem Haken — so bleibt nachvollziehbar, was getan wurde.`}
          successMessage="Aufgabe gelöscht."
        >
          <Trash2 aria-hidden />
        </ActionButton>
      ) : null}
    </div>
  );
}
