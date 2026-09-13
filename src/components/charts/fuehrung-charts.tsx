'use client';

import * as React from 'react';
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { formatCurrency, formatNumber } from '@/lib/utils';
import { formatKpiValue } from '@/lib/bi/labels';
import { useChartTheme } from './theme';
import { ChartCard, ChartEmpty, ChartLegend, ChartTooltip, formatAxisCurrency } from './chart-parts';

/**
 * Diagramme der Unternehmensführung.
 *
 *  • Kennzahlverlauf → Linie mit Zielwert als Referenz und Vorjahr als
 *    gestrichelte zweite Linie. Beide in derselben Einheit, also eine Achse.
 *  • Gesundheitswert → Fläche 0..100 mit den vier Stufen als Hintergrund.
 *  • Szenario → Balken fürs Monatsergebnis, Linie für die Liquidität.
 *  • Budget → gruppierte Balken Plan/Ist je Monat.
 */

function axisFormatter(unit: string) {
  return (value: number) => (unit === 'CURRENCY' ? formatAxisCurrency(value) : formatNumber(value, 'de', 0));
}

export interface KpiSeriesChartPoint {
  label: string;
  value: number;
  targetValue: number | null;
  previousYearValue: number | null;
  provisional: boolean;
}

export function KpiSeriesChart({ title, unit, data, className }: { title: string; unit: string; data: KpiSeriesChartPoint[]; className?: string }) {
  const { theme } = useChartTheme();
  const [valueColor, , previousColor] = theme.categorical;
  const hasTarget = data.some((p) => p.targetValue !== null);
  const hasPrevious = data.some((p) => p.previousYearValue !== null);

  return (
    <ChartCard
      title={title}
      description="Festgeschriebene Werte je Periode; die laufende Periode ist vorläufig."
      className={className}
      height={300}
      action={
        <ChartLegend
          items={[
            { label: 'Wert', color: valueColor },
            ...(hasPrevious ? [{ label: 'Vorjahr', color: previousColor }] : []),
            ...(hasTarget ? [{ label: 'Ziel', color: theme.reference }] : []),
          ]}
        />
      }
      tableData={{
        columns: ['Periode', 'Wert', 'Vorjahr', 'Ziel'],
        rows: data.map((p) => [p.label + (p.provisional ? ' (vorläufig)' : ''), formatKpiValue(p.value, unit), formatKpiValue(p.previousYearValue, unit), formatKpiValue(p.targetValue, unit)]),
      }}
    >
      {data.length === 0 ? (
        <ChartEmpty message="Noch keine Werte — der Nachtlauf schreibt den ersten Snapshot." />
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
            <CartesianGrid stroke={theme.grid} vertical={false} />
            <XAxis dataKey="label" tick={{ fill: theme.label, fontSize: 12 }} tickLine={false} axisLine={{ stroke: theme.axis }} dy={6} />
            <YAxis tick={{ fill: theme.label, fontSize: 12 }} tickLine={false} axisLine={false} tickFormatter={axisFormatter(unit)} width={56} />
            <Tooltip content={<ChartTooltip formatter={(v) => formatKpiValue(Number(v), unit)} />} cursor={{ stroke: theme.axis }} />
            {hasPrevious ? <Line type="monotone" dataKey="previousYearValue" name="Vorjahr" stroke={previousColor} strokeDasharray="4 4" strokeWidth={1.5} dot={false} connectNulls /> : null}
            <Line type="monotone" dataKey="value" name="Wert" stroke={valueColor} strokeWidth={2.5} dot={{ r: 3, fill: valueColor, strokeWidth: 0 }} activeDot={{ r: 5 }} />
            {hasTarget ? <Line type="stepAfter" dataKey="targetValue" name="Ziel" stroke={theme.reference} strokeWidth={1} dot={false} connectNulls /> : null}
          </LineChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  );
}

export function HealthHistoryChart({ data, className }: { data: { takenOn: string; score: number }[]; className?: string }) {
  const { theme } = useChartTheme();
  const color = theme.categorical[0];
  return (
    <ChartCard
      title="Verlauf des Gesundheitswerts"
      description="Ein Wert je Tag, festgeschrieben vom Nachtlauf."
      className={className}
      height={220}
      tableData={{ columns: ['Datum', 'Wert'], rows: data.map((p) => [p.takenOn, p.score]) }}
    >
      {data.length < 2 ? (
        <ChartEmpty message="Der Verlauf entsteht mit den nächsten Nachtläufen." />
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="health-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.35} />
                <stop offset="100%" stopColor={color} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={theme.grid} vertical={false} />
            <XAxis dataKey="takenOn" tick={{ fill: theme.label, fontSize: 11 }} tickLine={false} axisLine={{ stroke: theme.axis }} tickFormatter={(v: string) => v.slice(5)} minTickGap={24} />
            <YAxis domain={[0, 100]} tick={{ fill: theme.label, fontSize: 12 }} tickLine={false} axisLine={false} width={32} />
            <ReferenceLine y={70} stroke={theme.reference} strokeDasharray="3 3" />
            <ReferenceLine y={50} stroke={theme.diverging.negative} strokeDasharray="3 3" strokeOpacity={0.6} />
            <Tooltip content={<ChartTooltip formatter={(v) => `${v} von 100`} />} />
            <Area type="monotone" dataKey="score" name="Gesundheitswert" stroke={color} strokeWidth={2} fill="url(#health-fill)" />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  );
}

export interface ScenarioChartPoint {
  month: number;
  revenue: number;
  result: number;
  cash: number;
}

export function ScenarioChart({ data, className, title = 'Ergebnis und Liquidität je Monat' }: { data: ScenarioChartPoint[]; className?: string; title?: string }) {
  const { theme } = useChartTheme();
  return (
    <ChartCard
      title={title}
      description="Balken: Monatsergebnis. Linie: Liquidität am Monatsende — inklusive Zahlungsverzug und Investitionen."
      className={className}
      height={300}
      action={
        <ChartLegend
          items={[
            { label: 'Ergebnis', color: theme.diverging.positive },
            { label: 'Liquidität', color: theme.categorical[2] },
          ]}
        />
      }
      tableData={{ columns: ['Monat', 'Umsatz', 'Ergebnis', 'Liquidität'], rows: data.map((p) => [`M${p.month}`, formatCurrency(p.revenue), formatCurrency(p.result), formatCurrency(p.cash)]) }}
    >
      {data.length === 0 ? (
        <ChartEmpty message="Noch nicht gerechnet." />
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
            <CartesianGrid stroke={theme.grid} vertical={false} />
            <XAxis dataKey="month" tick={{ fill: theme.label, fontSize: 12 }} tickLine={false} axisLine={{ stroke: theme.axis }} tickFormatter={(m: number) => `M${m}`} />
            <YAxis tick={{ fill: theme.label, fontSize: 12 }} tickLine={false} axisLine={false} tickFormatter={formatAxisCurrency} width={60} />
            <ReferenceLine y={0} stroke={theme.reference} />
            <Tooltip content={<ChartTooltip labelFormatter={(m) => `Monat ${m}`} />} cursor={{ fill: theme.grid }} />
            <Bar dataKey="result" name="Ergebnis" radius={[4, 4, 0, 0]} fill={theme.diverging.positive} />
            <Line type="monotone" dataKey="cash" name="Liquidität" stroke={theme.categorical[2]} strokeWidth={2.5} dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  );
}

export function BudgetVarianceChart({ data, className }: { data: { label: string; plan: number; actual: number }[]; className?: string }) {
  const { theme } = useChartTheme();
  return (
    <ChartCard
      title="Plan und Ist je Monat"
      description="Summe über alle Budgetzeilen. Monate ohne Ist liegen noch in der Zukunft."
      className={className}
      height={260}
      action={
        <ChartLegend
          items={[
            { label: 'Plan', color: theme.sequential[4] },
            { label: 'Ist', color: theme.categorical[0] },
          ]}
        />
      }
      tableData={{ columns: ['Monat', 'Plan', 'Ist'], rows: data.map((p) => [p.label, formatCurrency(p.plan), formatCurrency(p.actual)]) }}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 16, left: 8, bottom: 0 }} barGap={2}>
          <CartesianGrid stroke={theme.grid} vertical={false} />
          <XAxis dataKey="label" tick={{ fill: theme.label, fontSize: 12 }} tickLine={false} axisLine={{ stroke: theme.axis }} />
          <YAxis tick={{ fill: theme.label, fontSize: 12 }} tickLine={false} axisLine={false} tickFormatter={formatAxisCurrency} width={60} />
          <Tooltip content={<ChartTooltip />} cursor={{ fill: theme.grid }} />
          <Bar dataKey="plan" name="Plan" fill={theme.sequential[4]} radius={[4, 4, 0, 0]} />
          <Bar dataKey="actual" name="Ist" fill={theme.categorical[0]} radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
