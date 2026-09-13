import Link from 'next/link';

import { cn, formatDate } from '@/lib/utils';
import { OBJECTIVE_HORIZON_LABELS, OBJECTIVE_STATUS_LABELS } from '@/lib/bi/labels';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/primitives';

/**
 * Die Roadmap — Zeitachse und Kanban aus denselben Zielen.
 *
 * Rein serverseitig: Balken sind Prozentbreiten in einem Raster von
 * Quartalen; Spalten sind Statusgruppen. Verschieben per Ziehen fehlt
 * absichtlich — ein Statuswechsel ist eine Entscheidung mit Protokoll, kein
 * Mausgriff.
 */

export interface RoadmapItem {
  id: string;
  title: string;
  horizon: string;
  status: string;
  priority: string;
  progressPct: number;
  startsOn: Date | null;
  endsOn: Date | null;
  fiscalYear: number | null;
  quarter: number | null;
  owner: { firstName: string; lastName: string } | null;
  department: string | null;
}

const STATUS_VARIANT: Record<string, 'neutral' | 'default' | 'warning' | 'success' | 'destructive'> = {
  DRAFT: 'neutral',
  ACTIVE: 'default',
  AT_RISK: 'warning',
  ACHIEVED: 'success',
  MISSED: 'destructive',
  CANCELLED: 'neutral',
};

const HORIZON_TONE: Record<string, string> = {
  STRATEGY: 'bg-primary/80',
  OBJECTIVE: 'bg-accent/80',
  INITIATIVE: 'bg-info/80',
};

/** Start und Ende eines Ziels als Kalendertage — Quartalsziele über ihr Quartal. */
function span(item: RoadmapItem): { start: Date; end: Date } | null {
  if (item.startsOn && item.endsOn) return { start: item.startsOn, end: item.endsOn };
  if (item.fiscalYear && item.quarter) {
    const start = new Date(Date.UTC(item.fiscalYear, (item.quarter - 1) * 3, 1));
    const end = new Date(Date.UTC(item.fiscalYear, item.quarter * 3, 0));
    return { start, end };
  }
  if (item.fiscalYear) return { start: new Date(Date.UTC(item.fiscalYear, 0, 1)), end: new Date(Date.UTC(item.fiscalYear, 11, 31)) };
  if (item.startsOn) return { start: item.startsOn, end: new Date(item.startsOn.getTime() + 90 * 86_400_000) };
  return null;
}

export function RoadmapTimeline({ items, year }: { items: RoadmapItem[]; year: number }) {
  const rangeStart = Date.UTC(year, 0, 1);
  const rangeEnd = Date.UTC(year + 1, 0, 1);
  const total = rangeEnd - rangeStart;
  const rows = items
    .map((item) => ({ item, span: span(item) }))
    .filter((r): r is { item: RoadmapItem; span: { start: Date; end: Date } } => r.span !== null && r.span.end.getTime() >= rangeStart && r.span.start.getTime() < rangeEnd);

  const todayPct = Math.max(0, Math.min(100, ((Date.now() - rangeStart) / total) * 100));

  return (
    <div className="overflow-x-auto rounded-2xl border border-border bg-card">
      <div className="min-w-[44rem]">
        <div className="grid grid-cols-[16rem_1fr] border-b border-border">
          <div className="px-4 py-2 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">Ziel</div>
          <div className="grid grid-cols-4 divide-x divide-border">
            {[1, 2, 3, 4].map((q) => (
              <div key={q} className="px-3 py-2 text-center text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                Q{q} {year}
              </div>
            ))}
          </div>
        </div>
        {rows.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">Keine Ziele mit Zeitraum in diesem Jahr.</p>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map(({ item, span: s }) => {
              const left = Math.max(0, ((s.start.getTime() - rangeStart) / total) * 100);
              const right = Math.min(100, ((s.end.getTime() - rangeStart) / total) * 100);
              return (
                <li key={item.id} className="grid grid-cols-[16rem_1fr] items-center">
                  <div className="min-w-0 px-4 py-3">
                    <Link href={`/admin/fuehrung/ziele/${item.id}`} className="block truncate text-sm font-medium hover:text-primary">
                      {item.title}
                    </Link>
                    <p className="truncate text-xs text-muted-foreground">
                      {OBJECTIVE_HORIZON_LABELS[item.horizon]} · {item.owner ? `${item.owner.firstName} ${item.owner.lastName}` : 'ohne Verantwortung'}
                    </p>
                  </div>
                  <div className="relative h-12 bg-[linear-gradient(to_right,transparent_calc(25%-1px),var(--color-border,#E2E9E9)_25%,transparent_calc(25%+1px),transparent_calc(50%-1px),var(--color-border,#E2E9E9)_50%,transparent_calc(50%+1px),transparent_calc(75%-1px),var(--color-border,#E2E9E9)_75%,transparent_calc(75%+1px))]">
                    <div className="absolute inset-y-0 w-px bg-destructive/60" style={{ left: `${todayPct}%` }} aria-hidden />
                    <div
                      className={cn('absolute top-3 h-6 overflow-hidden rounded-md text-2xs font-medium text-white', HORIZON_TONE[item.horizon] ?? 'bg-primary/80')}
                      style={{ left: `${left}%`, width: `${Math.max(1.5, right - left)}%` }}
                      title={`${formatDate(s.start)} – ${formatDate(s.end)} · ${item.progressPct} %`}
                    >
                      <div className="h-full bg-white/25" style={{ width: `${item.progressPct}%` }} />
                      <span className="absolute inset-0 flex items-center px-2 tabular-nums">{item.progressPct} %</span>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

const COLUMNS: { status: string; label: string }[] = [
  { status: 'DRAFT', label: 'Entwurf' },
  { status: 'ACTIVE', label: 'Aktiv' },
  { status: 'AT_RISK', label: 'Gefährdet' },
  { status: 'ACHIEVED', label: 'Erreicht' },
];

export function RoadmapKanban({ items }: { items: RoadmapItem[] }) {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {COLUMNS.map((column) => {
        const cards = items.filter((i) => i.status === column.status);
        return (
          <section key={column.status} className="rounded-2xl border border-border bg-muted/30 p-3" aria-label={column.label}>
            <header className="mb-3 flex items-center justify-between px-1">
              <h3 className="text-sm font-semibold">{column.label}</h3>
              <span className="text-xs tabular-nums text-muted-foreground">{cards.length}</span>
            </header>
            <ul className="space-y-2">
              {cards.map((item) => (
                <li key={item.id}>
                  <Link href={`/admin/fuehrung/ziele/${item.id}`} className="block space-y-2 rounded-xl border border-border bg-card p-3 shadow-soft transition-colors hover:border-primary/30">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-medium leading-snug">{item.title}</p>
                      <Badge size="sm" variant="outline">{OBJECTIVE_HORIZON_LABELS[item.horizon]}</Badge>
                    </div>
                    <Progress value={item.progressPct} aria-label={`${item.progressPct} %`} />
                    <p className="text-xs text-muted-foreground">
                      {item.owner ? `${item.owner.firstName} ${item.owner.lastName}` : 'Ohne Verantwortung'}
                      {item.endsOn ? ` · bis ${formatDate(item.endsOn)}` : item.quarter ? ` · Q${item.quarter} ${item.fiscalYear}` : ''}
                    </p>
                  </Link>
                </li>
              ))}
              {cards.length === 0 ? <li className="px-1 text-xs text-muted-foreground">Nichts hier.</li> : null}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

export function statusBadge(status: string) {
  return <Badge variant={STATUS_VARIANT[status] ?? 'neutral'} size="sm">{OBJECTIVE_STATUS_LABELS[status] ?? status}</Badge>;
}
