import type { Metadata } from 'next';
import Link from 'next/link';
import { Download, UserPlus } from 'lucide-react';

import { prisma, toNumber } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { formatDate, formatDuration } from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import { listEmployees, getVacationBalance } from '@/server/services/employee.service';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PersonAvatar } from '@/components/ui/primitives';
import { Tabs, TabsContent, TabsList, TabsTriggerUnderline } from '@/components/ui/controls';
import { KpiTile } from '@/components/app/kpi-tile';
import { EmptyState, ListCard, PageHeader, TableScroll } from '@/components/app/page-parts';
import { AbsenceDecision } from '@/features/admin/absence-decision';

export const metadata: Metadata = {
  title: 'Mitarbeitende',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const ABSENCE_LABELS: Record<string, string> = {
  VACATION: 'Ferien',
  SICK: 'Krankheit',
  ACCIDENT: 'Unfall',
  MILITARY: 'Militär',
  MATERNITY: 'Mutterschaft',
  PATERNITY: 'Vaterschaft',
  UNPAID: 'Unbezahlt',
  TRAINING: 'Weiterbildung',
  PUBLIC_HOLIDAY: 'Feiertag',
  OTHER: 'Anderes',
};

export default async function StaffPage() {
  const session = await requirePermission('employee:read');
  const isAdmin = session.role === 'ADMIN';

  const organizationId = await getOrganizationId();
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [employees, pendingAbsences, monthTime, workingNow] = await Promise.all([
    listEmployees({ organizationId, includeInactive: true }),
    prisma.absence.findMany({
      where: { status: 'REQUESTED', employee: { organizationId } },
      orderBy: { startDate: 'asc' },
      include: {
        employee: {
          select: {
            id: true,
            color: true,
            user: { select: { firstName: true, lastName: true } },
          },
        },
      },
    }),
    prisma.timeEntry.aggregate({
      where: {
        employee: { organizationId },
        startedAt: { gte: monthStart },
        endedAt: { not: null },
      },
      _sum: { minutes: true },
    }),
    prisma.timeEntry.count({ where: { endedAt: null, employee: { organizationId } } }),
  ]);

  const active = employees.filter((employee) => employee.active);

  // Feriensaldi parallel laden — sie kommen aus derselben Tabelle wie die Anträge.
  const balances = await Promise.all(
    active.map(async (employee) => ({
      id: employee.id,
      balance: await getVacationBalance(employee.id),
    })),
  );
  const balanceById = new Map(balances.map((entry) => [entry.id, entry.balance]));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Mitarbeitende"
        description="Anstellungen, Qualifikationen, Zeiterfassung und Abwesenheiten."
        actions={
          <>
            <Button asChild variant="outline">
              <a href="/api/exports/zeiterfassung" download>
                <Download aria-hidden />
                Zeiterfassung
              </a>
            </Button>
            {isAdmin ? (
              <Button asChild>
                <Link href="/admin/personal/neu">
                  <UserPlus aria-hidden />
                  Person erfassen
                </Link>
              </Button>
            ) : null}
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile label="Aktive Mitarbeitende" value={String(active.length)} />
        <KpiTile
          label="Arbeiten gerade"
          value={String(workingNow)}
          hint={workingNow > 0 ? 'Zeiterfassung läuft' : 'Niemand eingestempelt'}
        />
        <KpiTile
          label="Stunden diesen Monat"
          value={formatDuration(monthTime._sum.minutes ?? 0)}
        />
        <KpiTile
          label="Offene Anträge"
          value={String(pendingAbsences.length)}
          accent={pendingAbsences.length > 0 ? 'warning' : undefined}
        />
      </div>

      <Tabs defaultValue="team">
        <TabsList variant="underline">
          <TabsTriggerUnderline value="team">Team ({employees.length})</TabsTriggerUnderline>
          <TabsTriggerUnderline value="abwesenheiten">
            Abwesenheiten ({pendingAbsences.length})
          </TabsTriggerUnderline>
        </TabsList>

        {/* Team */}
        <TabsContent value="team">
          {employees.length === 0 ? (
            <EmptyState
              title="Noch keine Mitarbeitenden erfasst"
              description="Erfassen Sie Ihr Team, damit Sie Einsätze zuteilen und Arbeitszeiten erfassen können."
              action={{ href: '/admin/personal/neu', label: 'Person erfassen' }}
            />
          ) : (
            <ListCard>
              <TableScroll>
                <table className="data-table">
                  <caption className="sr-only">Mitarbeitendenliste</caption>
                  <thead>
                    <tr>
                      <th scope="col">Person</th>
                      <th scope="col">Nummer</th>
                      <th scope="col">Funktion</th>
                      <th scope="col" className="text-right">
                        Pensum
                      </th>
                      <th scope="col" className="text-right">
                        Ferien offen
                      </th>
                      <th scope="col">Eintritt</th>
                      <th scope="col">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {employees.map((employee) => {
                      const balance = balanceById.get(employee.id);
                      return (
                        <tr key={employee.id}>
                          <td>
                            <Link
                              href={`/admin/personal/${employee.id}`}
                              className="flex items-center gap-3"
                            >
                              <PersonAvatar
                                firstName={employee.user.firstName}
                                lastName={employee.user.lastName}
                                src={employee.user.avatarUrl}
                                color={employee.color}
                                size="sm"
                              />
                              <span className="min-w-0">
                                <span className="block truncate font-medium text-primary underline-offset-4 hover:underline">
                                  {employee.user.firstName} {employee.user.lastName}
                                </span>
                                <span className="block truncate text-xs text-muted-foreground">
                                  {employee.user.email}
                                </span>
                              </span>
                            </Link>
                          </td>
                          <td className="tabular-nums text-muted-foreground">
                            {employee.employeeNumber}
                          </td>
                          <td>
                            <span className="block">{employee.position}</span>
                            {employee.user.role !== 'EMPLOYEE' ? (
                              <Badge variant="neutral" size="sm">
                                {employee.user.role === 'ADMIN' ? 'Administration' : 'Leitung'}
                              </Badge>
                            ) : null}
                          </td>
                          <td className="num text-muted-foreground">{employee.workloadPct} %</td>
                          <td className="num">
                            {balance ? `${balance.remaining} Tage` : '—'}
                          </td>
                          <td className="text-muted-foreground">{formatDate(employee.hiredAt)}</td>
                          <td>
                            <Badge variant={employee.active ? 'success' : 'neutral'}>
                              {employee.active ? 'Aktiv' : 'Ausgetreten'}
                            </Badge>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableScroll>
            </ListCard>
          )}
        </TabsContent>

        {/* Abwesenheiten */}
        <TabsContent value="abwesenheiten">
          {pendingAbsences.length === 0 ? (
            <EmptyState
              title="Keine offenen Anträge"
              description="Abwesenheitsanträge aus dem Mitarbeitendenportal erscheinen hier zur Bewilligung."
            />
          ) : (
            <ul className="space-y-3">
              {pendingAbsences.map((absence) => (
                <li
                  key={absence.id}
                  className="flex flex-wrap items-center gap-4 rounded-2xl border border-border bg-card p-5"
                >
                  <PersonAvatar
                    firstName={absence.employee.user.firstName}
                    lastName={absence.employee.user.lastName}
                    color={absence.employee.color}
                    size="sm"
                  />

                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      {absence.employee.user.firstName} {absence.employee.user.lastName}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {ABSENCE_LABELS[absence.type] ?? absence.type} ·{' '}
                      {formatDate(absence.startDate)} – {formatDate(absence.endDate)} ·{' '}
                      {toNumber(absence.days)} {toNumber(absence.days) === 1 ? 'Tag' : 'Tage'}
                    </p>
                    {absence.reason ? (
                      <p className="mt-1 text-sm text-muted-foreground">{absence.reason}</p>
                    ) : null}
                  </div>

                  <StatusBadge status={absence.status} />

                  <AbsenceDecision absenceId={absence.id} />
                </li>
              ))}
            </ul>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
