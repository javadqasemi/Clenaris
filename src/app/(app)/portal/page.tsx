import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, CalendarCheck, Clock, MapPin, Navigation, Palmtree } from 'lucide-react';

import { requireEmployeeId } from '@/lib/auth/session';
import {
  formatDateLong,
  formatDuration,
  formatTime,
  timeRangeLabel,
} from '@/lib/utils';
import { navigationUrl } from '@/lib/maps/google';
import { getEmployeeSchedule, getVacationBalance } from '@/server/services/employee.service';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PersonAvatar, Progress } from '@/components/ui/primitives';
import { KpiTile } from '@/components/app/kpi-tile';
import { EmptyState, PageHeader } from '@/components/app/page-parts';

export const metadata: Metadata = {
  title: 'Heute',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function PortalHomePage() {
  const { session, employeeId } = await requireEmployeeId();

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const inSevenDays = new Date(today.getTime() + 7 * 86_400_000);

  const [schedule, vacation] = await Promise.all([
    getEmployeeSchedule({ employeeId, from: today, to: inSevenDays }),
    getVacationBalance(employeeId),
  ]);

  const tomorrow = new Date(today.getTime() + 86_400_000);
  const todayJobs = schedule.jobs.filter((job) => job.scheduledStart < tomorrow);
  const upcomingJobs = schedule.jobs.filter((job) => job.scheduledStart >= tomorrow);

  const todayMinutes = todayJobs.reduce((sum, job) => sum + job.estimatedMin, 0);

  return (
    <div className="space-y-8">
      <PageHeader
        title={`${greeting()}, ${session.firstName}`}
        description={formatDateLong(new Date())}
      />

      {/* Laufende Erfassung ganz oben — das ist die wichtigste Information. */}
      {schedule.activeTimeEntry ? (
        <Link
          href={`/portal/einsaetze/${schedule.activeTimeEntry.job?.id ?? ''}`}
          className="flex items-center justify-between gap-4 rounded-2xl border border-primary/30 bg-primary/[0.06] p-5 transition-colors hover:bg-primary/[0.1]"
        >
          <div className="flex items-center gap-3">
            <span className="status-dot bg-primary" aria-hidden />
            <div>
              <p className="text-sm font-medium text-primary">Zeiterfassung läuft</p>
              <p className="font-medium">
                {schedule.activeTimeEntry.job?.title ?? 'Einsatz'} · seit{' '}
                {formatTime(schedule.activeTimeEntry.startedAt)} Uhr
              </p>
            </div>
          </div>
          <ArrowRight className="size-5 shrink-0 text-primary" aria-hidden />
        </Link>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <KpiTile
          label="Einsätze heute"
          value={String(todayJobs.length)}
          hint={todayMinutes > 0 ? `ca. ${formatDuration(todayMinutes)}` : 'nichts geplant'}
        />
        <KpiTile
          label="Kommende 7 Tage"
          value={String(upcomingJobs.length)}
          href="/portal/einsaetze"
        />
        <KpiTile
          label="Ferienguthaben"
          value={`${vacation.remaining} Tage`}
          hint={`${vacation.taken} bezogen · ${vacation.pending} beantragt`}
          href="/portal/abwesenheiten"
        />
      </div>

      {/* Heute */}
      <section className="space-y-4" aria-label="Einsätze heute">
        <h2 className="font-display text-lg font-semibold tracking-tight">Heute</h2>

        {todayJobs.length === 0 ? (
          <EmptyState
            icon={<CalendarCheck aria-hidden />}
            title="Heute steht nichts an"
            description="Geniess den freien Tag — oder schau, was diese Woche ansteht."
            action={{ href: '/portal/einsaetze', label: 'Kommende Einsätze' }}
          />
        ) : (
          <ul className="space-y-3">
            {todayJobs.map((job) => {
              const address = job.address
                ? `${job.address.street} ${job.address.streetNo ?? ''}, ${job.address.postalCode} ${job.address.city}`.replace(
                    /\s+/g,
                    ' ',
                  )
                : null;
              const done = job.checklistDone ?? 0;

              return (
                <li key={job.id}>
                  <div className="rounded-2xl border border-border bg-card p-5 shadow-soft">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 space-y-1">
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
                      <StatusBadge status={job.status} />
                    </div>

                    {job._count.checklist > 0 ? (
                      <div className="mt-4 space-y-1.5">
                        <div className="flex items-center justify-between text-xs text-muted-foreground">
                          <span>Checkliste</span>
                          <span className="tabular-nums">
                            {done}/{job._count.checklist}
                          </span>
                        </div>
                        <Progress
                          value={(done / job._count.checklist) * 100}
                          aria-label="Fortschritt Checkliste"
                        />
                      </div>
                    ) : null}

                    {job.assignments.length > 1 ? (
                      <div className="mt-4 flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">Team:</span>
                        <div className="flex -space-x-2">
                          {job.assignments.map((assignment) => (
                            <PersonAvatar
                              key={assignment.employee.id}
                              firstName={assignment.employee.user.firstName}
                              lastName={assignment.employee.user.lastName}
                              size="sm"
                              className="ring-2 ring-card"
                            />
                          ))}
                        </div>
                      </div>
                    ) : null}

                    <div className="mt-5 flex flex-wrap gap-2">
                      <Button asChild size="lg" className="flex-1">
                        <Link href={`/portal/einsaetze/${job.id}`}>Einsatz öffnen</Link>
                      </Button>
                      {address ? (
                        <Button asChild size="lg" variant="outline">
                          <a href={navigationUrl(address)} target="_blank" rel="noreferrer">
                            <Navigation aria-hidden />
                            Navigation
                          </a>
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Kommende Tage */}
      {upcomingJobs.length > 0 ? (
        <section className="space-y-4" aria-label="Kommende Einsätze">
          <div className="flex items-center justify-between gap-4">
            <h2 className="font-display text-lg font-semibold tracking-tight">Diese Woche</h2>
            <Button asChild variant="ghost" size="sm">
              <Link href="/portal/einsaetze">
                Alle
                <ArrowRight aria-hidden />
              </Link>
            </Button>
          </div>

          <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
            {upcomingJobs.slice(0, 6).map((job) => (
              <li key={job.id}>
                <Link
                  href={`/portal/einsaetze/${job.id}`}
                  className="flex items-center gap-4 p-4 transition-colors hover:bg-muted/50"
                >
                  <div className="w-20 shrink-0">
                    <p className="text-sm font-medium tabular-nums">
                      {new Intl.DateTimeFormat('de-CH', {
                        timeZone: 'Europe/Zurich',
                        weekday: 'short',
                        day: '2-digit',
                        month: '2-digit',
                      }).format(job.scheduledStart)}
                    </p>
                    <p className="text-xs tabular-nums text-muted-foreground">
                      {formatTime(job.scheduledStart)}
                    </p>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{job.title}</p>
                    <p className="truncate text-sm text-muted-foreground">
                      {job.address
                        ? `${job.address.postalCode} ${job.address.city}`
                        : (job.service?.name ?? '')}
                    </p>
                  </div>
                  <Clock className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="whitespace-nowrap text-sm text-muted-foreground">
                    {formatDuration(job.estimatedMin)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Abwesenheiten */}
      {schedule.absences.length > 0 ? (
        <section className="space-y-3" aria-label="Abwesenheiten">
          <h2 className="font-display text-lg font-semibold tracking-tight">Deine Abwesenheiten</h2>
          <ul className="space-y-2">
            {schedule.absences.map((absence) => (
              <li
                key={absence.id}
                className="flex items-center gap-3 rounded-xl border border-border bg-card p-4"
              >
                <Palmtree className="size-4 shrink-0 text-primary" aria-hidden />
                <span className="text-sm">
                  {formatDateLong(absence.startDate)} – {formatDateLong(absence.endDate)}
                </span>
                <StatusBadge status={absence.status} className="ml-auto" />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function greeting(): string {
  const hour = Number(
    new Intl.DateTimeFormat('de-CH', { timeZone: 'Europe/Zurich', hour: 'numeric', hour12: false }).format(
      new Date(),
    ),
  );
  if (hour < 11) return 'Guten Morgen';
  if (hour < 18) return 'Hallo';
  return 'Guten Abend';
}
