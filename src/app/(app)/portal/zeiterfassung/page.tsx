import type { Metadata } from 'next';
import Link from 'next/link';
import { Clock } from 'lucide-react';

import { requireEmployeeId } from '@/lib/auth/session';
import { formatDate, formatDuration, formatTime, formatNumber } from '@/lib/utils';
import { periodOf } from '@/lib/bi/periods';
import { tagPlus, zuercherTag, zuercherTagesbeginn } from '@/lib/zuerich';
import { getTimesheet } from '@/server/services/employee.service';
import { Badge } from '@/components/ui/badge';
import { KpiTile } from '@/components/app/kpi-tile';
import { RangePicker } from '@/components/app/range-picker';
import {
  EmptyState,
  ListCard,
  PageHeader,
  TableScroll,
} from '@/components/app/page-parts';

export const metadata: Metadata = {
  title: 'Zeiterfassung',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function TimesheetPage({
  searchParams,
}: {
  searchParams: Promise<{ zeitraum?: string }>;
}) {
  const { employeeId } = await requireEmployeeId();

  const params = await searchParams;
  const range = params.zeitraum ?? 'month';

  const now = new Date();
  const { from, to } = resolvePeriod(range, now);

  const timesheet = await getTimesheet({ employeeId, from, to });

  // Sollarbeitszeit: Werktage × 8.4 Stunden.
  const workdays = countWorkdays(from, to > now ? now : to);
  const targetHours = workdays * 8.4;
  const balance = timesheet.totalHours - targetHours;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Zeiterfassung"
        description="Deine erfassten Arbeitszeiten. Sie entstehen automatisch beim Ein- und Ausstempeln auf einem Einsatz."
        actions={<RangePicker current={range} />}
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <KpiTile
          label="Erfasste Stunden"
          value={formatNumber(timesheet.totalHours, 'de', 1)}
          hint={`${formatDate(from)} – ${formatDate(to)}`}
        />
        <KpiTile
          label="Sollzeit"
          value={formatNumber(targetHours, 'de', 1)}
          hint={`${workdays} Arbeitstage`}
        />
        <KpiTile
          label="Saldo"
          value={`${balance >= 0 ? '+' : ''}${formatNumber(balance, 'de', 1)} Std.`}
          accent={balance < -8 ? 'warning' : undefined}
        />
      </div>

      {timesheet.entries.length === 0 ? (
        <EmptyState
          icon={<Clock aria-hidden />}
          title="Keine Zeiten im Zeitraum"
          description="Stempel dich auf einem Einsatz ein und wieder aus — die Zeit wird dann automatisch erfasst."
          action={{ href: '/portal/einsaetze', label: 'Meine Einsätze' }}
        />
      ) : (
        <ListCard title="Einzelbuchungen">
          <TableScroll>
            <table className="data-table">
              <caption className="sr-only">
                Zeiterfassung von {formatDate(from)} bis {formatDate(to)}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Datum</th>
                  <th scope="col">Einsatz</th>
                  <th scope="col">Von</th>
                  <th scope="col">Bis</th>
                  <th scope="col" className="text-right">
                    Pause
                  </th>
                  <th scope="col" className="text-right">
                    Dauer
                  </th>
                  <th scope="col">Freigabe</th>
                </tr>
              </thead>
              <tbody>
                {timesheet.entries.map((entry) => (
                  <tr key={entry.id}>
                    <td className="tabular-nums text-muted-foreground">
                      {formatDate(entry.startedAt)}
                    </td>
                    <td>
                      {entry.job ? (
                        <Link
                          href={`/portal/einsaetze/${entry.job.id}`}
                          className="text-primary underline-offset-4 hover:underline"
                        >
                          {entry.job.number}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                      {entry.job?.address ? (
                        <span className="block text-xs text-muted-foreground">
                          {entry.job.address.postalCode} {entry.job.address.city}
                        </span>
                      ) : null}
                    </td>
                    <td className="tabular-nums">{formatTime(entry.startedAt)}</td>
                    <td className="tabular-nums">
                      {entry.endedAt ? (
                        formatTime(entry.endedAt)
                      ) : (
                        <span className="text-primary">läuft</span>
                      )}
                    </td>
                    <td className="num text-muted-foreground">
                      {entry.breakMin > 0 ? `${entry.breakMin} Min.` : '—'}
                    </td>
                    <td className="num font-medium">
                      {entry.endedAt ? formatDuration(entry.minutes) : '—'}
                    </td>
                    <td>
                      <Badge variant={entry.approved ? 'success' : 'neutral'} size="sm">
                        {entry.approved ? 'Freigegeben' : 'Offen'}
                      </Badge>
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

/**
 * Zeitraum der eigenen Auswertung — Zürcher Grenzen (2026-09-27).
 *
 * Vorher mit `new Date(y, m, d)` und `setHours` in der Zone des Servers: Tag,
 * Woche, Monat, Quartal und Jahr begannen um 01:00/02:00 Zürcher Zeit, und
 * die Stunden einer Schicht ab Mitternacht fielen in den Vorzeitraum. `to` ist
 * ausschliessend.
 */
function resolvePeriod(range: string, now: Date): { from: Date; to: Date } {
  switch (range) {
    case 'today': {
      const p = periodOf('DAY', now);
      return { from: p.from, to: p.to };
    }
    case 'week': {
      const p = periodOf('WEEK', now);
      return { from: p.from, to: p.to };
    }
    case 'quarter':
      return { from: periodOf('QUARTER', now).from, to: now };
    case 'year':
      return { from: periodOf('YEAR', now).from, to: now };
    case 'month':
    default:
      return { from: periodOf('MONTH', now).from, to: now };
  }
}

/**
 * Werktage der Zürcher Tage, die im Zeitraum beginnen (`to` ausschliessend).
 * Die frühere Schleife lief mit `<=` bis zum ausschliessenden Ende und zählte
 * für „Heute" zwei Soll-Tage.
 */
function countWorkdays(from: Date, to: Date): number {
  let count = 0;
  for (let tag = zuercherTag(from); zuercherTagesbeginn(tag) < to; tag = tagPlus(tag, 1)) {
    const wochentag = tag.getUTCDay();
    if (wochentag !== 0 && wochentag !== 6) count++;
  }
  return count;
}
