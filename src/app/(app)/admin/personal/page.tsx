import type { Metadata } from 'next';
import Link from 'next/link';
import { Download, UserPlus } from 'lucide-react';

import { prisma, toNumber } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { can, ROLE_LABELS } from '@/lib/auth/rbac';
import { formatDate, formatDuration } from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import { listEmployees, getVacationBalance } from '@/server/services/employee.service';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PersonAvatar } from '@/components/ui/primitives';
import { Tabs, TabsContent, TabsList, TabsTriggerUnderline } from '@/components/ui/controls';
import { KpiTile } from '@/components/app/kpi-tile';
import { EmptyState, ListCard, PageHeader, TableScroll } from '@/components/app/page-parts';
import { FilterBar } from '@/components/app/filter-bar';
import { AbsenceDecision } from '@/features/admin/absence-decision';
import { EMPLOYMENT_OPTIONS } from '@/features/admin/employee-labels';

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

export default async function StaffPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requirePermission('employee:read');
  const filter = await searchParams;
  // Nach Berechtigung, nicht nach Rolle: `role === 'ADMIN'` nahm der
  // Systemverantwortung den Knopf, obwohl sie anlegen darf.
  const isAdmin = can(session.role, 'employee:create');

  const organizationId = await getOrganizationId();
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));

  const [employees, pendingAbsences, monthTime, workingNow, absentToday] = await Promise.all([
    listEmployees({ organizationId, includeInactive: true, q: filter.q }),
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
    prisma.absence.findMany({
      where: {
        status: 'APPROVED',
        startDate: { lte: today },
        endDate: { gte: today },
        employee: { organizationId, active: true },
      },
      select: { employeeId: true },
    }),
  ]);

  const active = employees.filter((employee) => employee.active);

  /**
   * Cockpit-Zahlen aus der geladenen Liste — keine zweite Abfrage, die
   * Liste ist ohnehin vollständig da. Geburtstage in den nächsten 30 Tagen
   * über den Jahreswechsel hinweg; neu im Team heisst Eintritt in den
   * letzten 90 Tagen.
   */
  const absentIds = new Set(absentToday.map((entry) => entry.employeeId));
  const inDays = (date: Date, days: number) => {
    const next = new Date(now.getFullYear(), date.getUTCMonth(), date.getUTCDate());
    if (next.getTime() < now.getTime() - 864e5) next.setFullYear(next.getFullYear() + 1);
    return (next.getTime() - now.getTime()) / 864e5 <= days;
  };
  const upcomingBirthdays = active.filter((e) => e.birthday && inDays(e.birthday, 30));
  const recentHires = active.filter(
    (e) => now.getTime() - e.hiredAt.getTime() <= 90 * 864e5,
  );

  // Filter aus der URL — Status, Abteilung, Anstellungsart. Die Suche (`q`)
  // erledigt der Dienst; der Rest greift auf die geladene Liste.
  const departments = Array.from(
    new Set(employees.map((e) => e.department).filter((d): d is string => Boolean(d))),
  ).sort();
  const filtered = employees.filter((employee) => {
    if (filter.status === 'aktiv' && !employee.active) return false;
    if (filter.status === 'ausgetreten' && employee.active) return false;
    if (filter.abteilung && employee.department !== filter.abteilung) return false;
    if (filter.anstellung && employee.employmentType !== filter.anstellung) return false;
    return true;
  });

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

      <div className="grid gap-4 sm:grid-cols-3">
        <KpiTile
          label="Heute abwesend"
          value={String(absentIds.size)}
          hint={
            absentIds.size > 0
              ? active
                  .filter((e) => absentIds.has(e.id))
                  .map((e) => `${e.user.firstName} ${e.user.lastName}`)
                  .join(', ')
              : 'Alle verfügbar'
          }
        />
        <KpiTile
          label="Geburtstage (30 Tage)"
          value={String(upcomingBirthdays.length)}
          hint={
            upcomingBirthdays.length > 0
              ? upcomingBirthdays
                  .map((e) => `${e.user.firstName} ${e.user.lastName} (${formatDate(e.birthday!).slice(0, 6)})`)
                  .join(', ')
              : 'Keine in den nächsten 30 Tagen'
          }
        />
        <KpiTile
          label="Neu im Team (90 Tage)"
          value={String(recentHires.length)}
          hint={
            recentHires.length > 0
              ? recentHires.map((e) => `${e.user.firstName} ${e.user.lastName}`).join(', ')
              : 'Keine Eintritte'
          }
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
        <TabsContent value="team" className="space-y-4">
          <FilterBar
            searchPlaceholder="Name, E-Mail, Funktion oder Personalnummer …"
            filters={[
              {
                param: 'status',
                label: 'Status',
                options: [
                  { value: 'aktiv', label: 'Aktiv' },
                  { value: 'ausgetreten', label: 'Ausgetreten' },
                ],
              },
              {
                param: 'anstellung',
                label: 'Anstellung',
                options: EMPLOYMENT_OPTIONS,
              },
              ...(departments.length > 0
                ? [
                    {
                      param: 'abteilung',
                      label: 'Abteilung',
                      options: departments.map((d) => ({ value: d, label: d })),
                    },
                  ]
                : []),
            ]}
          />

          {employees.length === 0 && !filter.q ? (
            <EmptyState
              title="Noch keine Mitarbeitenden erfasst"
              description="Erfassen Sie Ihr Team, damit Sie Einsätze zuteilen und Arbeitszeiten erfassen können."
              action={{ href: '/admin/personal/neu', label: 'Person erfassen' }}
            />
          ) : filtered.length === 0 ? (
            <EmptyState
              title="Keine Treffer"
              description="Kein Eintrag passt zu Suche und Filtern."
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
                    {filtered.map((employee) => {
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
                            {/*
                              Eine Akte, deren Konto auf Kundschaft steht, ist
                              ein Widerspruch: Die Person erscheint nirgends
                              mehr als Personal, die Akte ist aber noch aktiv.
                              Hier muss das auffallen — die Rollenvergabe
                              lässt den Zustand seit dem 14. September 2026
                              nicht mehr entstehen, Altdaten können ihn haben.
                            */}
                            {employee.user.role === 'CUSTOMER' ? (
                              <Badge variant="warning" size="sm">
                                Konto ist Kundschaft — Akte stilllegen
                              </Badge>
                            ) : employee.user.role !== 'EMPLOYEE' ? (
                              <Badge variant="neutral" size="sm">
                                {ROLE_LABELS[employee.user.role]}
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
