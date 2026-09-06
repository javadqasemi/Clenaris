import * as React from 'react';
import Link from 'next/link';
import { ArrowDownRight, ArrowRight, ArrowUpRight, Minus } from 'lucide-react';

import { cn, formatNumber } from '@/lib/utils';

/**
 * Kennzahlenkachel.
 *
 * Eine Zahl, ihr Name, und die Richtung gegenüber der Vorperiode. Die
 * Richtung wird durch Pfeil *und* Vorzeichen ausgedrückt, nicht nur durch
 * Farbe — und „mehr" ist nicht automatisch „gut": bei Kosten und Stornos
 * kehrt `invertTrend` die Bewertung um.
 */
export function KpiTile({
  label,
  value,
  changePercent,
  hint,
  href,
  invertTrend,
  accent,
  className,
}: {
  label: string;
  value: string;
  changePercent?: number;
  hint?: string;
  href?: string;
  /** true = ein Anstieg ist eine schlechte Nachricht (Kosten, Stornos). */
  invertTrend?: boolean;
  accent?: 'neutral' | 'warning' | 'destructive';
  className?: string;
}) {
  const hasTrend = typeof changePercent === 'number' && Number.isFinite(changePercent);
  const rising = hasTrend && changePercent! > 0.5;
  const falling = hasTrend && changePercent! < -0.5;
  const good = invertTrend ? falling : rising;
  const bad = invertTrend ? rising : falling;

  const TrendIcon = rising ? ArrowUpRight : falling ? ArrowDownRight : Minus;

  const content = (
    <>
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-muted-foreground">{label}</p>
        {href ? (
          <ArrowRight
            className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-spring group-hover:translate-x-0.5"
            aria-hidden
          />
        ) : null}
      </div>

      <p
        className={cn(
          'font-display text-3xl font-bold tabular-nums tracking-tight',
          accent === 'destructive' && 'text-destructive',
          accent === 'warning' && 'text-warning',
        )}
      >
        {value}
      </p>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        {hasTrend ? (
          <span
            className={cn(
              'inline-flex items-center gap-1 font-medium tabular-nums',
              good && 'text-success',
              bad && 'text-destructive',
              !good && !bad && 'text-muted-foreground',
            )}
          >
            <TrendIcon className="size-3.5" aria-hidden />
            {changePercent! > 0 ? '+' : ''}
            {formatNumber(changePercent!, 'de', 1)} %
          </span>
        ) : null}
        {hint ? <span className="text-muted-foreground">{hint}</span> : null}
      </div>
    </>
  );

  const classes = cn(
    'flex flex-col gap-2 rounded-2xl border border-border bg-card p-5 shadow-soft',
    href &&
      'group transition-[border-color,box-shadow] duration-300 ease-spring hover:border-primary/30 hover:shadow-card',
    className,
  );

  if (href) {
    return (
      <Link href={href} className={classes}>
        {content}
      </Link>
    );
  }

  return <div className={classes}>{content}</div>;
}

/** Kompakte Kennzahl für Listen und Detailseiten. */
export function StatLine({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: 'default' | 'success' | 'warning' | 'destructive';
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span
        className={cn(
          'text-sm font-semibold tabular-nums',
          accent === 'success' && 'text-success',
          accent === 'warning' && 'text-warning',
          accent === 'destructive' && 'text-destructive',
        )}
      >
        {value}
      </span>
    </div>
  );
}
