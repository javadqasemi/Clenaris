'use client';

import * as React from 'react';
import { Table2 } from 'lucide-react';

import { cn, formatCurrency, formatNumber } from '@/lib/utils';
import { Button } from '@/components/ui/button';

/**
 * Gemeinsame Bausteine aller Diagramme.
 *
 * Zwei Dinge sind hier bewusst nicht optional:
 *  • Jede Grafik hat eine Tabellenansicht. Wer die Zahlen exakt braucht oder
 *    einen Screenreader nutzt, kommt mit einem Klick an dieselben Daten.
 *  • Zahlen und Beschriftungen tragen nie die Reihenfarbe, sondern die
 *    Textfarben. Die Identität transportiert der farbige Punkt daneben.
 */

export function ChartCard({
  title,
  description,
  action,
  tableData,
  children,
  className,
  height = 300,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  /** Tabellenansicht: Kopfzeile und Zeilen als bereits formatierte Texte. */
  tableData?: { columns: string[]; rows: (string | number)[][] };
  children: React.ReactNode;
  className?: string;
  height?: number;
}) {
  const [showTable, setShowTable] = React.useState(false);
  const tableId = React.useId();

  return (
    <section
      className={cn('rounded-2xl border border-border bg-card p-6 shadow-soft', className)}
      aria-label={title}
    >
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="font-display text-base font-semibold tracking-tight">{title}</h3>
          {description ? (
            <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          {action}
          {tableData ? (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setShowTable((value) => !value)}
              aria-expanded={showTable}
              aria-controls={tableId}
              aria-label={showTable ? 'Diagramm anzeigen' : 'Als Tabelle anzeigen'}
              title={showTable ? 'Diagramm anzeigen' : 'Als Tabelle anzeigen'}
            >
              <Table2 aria-hidden />
            </Button>
          ) : null}
        </div>
      </header>

      {showTable && tableData ? (
        <div id={tableId} className="overflow-x-auto">
          <table className="data-table">
            {/* Die Tabellenansicht ist die barrierefreie Entsprechung des
                Diagramms — sie braucht eine eigene Beschriftung, weil sie ohne
                den Diagrammtitel daneben gelesen werden kann. */}
            <caption className="sr-only">{title} — Werte als Tabelle</caption>
            <thead>
              <tr>
                {tableData.columns.map((column, index) => (
                  <th key={column} scope="col" className={index > 0 ? 'text-right' : undefined}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tableData.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} className={cellIndex > 0 ? 'num' : undefined}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={{ height }} className="w-full">
          {children}
        </div>
      )}
    </section>
  );
}

/** Legende — bei zwei und mehr Reihen immer vorhanden. */
export function ChartLegend({
  items,
  className,
}: {
  items: { label: string; color: string; value?: string }[];
  className?: string;
}) {
  return (
    <ul className={cn('flex flex-wrap items-center gap-x-5 gap-y-2', className)}>
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-2 text-sm">
          <span
            className="size-2.5 shrink-0 rounded-[3px]"
            style={{ backgroundColor: item.color }}
            aria-hidden
          />
          <span className="text-muted-foreground">{item.label}</span>
          {item.value ? (
            <span className="font-medium tabular-nums text-foreground">{item.value}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export interface TooltipPayloadEntry {
  name?: string;
  value?: number | string;
  color?: string;
  dataKey?: string | number;
  payload?: Record<string, unknown>;
}

/**
 * Tooltip im Stil der Applikation.
 * `formatter` bestimmt die Darstellung — Standard ist CHF.
 */
export function ChartTooltip({
  active,
  payload,
  label,
  formatter = (value) => formatCurrency(Number(value)),
  labelFormatter,
}: {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  label?: string | number;
  formatter?: (value: number | string) => string;
  labelFormatter?: (label: string | number) => string;
}) {
  if (!active || !payload?.length) return null;

  return (
    <div className="pointer-events-none min-w-40 rounded-xl border border-border bg-popover p-3 shadow-elevated">
      {label !== undefined ? (
        <p className="mb-2 text-xs font-medium text-muted-foreground">
          {labelFormatter ? labelFormatter(label) : label}
        </p>
      ) : null}

      <ul className="space-y-1.5">
        {payload.map((entry, index) => (
          <li key={index} className="flex items-center justify-between gap-4 text-sm">
            <span className="flex items-center gap-2">
              <span
                className="size-2.5 shrink-0 rounded-[3px]"
                style={{ backgroundColor: entry.color }}
                aria-hidden
              />
              <span className="text-muted-foreground">{entry.name}</span>
            </span>
            <span className="font-medium tabular-nums text-foreground">
              {formatter(entry.value ?? 0)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Leerzustand statt eines leeren Koordinatensystems. */
export function ChartEmpty({ message }: { message: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  );
}

/** Achsenbeschriftung: kompakte Frankenbeträge (CHF 12.4k). */
export function formatAxisCurrency(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${formatNumber(value / 1_000_000, 'de', 1)} Mio.`;
  if (Math.abs(value) >= 1000) return `${formatNumber(value / 1000, 'de', value % 1000 === 0 ? 0 : 1)}k`;
  return formatNumber(value, 'de', 0);
}
