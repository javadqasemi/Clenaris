import Link from 'next/link';

import { cn } from '@/lib/utils';
import { riskBand } from '@/lib/bi/math';

/**
 * Die 5×5-Risikomatrix.
 *
 * Zeilen: Wahrscheinlichkeit (unten 1, oben 5), Spalten: Auswirkung. Die
 * Farbe folgt der Schwere der Zelle, nicht der Zahl der Einträge — eine
 * Zelle mit drei geringen Risiken ist kein Alarm, eine mit einem kritischen
 * schon. Die Zahl steht in der Zelle, die Titel im Tooltip.
 */
const BAND_BG: Record<string, string> = {
  LOW: 'bg-success/10',
  MEDIUM: 'bg-warning/10',
  HIGH: 'bg-warning/25',
  CRITICAL: 'bg-destructive/25',
};

export function RiskMatrix({
  cells,
  compact = false,
}: {
  cells: { probability: number; impact: number; risks: { id: string; title: string; severity: number }[] }[];
  compact?: boolean;
}) {
  const at = (p: number, i: number) => cells.find((c) => c.probability === p && c.impact === i);
  return (
    <div className="overflow-x-auto">
      <div className={cn('grid gap-1', compact ? 'min-w-[18rem]' : 'min-w-[24rem]')} style={{ gridTemplateColumns: 'auto repeat(5, minmax(0, 1fr))' }} role="table" aria-label="Risikomatrix">
        {[5, 4, 3, 2, 1].map((p) => (
          <div key={p} className="contents" role="row">
            <div className="flex items-center justify-end pr-2 text-2xs font-medium text-muted-foreground" role="rowheader">
              W{p}
            </div>
            {[1, 2, 3, 4, 5].map((i) => {
              const cell = at(p, i);
              const count = cell?.risks.length ?? 0;
              const band = riskBand(p * i);
              return (
                <div
                  key={i}
                  role="cell"
                  title={cell?.risks.map((r) => r.title).join('\n') || undefined}
                  className={cn('flex aspect-square items-center justify-center rounded-md text-sm font-semibold tabular-nums', BAND_BG[band], count === 0 && 'text-muted-foreground/40', compact ? 'text-xs' : '')}
                >
                  {count > 0 ? (
                    cell && cell.risks.length === 1 ? (
                      <Link href={`/admin/fuehrung/risiken/${cell.risks[0].id}`} className="flex size-full items-center justify-center rounded-md hover:bg-card/60">
                        {count}
                      </Link>
                    ) : (
                      count
                    )
                  ) : (
                    '·'
                  )}
                </div>
              );
            })}
          </div>
        ))}
        <div role="row" className="contents">
          <div />
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="pt-1 text-center text-2xs font-medium text-muted-foreground" role="columnheader">
              A{i}
            </div>
          ))}
        </div>
      </div>
      <p className="mt-2 text-2xs text-muted-foreground">W = Wahrscheinlichkeit, A = Auswirkung, je 1–5. Schwere = W × A.</p>
    </div>
  );
}
