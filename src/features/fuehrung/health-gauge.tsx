import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';

import { cn } from '@/lib/utils';
import { formatKpiValue, HEALTH_STATUS_LABELS } from '@/lib/bi/labels';
import type { HealthComponent } from '@/server/services/health.service';

/**
 * Der Gesundheitswert als Ring mit Herleitung.
 *
 * Kein Diagramm-Framework: ein `conic-gradient` und ein paar Zeilen — das
 * rendert auf dem Server, springt nicht beim Laden und braucht keine 100 kB.
 * Die Farbe folgt der Stufe; die Zahl steht daneben, weil eine Farbe allein
 * niemandem sagt, ob 73 gut ist.
 */
const STATUS_COLOR: Record<string, string> = {
  EXCELLENT: 'text-success',
  GOOD: 'text-primary',
  ATTENTION: 'text-warning',
  CRITICAL: 'text-destructive',
};

const STATUS_RING: Record<string, string> = {
  EXCELLENT: 'var(--color-success, #047857)',
  GOOD: 'var(--color-primary, #0B7285)',
  ATTENTION: 'var(--color-warning, #B45309)',
  CRITICAL: 'var(--color-destructive, #B91C1C)',
};

export function HealthGauge({
  score,
  status,
  delta,
  topRisk,
  components,
  compact = false,
}: {
  score: number | null;
  status: string | null;
  delta?: number | null;
  topRisk: string | null;
  components: HealthComponent[];
  compact?: boolean;
}) {
  const ring = status ? STATUS_RING[status] : 'var(--color-muted-foreground, #94A3B8)';
  const angle = score === null ? 0 : (score / 100) * 360;
  const DeltaIcon = delta === null || delta === undefined || delta === 0 ? Minus : delta > 0 ? ArrowUpRight : ArrowDownRight;

  return (
    <div className={cn('grid gap-6', compact ? 'sm:grid-cols-[auto_1fr]' : 'lg:grid-cols-[auto_1fr]')}>
      <div className="flex items-center gap-5">
        <div
          className="relative flex size-32 shrink-0 items-center justify-center rounded-full"
          style={{ background: `conic-gradient(${ring} ${angle}deg, color-mix(in oklab, ${ring} 14%, transparent) ${angle}deg)` }}
          role="img"
          aria-label={score === null ? 'Gesundheitswert noch nicht berechenbar' : `Gesundheitswert ${score} von 100, ${HEALTH_STATUS_LABELS[status ?? '']}`}
        >
          <div className="flex size-[6.4rem] flex-col items-center justify-center rounded-full bg-card">
            <span className={cn('font-display text-4xl font-bold tabular-nums tracking-tight', status ? STATUS_COLOR[status] : 'text-muted-foreground')}>
              {score ?? '—'}
            </span>
            <span className="text-2xs uppercase tracking-wide text-muted-foreground">von 100</span>
          </div>
        </div>
        <div className="space-y-1.5">
          <p className={cn('font-display text-lg font-semibold', status ? STATUS_COLOR[status] : 'text-muted-foreground')}>
            {status ? HEALTH_STATUS_LABELS[status] : 'Noch keine Bewertung'}
          </p>
          {delta !== undefined && delta !== null ? (
            <p className="flex items-center gap-1 text-sm text-muted-foreground">
              <DeltaIcon className="size-3.5" aria-hidden />
              {delta > 0 ? '+' : ''}
              {delta} Punkte gegenüber Vormonat
            </p>
          ) : null}
          {topRisk ? <p className="prose-measure text-sm leading-relaxed">{topRisk}</p> : null}
          {status === null ? (
            <p className="prose-measure text-sm leading-relaxed text-muted-foreground">
              Setzen Sie bei den Kennzahlen Zielwert und Warnschwelle — dann entsteht der Wert beim nächsten Nachtlauf.
            </p>
          ) : null}
        </div>
      </div>

      {!compact ? (
        <ul className="grid gap-3 sm:grid-cols-2">
          {components.map((c) => (
            <li key={c.key} className="rounded-xl border border-border bg-card/60 p-3.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm font-medium">{c.label}</span>
                <span className="text-sm tabular-nums text-muted-foreground">
                  {c.subScore === null ? '—' : `${c.subScore}`} · Gewicht {c.weight}
                </span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-primary" style={{ width: `${c.subScore ?? 0}%` }} />
              </div>
              <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
                {c.metrics.map((m) => (
                  <li key={m.key} className="flex justify-between gap-2">
                    <span className="truncate">{m.label}</span>
                    <span className="shrink-0 tabular-nums">
                      {m.excluded ? m.excluded : `${formatKpiValue(m.value, m.unit)} → ${m.subScore}`}
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
