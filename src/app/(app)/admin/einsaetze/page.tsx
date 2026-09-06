import type { Metadata } from 'next';
import Link from 'next/link';
import { CalendarDays, Truck } from 'lucide-react';

import { requirePermission } from '@/lib/auth/session';
import { formatDate, formatDuration, formatTime, toQueryString } from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import { listJobs } from '@/server/services/job.service';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PersonAvatar } from '@/components/ui/primitives';
import { FilterBar } from '@/components/app/filter-bar';
import { SortHeader } from '@/components/app/sort-header';
import {
  EmptyState,
  ListCard,
  PageHeader,
  Pagination,
  TableScroll,
} from '@/components/app/page-parts';

export const metadata: Metadata = {
  title: 'Einsätze',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const STATUS_FILTER = [
  { value: 'UNASSIGNED', label: 'Nicht zugeteilt' },
  { value: 'SCHEDULED', label: 'Geplant' },
  { value: 'IN_PROGRESS', label: 'In Arbeit' },
  { value: 'COMPLETED', label: 'Abgeschlossen' },
  { value: 'VERIFIED', label: 'Kontrolliert' },
  { value: 'CANCELLED', label: 'Abgesagt' },
];

const PERIOD_FILTER = [
  { value: 'heute', label: 'Heute' },
  { value: 'woche', label: 'Diese Woche' },
  { value: 'offen', label: 'Ab heute' },
  { value: 'vergangen', label: 'Vergangen' },
];

export default async function AdminJobsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePermission('job:read');

  const params = await searchParams;
  const organizationId = await getOrganizationId();

  const page = Math.max(1, Number(params.seite) || 1);
  const pageSize = 25;
  const range = resolvePeriod(params.zeitraum);

  const { items, total } = await listJobs({
    organizationId,
    page,
    pageSize,
    q: params.q,
    status: params.status as never,
    from: range.from,
    to: range.to,
    sort: params.sort,
    order: params.order === 'asc' ? 'asc' : params.order === 'desc' ? 'desc' : undefined,
  });

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  // Die Sortierung gehört in den Blätter-Link: sonst kippt sie beim Umblättern
  // auf den Standard zurück, und Seite 2 zeigt eine andere Ordnung als Seite 1.
  const baseHref = `/admin/einsaetze${toQueryString({
    q: params.q,
    status: params.status,
    zeitraum: params.zeitraum,
    sort: params.sort,
    order: params.order,
  })}`;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Einsätze"
        description="Die Betriebssicht auf jeden Auftrag: wer, wann, wo, mit welcher Checkliste. Zum Disponieren nutzen Sie den Kalender."
        actions={
          <Button asChild variant="outline">
            <Link href="/admin/kalender">
              <CalendarDays aria-hidden />
              Kalender
            </Link>
          </Button>
        }
      >
        <FilterBar
          searchPlaceholder="Nummer, Titel oder Kundschaft …"
          filters={[
            { param: 'status', label: 'Status', options: STATUS_FILTER },
            { param: 'zeitraum', label: 'Zeitraum', options: PERIOD_FILTER },
          ]}
        />
      </PageHeader>

      {items.length === 0 ? (
        <EmptyState
          icon={<Truck aria-hidden />}
          title="Keine Einsätze gefunden"
          description="Bestätigte Buchungen erzeugen automatisch einen Einsatz. Prüfen Sie die Filter oder bestätigen Sie offene Buchungen."
          action={{ href: '/admin/buchungen?status=PENDING', label: 'Offene Buchungen' }}
        />
      ) : (
        <ListCard
          footer={
            <Pagination page={page} totalPages={totalPages} total={total} baseHref={baseHref} />
          }
        >
          <TableScroll>
            <table className="data-table">
              <caption className="sr-only">Einsätze, nach Termin sortiert. {total} Einträge.</caption>
              <thead>
                <tr>
                  <SortHeader field="number">Nummer</SortHeader>
                  <SortHeader field="title">Einsatz</SortHeader>
                  <SortHeader field="scheduledStart" defaultOrder="asc">
                    Termin
                  </SortHeader>
                  <SortHeader field="estimatedMin" defaultOrder="desc">
                    Dauer
                  </SortHeader>
                  <th scope="col">Team</th>
                  <th scope="col">Fortschritt</th>
                  <SortHeader field="status">Status</SortHeader>
                </tr>
              </thead>
              <tbody>
                {items.map((job) => (
                  <tr key={job.id}>
                    <td>
                      <Link
                        href={`/admin/einsaetze/${job.id}`}
                        className="font-medium tabular-nums text-primary underline-offset-4 hover:underline"
                      >
                        {job.number}
                      </Link>
                    </td>
                    <td>
                      <span className="block max-w-[18rem] truncate font-medium">{job.title}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {job.address
                          ? `${job.address.street} ${job.address.streetNo ?? ''}, ${job.address.postalCode} ${job.address.city}`
                          : job.service?.name}
                      </span>
                    </td>
                    <td>
                      <span className="block tabular-nums">{formatDate(job.scheduledStart)}</span>
                      <span className="block text-xs tabular-nums text-muted-foreground">
                        {formatTime(job.scheduledStart)} – {formatTime(job.scheduledEnd)}
                      </span>
                    </td>
                    <td className="text-muted-foreground">{formatDuration(job.estimatedMin)}</td>
                    <td>
                      {job.assignments.length === 0 ? (
                        <span className="text-xs text-warning">offen</span>
                      ) : (
                        <div className="flex -space-x-2">
                          {job.assignments.map((assignment) => (
                            <PersonAvatar
                              key={assignment.id}
                              firstName={assignment.employee.user.firstName}
                              lastName={assignment.employee.user.lastName}
                              src={assignment.employee.user.avatarUrl}
                              color={assignment.employee.color}
                              size="sm"
                              className="ring-2 ring-card"
                            />
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="text-muted-foreground">
                      {job._count.checklist > 0
                        ? `${job._count.checklist} Punkte`
                        : '—'}
                      {job._count.photos > 0 ? ` · ${job._count.photos} Fotos` : ''}
                    </td>
                    <td>
                      <StatusBadge status={job.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </ListCard>
      )}
    </div>
  );
}

function resolvePeriod(value: string | undefined): { from?: Date; to?: Date } {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  switch (value) {
    case 'heute':
      return { from: startOfDay, to: new Date(startOfDay.getTime() + 86_400_000) };
    case 'woche': {
      const monday = new Date(startOfDay);
      monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
      return { from: monday, to: new Date(monday.getTime() + 7 * 86_400_000) };
    }
    case 'vergangen':
      return { to: now };
    case 'offen':
      return { from: startOfDay };
    default:
      return {};
  }
}
