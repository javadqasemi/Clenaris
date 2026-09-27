import type { Metadata } from 'next';
import Link from 'next/link';
import { CalendarCheck, Clock, MapPin } from 'lucide-react';

import { requireEmployeeId } from '@/lib/auth/session';
import { formatDate, formatDuration, timeRangeLabel } from '@/lib/utils';
import { zuercherTagesgrenzen } from '@/lib/zuerich';
import { getEmployeeSchedule } from '@/server/services/employee.service';
import { StatusBadge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/primitives';
import { Tabs, TabsContent, TabsList, TabsTriggerUnderline } from '@/components/ui/controls';
import { EmptyState, PageHeader } from '@/components/app/page-parts';

export const metadata: Metadata = {
  title: 'Meine Einsätze',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * So viele Einsätze je Reiter, bis jemand „alle" verlangt. 40 decken bei
 * voller Auslastung rund zwei Wochen — das, wofür man die Liste auf dem
 * Telefon öffnet. Der Rest bleibt einen Tipp entfernt, statt jedes Mal
 * mitgeladen zu werden.
 */
const JE_REITER = 40;

/**
 * „Alle" heisst nicht „unbegrenzt" (Phase 23, 2026-09-27). Vorher liess
 * `?alle=1` die Grenze ganz fallen: 60 Tage einer dicht verplanten Person mit
 * Team, Adresse und Checkliste je Einsatz — im Prüfbestand 317 Einsätze und
 * 1.4 MB HTML auf dem Telefon. 300 decken zwei Monate voller Auslastung; wer
 * mehr braucht, sucht im Kalender, der zeitraumweise lädt. Die Gesamtzahl
 * wird weiterhin gezählt und angezeigt, damit die Grenze sichtbar bleibt.
 */
const HOECHSTENS_ALLE = 300;

export default async function PortalJobsPage({
  searchParams,
}: {
  searchParams: Promise<{ alle?: string }>;
}) {
  const { employeeId } = await requireEmployeeId();
  const alle = (await searchParams).alle === '1';

  // Beginn des Zürcher Tages (2026-09-27): Mit der Mitternacht des Servers
  // stand ein Einsatz von heute 00:30 unter „vergangen".
  const today = zuercherTagesgrenzen().von;

  const [upcoming, past] = await Promise.all([
    getEmployeeSchedule({
      employeeId,
      from: today,
      to: new Date(today.getTime() + 60 * 86_400_000),
      take: alle ? HOECHSTENS_ALLE : JE_REITER,
    }),
    getEmployeeSchedule({
      employeeId,
      from: new Date(today.getTime() - 60 * 86_400_000),
      to: today,
      take: alle ? HOECHSTENS_ALLE : JE_REITER,
      absteigend: true,
    }),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Meine Einsätze"
        description="Alle dir zugeteilten Einsätze. Tippe auf einen Einsatz, um Checkliste, Fotos und Zeiterfassung zu öffnen."
      />

      <Tabs defaultValue="kommend">
        <TabsList variant="underline">
          <TabsTriggerUnderline value="kommend">Kommend ({upcoming.gesamt})</TabsTriggerUnderline>
          <TabsTriggerUnderline value="erledigt">Erledigt ({past.gesamt})</TabsTriggerUnderline>
        </TabsList>

        <TabsContent value="kommend">
          {upcoming.jobs.length === 0 ? (
            <EmptyState
              icon={<CalendarCheck aria-hidden />}
              title="Keine Einsätze geplant"
              description="Sobald dir das Büro einen Einsatz zuteilt, erscheint er hier — und du bekommst eine Nachricht."
            />
          ) : (
            <JobList jobs={upcoming.jobs} gesamt={upcoming.gesamt} alle={alle} />
          )}
        </TabsContent>

        <TabsContent value="erledigt">
          {past.jobs.length === 0 ? (
            <EmptyState
              title="Noch keine abgeschlossenen Einsätze"
              description="Hier findest du später deine erledigten Einsätze mit Checkliste und Fotos."
            />
          ) : (
            <JobList jobs={past.jobs} gesamt={past.gesamt} alle={alle} />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

type ScheduleJob = Awaited<ReturnType<typeof getEmployeeSchedule>>['jobs'][number];

function JobList({ jobs, gesamt, alle }: { jobs: ScheduleJob[]; gesamt: number; alle: boolean }) {
  return (
    <>
      <ul className="space-y-3">
        {jobs.map((job) => {
          const address = job.address
            ? `${job.address.street} ${job.address.streetNo ?? ''}, ${job.address.postalCode} ${job.address.city}`.replace(
                /\s+/g,
                ' ',
              )
            : null;

          return (
            <li key={job.id}>
              <Link
                href={`/portal/einsaetze/${job.id}`}
                className="block rounded-2xl border border-border bg-card p-5 shadow-soft transition-[border-color,box-shadow] duration-300 ease-spring hover:border-primary/30 hover:shadow-card"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <p className="text-sm tabular-nums text-muted-foreground">
                      {formatDate(job.scheduledStart)}
                    </p>
                    <p className="font-display text-lg font-semibold tracking-tight">
                      {timeRangeLabel(job.scheduledStart, job.scheduledEnd)} Uhr
                    </p>
                    <p className="font-medium">{job.title}</p>
                    {address ? (
                      <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                        <MapPin className="size-3.5 shrink-0" aria-hidden />
                        {address}
                      </p>
                    ) : null}
                  </div>

                  <div className="flex flex-col items-end gap-2">
                    <StatusBadge status={job.status} />
                    <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                      <Clock className="size-3.5" aria-hidden />
                      {formatDuration(job.estimatedMin)}
                    </span>
                  </div>
                </div>

                {job._count.checklist > 0 ? (
                  <div className="mt-4 space-y-1.5">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>Checkliste</span>
                      <span className="tabular-nums">
                        {job.checklistDone}/{job._count.checklist}
                      </span>
                    </div>
                    <Progress
                      value={(job.checklistDone / job._count.checklist) * 100}
                      aria-label="Fortschritt Checkliste"
                    />
                  </div>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
      {gesamt > jobs.length ? (
        <p className="mt-4 text-center text-sm text-muted-foreground">
          {jobs.length} von {gesamt} angezeigt ·{' '}
          {/* Schon „alle" und trotzdem mehr: weiter im Kalender, nicht im Kreis. */}
          <Link
            href={alle ? '/portal/kalender' : '/portal/einsaetze?alle=1'}
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            {alle ? 'Weitere im Kalender' : 'Alle anzeigen'}
          </Link>
        </p>
      ) : null}
    </>
  );
}
