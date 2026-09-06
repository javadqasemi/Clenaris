import type { Metadata } from 'next';
import { Palmtree } from 'lucide-react';

import { prisma, toNumber } from '@/lib/db';
import { requireEmployeeId } from '@/lib/auth/session';
import { formatDate } from '@/lib/utils';
import { getVacationBalance } from '@/server/services/employee.service';
import { StatusBadge } from '@/components/ui/badge';
import { KpiTile } from '@/components/app/kpi-tile';
import { EmptyState, ListCard, PageHeader, TableScroll } from '@/components/app/page-parts';
import { AbsenceRequestDialog } from '@/features/portal/absence-request-dialog';

export const metadata: Metadata = {
  title: 'Abwesenheiten',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const TYPE_LABELS: Record<string, string> = {
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

export default async function AbsencesPage() {
  const { employeeId } = await requireEmployeeId();

  const year = new Date().getFullYear();

  const [absences, balance] = await Promise.all([
    prisma.absence.findMany({
      where: { employeeId },
      orderBy: { startDate: 'desc' },
      take: 50,
    }),
    getVacationBalance(employeeId, year),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Abwesenheiten"
        description="Ferien, Krankheit und weitere Abwesenheiten beantragen und einsehen. Die Betriebsleitung entscheidet in der Regel innerhalb von zwei Arbeitstagen."
        actions={<AbsenceRequestDialog remainingDays={balance.remaining} />}
      />

      <div className="grid gap-4 sm:grid-cols-4">
        <KpiTile label="Ferienanspruch" value={`${balance.entitlement} Tage`} hint={String(year)} />
        <KpiTile label="Bezogen" value={`${balance.taken} Tage`} />
        <KpiTile label="Beantragt" value={`${balance.pending} Tage`} />
        <KpiTile
          label="Noch verfügbar"
          value={`${balance.remaining} Tage`}
          accent={balance.remaining < 0 ? 'destructive' : undefined}
        />
      </div>

      {absences.length === 0 ? (
        <EmptyState
          icon={<Palmtree aria-hidden />}
          title="Noch keine Abwesenheiten"
          description="Beantrage deine Ferien möglichst früh — so kann das Büro die Einsätze rechtzeitig umplanen."
        />
      ) : (
        <ListCard>
          <TableScroll>
            <table className="data-table">
              <caption className="sr-only">Deine Abwesenheiten</caption>
              <thead>
                <tr>
                  <th scope="col">Art</th>
                  <th scope="col">Von</th>
                  <th scope="col">Bis</th>
                  <th scope="col" className="text-right">
                    Tage
                  </th>
                  <th scope="col">Grund</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {absences.map((absence) => (
                  <tr key={absence.id}>
                    <td className="font-medium">{TYPE_LABELS[absence.type] ?? absence.type}</td>
                    <td className="tabular-nums text-muted-foreground">
                      {formatDate(absence.startDate)}
                    </td>
                    <td className="tabular-nums text-muted-foreground">
                      {formatDate(absence.endDate)}
                    </td>
                    <td className="num">{toNumber(absence.days)}</td>
                    <td className="max-w-[16rem] truncate text-muted-foreground">
                      {absence.reason ?? absence.decisionNote ?? '—'}
                    </td>
                    <td>
                      <StatusBadge status={absence.status} />
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
