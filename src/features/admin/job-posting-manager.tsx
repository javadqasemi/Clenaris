'use client';

import { PenLine, Trash2 } from 'lucide-react';

import {
  EMPLOYMENT_TYPES,
  EMPLOYMENT_TYPE_LABELS,
  POST_STATUS,
  POST_STATUS_LABELS,
} from '@/lib/validation/website';
import { Badge } from '@/components/ui/badge';
import { ActionButton } from '@/components/app/action-button';
import { FormDialog, type FieldSpec } from '@/components/app/resource-form';
import { EmptyState } from '@/components/app/page-parts';

/**
 * Stellenangebote pflegen.
 *
 * Die Bewerbungsseite gruppiert nach Stelle — die Stellen selbst liessen sich
 * aber nirgends anlegen, obwohl die Endpunkte bestanden. Eine neue Stelle
 * auszuschreiben hiess Seed oder API-Dokumentation.
 *
 * Veröffentlichen und Zurückziehen laufen über den Status; das
 * Veröffentlichungsdatum setzt der Server beim ersten Veröffentlichen.
 */
export interface JobPostingRow {
  id: string;
  title: string;
  slug: string;
  location: string;
  employmentType: string;
  workloadFrom: number;
  workloadTo: number;
  description: string;
  requirements: string[];
  benefits: string[];
  salaryFrom: number | null;
  salaryTo: number | null;
  status: string;
  closesAt: string | null;
  applications: number;
}

const FIELDS: FieldSpec[] = [
  { name: 'title', label: 'Titel', required: true, placeholder: 'Reinigungskraft 80–100 %' },
  {
    name: 'slug',
    label: 'Kurzname in der Adresse',
    required: true,
    half: true,
    placeholder: 'reinigungskraft-bern',
    hint: 'Kleinbuchstaben, Ziffern und Bindestriche.',
  },
  { name: 'location', label: 'Arbeitsort', required: true, half: true },
  {
    name: 'employmentType',
    label: 'Anstellung',
    type: 'select',
    required: true,
    half: true,
    options: EMPLOYMENT_TYPES.map((value) => ({ value, label: EMPLOYMENT_TYPE_LABELS[value] })),
  },
  {
    name: 'status',
    label: 'Status',
    type: 'select',
    required: true,
    half: true,
    options: POST_STATUS.map((value) => ({ value, label: POST_STATUS_LABELS[value] })),
  },
  { name: 'workloadFrom', label: 'Pensum von', type: 'number', suffix: '%', half: true, min: 10, max: 100 },
  { name: 'workloadTo', label: 'Pensum bis', type: 'number', suffix: '%', half: true, min: 10, max: 100 },
  { name: 'salaryFrom', label: 'Lohn von', type: 'number', suffix: 'CHF', half: true, nullable: true },
  { name: 'salaryTo', label: 'Lohn bis', type: 'number', suffix: 'CHF', half: true, nullable: true },
  {
    name: 'description',
    label: 'Beschreibung',
    type: 'textarea',
    rows: 8,
    required: true,
    hint: 'Mindestens 80 Zeichen — kürzere Anzeigen werden nicht gelesen.',
  },
  { name: 'requirements', label: 'Anforderungen', type: 'tags', hint: 'Mit Komma trennen.' },
  { name: 'benefits', label: 'Wir bieten', type: 'tags', hint: 'Mit Komma trennen.' },
  { name: 'closesAt', label: 'Bewerbungsfrist', type: 'date', half: true, emptyAsString: true },
];

export function JobPostingCreateButton() {
  return (
    <FormDialog
      title="Stelle ausschreiben"
      description="Als Entwurf angelegt; veröffentlichen Sie die Stelle, sobald der Text steht."
      triggerLabel="Stelle ausschreiben"
      endpoint="/api/job-postings"
      fields={FIELDS}
      values={{
        location: 'Bern',
        employmentType: 'FULL_TIME',
        status: 'DRAFT',
        workloadFrom: 80,
        workloadTo: 100,
      }}
      successMessage="Stelle angelegt."
    />
  );
}

export function JobPostingList({
  postings,
  canEdit,
  canDelete,
}: {
  postings: JobPostingRow[];
  canEdit: boolean;
  canDelete: boolean;
}) {
  if (postings.length === 0) {
    return (
      <EmptyState
        title="Keine Stellen ausgeschrieben"
        description="Eine veröffentlichte Stelle erscheint auf der Karriereseite mit Bewerbungsformular."
      />
    );
  }

  return (
    <dl className="protocol-list">
      {postings.map((posting) => (
        <div key={posting.id} className="protocol-row">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <dt className="protocol-label">{posting.title}</dt>
              <dd className="protocol-value flex flex-wrap items-center gap-2 font-normal">
                <Badge variant={posting.status === 'PUBLISHED' ? 'success' : 'neutral'} size="sm">
                  {POST_STATUS_LABELS[posting.status as keyof typeof POST_STATUS_LABELS] ?? posting.status}
                </Badge>
                <span className="text-sm text-muted-foreground">
                  {posting.location} · {posting.workloadFrom}–{posting.workloadTo} % ·{' '}
                  {EMPLOYMENT_TYPE_LABELS[posting.employmentType as keyof typeof EMPLOYMENT_TYPE_LABELS] ??
                    posting.employmentType}
                  {' · '}
                  {posting.applications} {posting.applications === 1 ? 'Bewerbung' : 'Bewerbungen'}
                </span>
              </dd>
            </div>
            {canEdit ? (
              <div className="flex shrink-0 items-center gap-1">
                <ActionButton
                  endpoint={`/api/job-postings/${posting.id}`}
                  method="PATCH"
                  body={{ status: posting.status === 'PUBLISHED' ? 'ARCHIVED' : 'PUBLISHED' }}
                  label={posting.status === 'PUBLISHED' ? 'Zurückziehen' : 'Veröffentlichen'}
                  variant="outline"
                  size="sm"
                  successMessage={
                    posting.status === 'PUBLISHED' ? 'Stelle zurückgezogen.' : 'Stelle veröffentlicht.'
                  }
                />
                <FormDialog
                  title="Stelle bearbeiten"
                  triggerLabel="Bearbeiten"
                  triggerVariant="ghost"
                  triggerSize="icon"
                  triggerIcon={<PenLine aria-hidden />}
                  endpoint={`/api/job-postings/${posting.id}`}
                  method="PATCH"
                  fields={FIELDS}
                  values={{
                    title: posting.title,
                    slug: posting.slug,
                    location: posting.location,
                    employmentType: posting.employmentType,
                    status: posting.status,
                    workloadFrom: posting.workloadFrom,
                    workloadTo: posting.workloadTo,
                    salaryFrom: posting.salaryFrom ?? '',
                    salaryTo: posting.salaryTo ?? '',
                    description: posting.description,
                    requirements: posting.requirements,
                    benefits: posting.benefits,
                    closesAt: posting.closesAt ?? '',
                  }}
                  successMessage="Stelle geändert."
                />
                {canDelete ? (
                  <ActionButton
                    endpoint={`/api/job-postings/${posting.id}`}
                    method="DELETE"
                    label="Löschen"
                    aria-label={`${posting.title} löschen`}
                    variant="ghost"
                    size="icon"
                    disabled={posting.applications > 0}
                    confirmTitle="Stelle löschen?"
                    confirm={`„${posting.title}" wird entfernt. Eine Stelle mit Bewerbungen lässt sich nur archivieren.`}
                    successMessage="Stelle gelöscht."
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
