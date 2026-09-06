import type { Metadata } from 'next';
import Link from 'next/link';
import { CalendarCheck, Clock, MapPin } from 'lucide-react';

import { requireEmployeeId } from '@/lib/auth/session';
import { formatDate, formatDuration, timeRangeLabel } from '@/lib/utils';
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

export default async function PortalJobsPage() {
  const { employeeId } = await requireEmployeeId();

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [upcoming, past] = await Promise.all([
    getEmployeeSchedule({
      employeeId,
      from: today,
      to: new Date(today.getTime() + 60 * 86_400_000),
    }),
    getEmployeeSchedule({
      employeeId,
      from: new Date(today.getTime() - 60 * 86_400_000),
      to: today,
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
          <TabsTriggerUnderline value="kommend">
            Kommend ({upcoming.jobs.length})
          </TabsTriggerUnderline>
          <TabsTriggerUnderline value="erledigt">
            Erledigt ({past.jobs.length})
          </TabsTriggerUnderline>
        </TabsList>

        <TabsContent value="kommend">
          {upcoming.jobs.length === 0 ? (
            <EmptyState
              icon={<CalendarCheck aria-hidden />}
              title="Keine Einsätze geplant"
              description="Sobald dir das Büro einen Einsatz zuteilt, erscheint er hier — und du bekommst eine Nachricht."
            />
          ) : (
            <JobList jobs={upcoming.jobs} />
          )}
        </TabsContent>

        <TabsContent value="erledigt">
          {past.jobs.length === 0 ? (
            <EmptyState
              title="Noch keine abgeschlossenen Einsätze"
              description="Hier findest du später deine erledigten Einsätze mit Checkliste und Fotos."
            />
          ) : (
            <JobList jobs={past.jobs} />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

type ScheduleJob = Awaited<ReturnType<typeof getEmployeeSchedule>>['jobs'][number];

function JobList({ jobs }: { jobs: ScheduleJob[] }) {
  return (
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
  );
}
