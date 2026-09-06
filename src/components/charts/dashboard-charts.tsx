'use client';

import * as React from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
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
import { rampFor, useChartTheme } from './theme';
import {
  ChartCard,
  ChartEmpty,
  ChartLegend,
  ChartTooltip,
  formatAxisCurrency,
} from './chart-parts';

/**
 * Die Diagramme des Administrationsbereichs.
 *
 * Formenwahl:
 *  • Umsatz/Kosten/Gewinn über die Zeit → Linien. Drei Reihen derselben
 *    Einheit auf *einer* Achse; eine zweite y-Achse wäre irreführend.
 *  • Umsatz je Leistung → liegende Balken mit einfarbiger Abstufung. Es ist
 *    eine Rangliste, keine Identitätsfrage — die Achsenbeschriftung benennt
 *    die Leistung, die Farbe zeigt nur die Grösse.
 *  • Auslastung → liegende Balken mit Referenzlinie bei 100 %.
 *  • Liquidität → Balken für den Wochensaldo (zweipolig eingefärbt) plus
 *    Linie für den kumulierten Verlauf; beide in Franken, also eine Achse.
 */

// ---------------------------------------------------------------------------
//  Umsatz, Kosten, Gewinn
// ---------------------------------------------------------------------------

export interface RevenuePoint {
  period: string;
  label: string;
  revenue: number;
  expenses: number;
  profit: number;
}

export function RevenueTrendChart({
  data,
  className,
}: {
  data: RevenuePoint[];
  className?: string;
}) {
  const { theme } = useChartTheme();
  const [revenueColor, expenseColor, profitColor] = theme.categorical;

  const totals = React.useMemo(
    () => ({
      revenue: data.reduce((sum, point) => sum + point.revenue, 0),
      expenses: data.reduce((sum, point) => sum + point.expenses, 0),
      profit: data.reduce((sum, point) => sum + point.profit, 0),
    }),
    [data],
  );

  return (
    <ChartCard
      title="Umsatz, Kosten und Gewinn"
      description="Umsatz nach Soll-Prinzip (ausgestellte Rechnungen), Kosten nach Belegdatum."
      className={className}
      height={320}
      action={
        <ChartLegend
          items={[
            { label: 'Umsatz', color: revenueColor, value: formatCurrency(totals.revenue) },
            { label: 'Kosten', color: expenseColor, value: formatCurrency(totals.expenses) },
            { label: 'Gewinn', color: profitColor, value: formatCurrency(totals.profit) },
          ]}
        />
      }
      tableData={{
        columns: ['Periode', 'Umsatz', 'Kosten', 'Gewinn'],
        rows: data.map((point) => [
          point.label,
          formatCurrency(point.revenue),
          formatCurrency(point.expenses),
          formatCurrency(point.profit),
        ]),
      }}
    >
      {data.length === 0 ? (
        <ChartEmpty message="Für diesen Zeitraum liegen noch keine Zahlen vor." />
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
            <CartesianGrid stroke={theme.grid} vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fill: theme.label, fontSize: 12 }}
              tickLine={false}
              axisLine={{ stroke: theme.axis }}
              dy={6}
            />
            <YAxis
              tick={{ fill: theme.label, fontSize: 12 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={formatAxisCurrency}
              width={56}
            />
            <Tooltip
              content={<ChartTooltip />}
              cursor={{ stroke: theme.axis, strokeWidth: 1, strokeDasharray: '4 4' }}
            />
            <ReferenceLine y={0} stroke={theme.reference} strokeWidth={1} />
            <Line
              type="monotone"
              dataKey="revenue"
              name="Umsatz"
              stroke={revenueColor}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 5, strokeWidth: 2, stroke: theme.surface }}
            />
            <Line
              type="monotone"
              dataKey="expenses"
              name="Kosten"
              stroke={expenseColor}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 5, strokeWidth: 2, stroke: theme.surface }}
            />
            <Line
              type="monotone"
              dataKey="profit"
              name="Gewinn"
              stroke={profitColor}
              strokeWidth={2}
              strokeDasharray="5 3"
              dot={false}
              activeDot={{ r: 5, strokeWidth: 2, stroke: theme.surface }}
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  );
}

// ---------------------------------------------------------------------------
//  Umsatz je Leistung
// ---------------------------------------------------------------------------

export interface ServiceShare {
  name: string;
  revenue: number;
  jobs: number;
  share: number;
}

export function ServiceRevenueChart({
  data,
  className,
}: {
  data: ServiceShare[];
  className?: string;
}) {
  const { theme } = useChartTheme();
  const sorted = React.useMemo(() => [...data].sort((a, b) => b.revenue - a.revenue), [data]);
  const colors = rampFor(theme, sorted.length);

  return (
    <ChartCard
      title="Umsatz nach Leistung"
      description="Anteil am Gesamtumsatz im gewählten Zeitraum."
      className={className}
      height={Math.max(220, sorted.length * 46)}
      tableData={{
        columns: ['Leistung', 'Umsatz', 'Anteil', 'Aufträge'],
        rows: sorted.map((item) => [
          item.name,
          formatCurrency(item.revenue),
          `${formatNumber(item.share, 'de', 1)} %`,
          item.jobs,
        ]),
      }}
    >
      {sorted.length === 0 ? (
        <ChartEmpty message="Noch keine abgerechneten Leistungen im Zeitraum." />
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={sorted}
            layout="vertical"
            margin={{ top: 0, right: 72, left: 0, bottom: 0 }}
            barCategoryGap={10}
          >
            <CartesianGrid stroke={theme.grid} horizontal={false} />
            <XAxis
              type="number"
              tick={{ fill: theme.label, fontSize: 12 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={formatAxisCurrency}
            />
            <YAxis
              type="category"
              dataKey="name"
              tick={{ fill: theme.label, fontSize: 12 }}
              tickLine={false}
              axisLine={false}
              width={150}
            />
            <Tooltip
              content={
                <ChartTooltip
                  formatter={(value) => formatCurrency(Number(value))}
                  labelFormatter={(label) => String(label)}
                />
              }
              cursor={{ fill: theme.grid }}
            />
            <Bar dataKey="revenue" name="Umsatz" radius={[0, 4, 4, 0]} maxBarSize={26}>
              {sorted.map((item, index) => (
                <Cell key={item.name} fill={colors[index]} stroke={theme.surface} strokeWidth={2} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  );
}

// ---------------------------------------------------------------------------
//  Auslastung
// ---------------------------------------------------------------------------

export interface UtilizationRow {
  id: string;
  name: string;
  hours: number;
  jobs: number;
  utilizationPercent: number;
}

export function UtilizationChart({
  data,
  className,
}: {
  data: UtilizationRow[];
  className?: string;
}) {
  const { theme } = useChartTheme();
  const sorted = React.useMemo(
    () => [...data].sort((a, b) => b.utilizationPercent - a.utilizationPercent),
    [data],
  );
  const colors = rampFor(theme, sorted.length);

  return (
    <ChartCard
      title="Auslastung des Teams"
      description="Erfasste Stunden im Verhältnis zur Sollarbeitszeit. Die Linie markiert 100 %."
      className={className}
      height={Math.max(220, sorted.length * 42)}
      tableData={{
        columns: ['Person', 'Stunden', 'Einsätze', 'Auslastung'],
        rows: sorted.map((row) => [
          row.name,
          formatNumber(row.hours, 'de', 1),
          row.jobs,
          `${formatNumber(row.utilizationPercent, 'de', 0)} %`,
        ]),
      }}
    >
      {sorted.length === 0 ? (
        <ChartEmpty message="Noch keine erfassten Arbeitszeiten im Zeitraum." />
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={sorted}
            layout="vertical"
            margin={{ top: 0, right: 32, left: 0, bottom: 0 }}
            barCategoryGap={8}
          >
            <CartesianGrid stroke={theme.grid} horizontal={false} />
            <XAxis
              type="number"
              domain={[0, (max: number) => Math.max(120, Math.ceil(max / 20) * 20)]}
              tick={{ fill: theme.label, fontSize: 12 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(value: number) => `${value} %`}
            />
            <YAxis
              type="category"
              dataKey="name"
              tick={{ fill: theme.label, fontSize: 12 }}
              tickLine={false}
              axisLine={false}
              width={140}
            />
            <Tooltip
              content={
                <ChartTooltip formatter={(value) => `${formatNumber(Number(value), 'de', 0)} %`} />
              }
              cursor={{ fill: theme.grid }}
            />
            <ReferenceLine
              x={100}
              stroke={theme.reference}
              strokeDasharray="4 4"
              strokeWidth={1}
              label={{ value: 'Soll', position: 'top', fill: theme.label, fontSize: 11 }}
            />
            <Bar
              dataKey="utilizationPercent"
              name="Auslastung"
              radius={[0, 4, 4, 0]}
              maxBarSize={22}
            >
              {sorted.map((row, index) => (
                <Cell key={row.id} fill={colors[index]} stroke={theme.surface} strokeWidth={2} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  );
}

// ---------------------------------------------------------------------------
//  Liquidität
// ---------------------------------------------------------------------------

export interface CashflowWeek {
  week: string;
  inflow: number;
  outflow: number;
  net: number;
  cumulative: number;
}

export function CashflowChart({
  data,
  className,
}: {
  data: CashflowWeek[];
  className?: string;
}) {
  const { theme } = useChartTheme();

  const chartData = React.useMemo(
    () =>
      data.map((week) => ({
        ...week,
        label: new Intl.DateTimeFormat('de-CH', {
          timeZone: 'Europe/Zurich',
          day: '2-digit',
          month: 'short',
        }).format(new Date(week.week)),
      })),
    [data],
  );

  return (
    <ChartCard
      title="Liquiditätsvorschau"
      description="Erwartete Zahlungseingänge abzüglich offener Verbindlichkeiten, kumuliert über zwölf Wochen."
      className={className}
      height={300}
      action={
        <ChartLegend
          items={[
            { label: 'Überschuss', color: theme.diverging.positive },
            { label: 'Unterdeckung', color: theme.diverging.negative },
            { label: 'Kumuliert', color: theme.categorical[2] },
          ]}
        />
      }
      tableData={{
        columns: ['Woche ab', 'Eingang', 'Ausgang', 'Saldo', 'Kumuliert'],
        rows: chartData.map((week) => [
          week.label,
          formatCurrency(week.inflow),
          formatCurrency(week.outflow),
          formatCurrency(week.net),
          formatCurrency(week.cumulative),
        ]),
      }}
    >
      {chartData.length === 0 ? (
        <ChartEmpty message="Keine offenen Posten in den nächsten zwölf Wochen." />
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
            <CartesianGrid stroke={theme.grid} vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fill: theme.label, fontSize: 12 }}
              tickLine={false}
              axisLine={{ stroke: theme.axis }}
              dy={6}
            />
            <YAxis
              tick={{ fill: theme.label, fontSize: 12 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={formatAxisCurrency}
              width={56}
            />
            <Tooltip
              content={<ChartTooltip />}
              cursor={{ fill: theme.grid }}
            />
            <ReferenceLine y={0} stroke={theme.reference} strokeWidth={1} />
            <Bar dataKey="net" name="Wochensaldo" radius={[4, 4, 0, 0]} maxBarSize={28}>
              {chartData.map((week) => (
                <Cell
                  key={week.week}
                  fill={week.net >= 0 ? theme.diverging.positive : theme.diverging.negative}
                  stroke={theme.surface}
                  strokeWidth={2}
                />
              ))}
            </Bar>
            <Line
              type="monotone"
              dataKey="cumulative"
              name="Kumuliert"
              stroke={theme.categorical[2]}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 5, strokeWidth: 2, stroke: theme.surface }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  );
}
