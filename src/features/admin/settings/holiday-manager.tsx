'use client';

import { PenLine, Trash2 } from 'lucide-react';

import { ActionButton } from '@/components/app/action-button';
import { FormDialog, type FieldSpec } from '@/components/app/resource-form';
import { EmptyState } from '@/components/app/page-parts';

/**
 * Feiertage pflegen.
 *
 * Bis hierher stand die Liste nur da: Der Ostermontag des nächsten Jahres
 * brauchte einen Entwicklungseinsatz, obwohl ein fehlender Feiertag zwei
 * Stellen still falsch rechnen lässt — der Buchungsassistent bietet den Tag
 * an, und die Ferienrechnung zählt ihn als Ferientag.
 *
 * Die Liste zeigt Kalendertage in UTC, genau wie die Spalte sie speichert.
 * `formatDate` aus `lib/utils` würde nach Europe/Zurich umrechnen und am
 * Vorabend landen.
 */
export interface HolidayRow {
  id: string;
  name: string;
  /** `JJJJ-MM-TT` */
  date: string;
  recurring: boolean;
  canton: string | null;
}

const FIELDS: FieldSpec[] = [
  { name: 'name', label: 'Bezeichnung', required: true, placeholder: 'z. B. Ostermontag' },
  { name: 'date', label: 'Datum', type: 'date', required: true, half: true },
  {
    name: 'canton',
    label: 'Kanton',
    half: true,
    placeholder: 'BE',
    hint: 'Zwei Buchstaben. Leer bedeutet Kanton Bern.',
    nullable: true,
  },
  {
    name: 'recurring',
    label: 'Jedes Jahr am selben Kalendertag (Neujahr, Nationalfeiertag)',
    type: 'checkbox',
  },
];

function formatDay(value: string): string {
  return new Intl.DateTimeFormat('de-CH', {
    timeZone: 'UTC',
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date(`${value}T00:00:00Z`));
}

export function HolidayCreateButton() {
  return (
    <FormDialog
      title="Feiertag erfassen"
      description="Der Tag wird im Buchungsassistenten gesperrt und zählt bei Abwesenheiten nicht als Ferientag."
      triggerLabel="Feiertag erfassen"
      triggerVariant="outline"
      triggerSize="sm"
      size="md"
      endpoint="/api/holidays"
      fields={FIELDS}
      values={{ recurring: false }}
      successMessage="Feiertag erfasst."
    />
  );
}

export function HolidayList({ holidays, canEdit }: { holidays: HolidayRow[]; canEdit: boolean }) {
  if (holidays.length === 0) {
    return (
      <EmptyState
        title="Keine Feiertage erfasst"
        description="Ohne Feiertage nimmt der Buchungsassistent auch am Ostermontag Termine an."
      />
    );
  }

  const today = new Date().toISOString().slice(0, 10);

  return (
    <dl className="protocol-list">
      {holidays.map((holiday) => {
        const past = !holiday.recurring && holiday.date < today;
        return (
          <div key={holiday.id} className="protocol-row">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <dt className="protocol-label tabular-nums">{formatDay(holiday.date)}</dt>
                <dd className="protocol-value">
                  {holiday.name}
                  {holiday.recurring ? (
                    <span className="ml-2 text-xs text-muted-foreground">jährlich</span>
                  ) : null}
                  {holiday.canton && holiday.canton !== 'BE' ? (
                    <span className="ml-2 text-xs text-muted-foreground">{holiday.canton}</span>
                  ) : null}
                </dd>
              </div>
              {canEdit ? (
                <div className="flex shrink-0 items-center gap-1">
                  <FormDialog
                    title="Feiertag bearbeiten"
                    triggerLabel="Bearbeiten"
                    triggerVariant="ghost"
                    triggerSize="icon"
                    triggerIcon={<PenLine aria-hidden />}
                    size="md"
                    endpoint={`/api/holidays/${holiday.id}`}
                    method="PATCH"
                    fields={FIELDS}
                    values={{
                      name: holiday.name,
                      date: holiday.date,
                      recurring: holiday.recurring,
                      canton: holiday.canton ?? '',
                    }}
                    successMessage="Feiertag geändert."
                  />
                  <ActionButton
                    endpoint={`/api/holidays/${holiday.id}`}
                    method="DELETE"
                    label="Entfernen"
                    aria-label={`${holiday.name} entfernen`}
                    variant="ghost"
                    size="icon"
                    disabled={past}
                    confirmTitle="Feiertag entfernen?"
                    confirm={`„${holiday.name}" am ${formatDay(holiday.date)} wird aus dem Kalender genommen. Der Buchungsassistent nimmt an diesem Tag wieder Termine an.`}
                    successMessage="Feiertag entfernt."
                  >
                    <Trash2 aria-hidden />
                  </ActionButton>
                </div>
              ) : null}
            </div>
          </div>
        );
      })}
    </dl>
  );
}
