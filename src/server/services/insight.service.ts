import 'server-only';

import { prisma, toNumber } from '@/lib/db';
import { formatKpiValue } from '@/lib/bi/labels';
import { periodFromKey, today } from '@/lib/bi/periods';
import { getTopCustomers } from './analytics.service';

/**
 * Auffälligkeiten aus den Snapshots — regelbasiert, kein Sprachmodell.
 *
 * Eine Regel ist erklärbar und wird nicht erfinderisch. Jede Meldung trägt
 * einen Verweis auf die Seite, wo man etwas tun kann: ein Hinweis ohne
 * Handlungsmöglichkeit ist eine Beschwerde.
 */

export type InsightSeverity = 'info' | 'warning' | 'critical';

export interface Insight {
  key: string;
  severity: InsightSeverity;
  title: string;
  detail: string;
  href: string;
  /** Woher die Zahl stammt — damit der Hinweis nachprüfbar bleibt. */
  source: string;
}

interface SeriesRow {
  key: string;
  label: string;
  unit: string;
  direction: string;
  values: { periodStart: Date; value: number; targetValue: number | null; previousYearValue: number | null; provisional: boolean }[];
}

async function loadMonthlySeries(organizationId: string, keys: string[]): Promise<Map<string, SeriesRow>> {
  const defs = await prisma.kpiDefinition.findMany({
    where: { organizationId, key: { in: keys } },
    include: { snapshots: { where: { period: 'MONTH' }, orderBy: { periodStart: 'desc' }, take: 6 } },
  });
  return new Map(
    defs.map((d) => [
      d.key,
      {
        key: d.key,
        label: d.label,
        unit: d.unit,
        direction: d.direction,
        values: d.snapshots
          .map((s) => ({
            periodStart: s.periodStart,
            value: toNumber(s.value),
            targetValue: s.targetValue === null ? null : toNumber(s.targetValue),
            previousYearValue: s.previousYearValue === null ? null : toNumber(s.previousYearValue),
            provisional: s.provisional,
          }))
          .reverse(),
      },
    ]),
  );
}

export async function getInsights(organizationId: string): Promise<Insight[]> {
  const insights: Insight[] = [];
  const series = await loadMonthlySeries(organizationId, [
    'revenue.net',
    'invoice.overdue',
    'employee.utilization',
    'job.backlog',
    'booking.cancellationRate',
    'margin.gross',
    'quote.conversion',
  ]);

  // --- Trendbruch: drei Perioden gleiche Richtung, dann Umkehr > 15 % ------
  for (const key of ['revenue.net', 'margin.gross', 'quote.conversion']) {
    const row = series.get(key);
    const v = row?.values.filter((x) => !x.provisional) ?? [];
    if (!row || v.length < 4) continue;
    const last4 = v.slice(-4).map((x) => x.value);
    const [a, b, c, d] = last4;
    const rising = a < b && b < c;
    const falling = a > b && b > c;
    if (rising && c > 0 && (c - d) / c > 0.15) {
      insights.push({
        key: `trend-${key}`,
        severity: 'warning',
        title: `${row.label} bricht nach drei Wachstumsmonaten ein`,
        detail: `Von ${formatKpiValue(c, row.unit)} auf ${formatKpiValue(d, row.unit)} — ein Rückgang um ${Math.round(((c - d) / c) * 100)} %.`,
        href: `/admin/fuehrung/kennzahlen`,
        source: 'Monatssnapshots der letzten vier Monate',
      });
    } else if (falling && d > c && c > 0 && (d - c) / c > 0.15) {
      insights.push({
        key: `trend-${key}`,
        severity: 'info',
        title: `${row.label} dreht nach drei rückläufigen Monaten nach oben`,
        detail: `Von ${formatKpiValue(c, row.unit)} auf ${formatKpiValue(d, row.unit)}.`,
        href: `/admin/fuehrung/kennzahlen`,
        source: 'Monatssnapshots der letzten vier Monate',
      });
    }
  }

  // --- Zielverfehlung: laufende Periode < 80 % des Ziels bei ≥ 50 % Zeit ----
  const now = today();
  for (const row of series.values()) {
    const current = row.values[row.values.length - 1];
    if (!current || !current.provisional || current.targetValue === null || current.targetValue <= 0) continue;
    if (row.direction !== 'UP_IS_GOOD') continue;
    const bounds = periodFromKey('MONTH', current.periodStart);
    const elapsed = (now.getTime() - bounds.periodStart.getTime()) / (bounds.periodEnd.getTime() - bounds.periodStart.getTime());
    if (elapsed < 0.5) continue;
    const share = current.value / current.targetValue;
    if (share < 0.8 * elapsed) {
      insights.push({
        key: `target-${row.key}`,
        severity: 'warning',
        title: `${row.label} liegt bei ${Math.round(share * 100)} % des Monatsziels`,
        detail: `${Math.round(elapsed * 100)} % der Zeit sind um — Ziel ${formatKpiValue(current.targetValue, row.unit)}, Stand ${formatKpiValue(current.value, row.unit)}.`,
        href: `/admin/fuehrung/kennzahlen`,
        source: `Vorläufiger Snapshot ${bounds.label}`,
      });
    }
  }

  // --- Saisonalität: Monat weicht > 25 % vom Vorjahresmonat ab -------------
  const revenue = series.get('revenue.net');
  const lastFinal = revenue?.values.filter((x) => !x.provisional).at(-1);
  if (revenue && lastFinal && lastFinal.previousYearValue && lastFinal.previousYearValue > 0) {
    const diff = (lastFinal.value - lastFinal.previousYearValue) / lastFinal.previousYearValue;
    if (Math.abs(diff) > 0.25) {
      const label = periodFromKey('MONTH', lastFinal.periodStart).label;
      insights.push({
        key: 'season-revenue',
        severity: diff < 0 ? 'warning' : 'info',
        title: `${label} liegt ${Math.round(Math.abs(diff) * 100)} % ${diff < 0 ? 'unter' : 'über'} dem Vorjahresmonat`,
        detail: `${formatKpiValue(lastFinal.value, 'CURRENCY')} gegenüber ${formatKpiValue(lastFinal.previousYearValue, 'CURRENCY')} im Vorjahr.`,
        href: '/admin/fuehrung/kennzahlen',
        source: 'Monatssnapshot mit Vorjahreswert',
      });
    }
  }

  // --- Liquiditätswarnung: Überfälliges > 25 % eines Monatsumsatzes --------
  const overdue = series.get('invoice.overdue')?.values.at(-1);
  const monthRevenue = lastFinal?.value ?? revenue?.values.at(-1)?.value ?? 0;
  if (overdue && monthRevenue > 0 && overdue.value / monthRevenue > 0.25) {
    insights.push({
      key: 'liquidity-overdue',
      severity: overdue.value / monthRevenue > 0.5 ? 'critical' : 'warning',
      title: `${formatKpiValue(overdue.value, 'CURRENCY')} überfällig`,
      detail: `Das sind ${Math.round((overdue.value / monthRevenue) * 100)} % eines Monatsumsatzes. Mahnlauf prüfen.`,
      href: '/admin/rechnungen?status=OVERDUE',
      source: 'Offene Rechnungen mit Status „überfällig"',
    });
  }

  // --- Klumpenrisiko: grösste Kundschaft > 20 % des Umsatzes ---------------
  const top = await getTopCustomers({ organizationId, limit: 3 });
  const totalLtv = await prisma.customer.aggregate({ where: { organizationId, deletedAt: null }, _sum: { lifetimeValue: true } });
  const total = toNumber(totalLtv._sum.lifetimeValue);
  const biggest = top[0];
  if (biggest && total > 0 && toNumber(biggest.lifetimeValue) / total > 0.2) {
    const share = Math.round((toNumber(biggest.lifetimeValue) / total) * 100);
    insights.push({
      key: 'concentration',
      severity: share > 35 ? 'critical' : 'warning',
      title: `Eine Kundschaft macht ${share} % des Umsatzes aus`,
      detail: `${biggest.companyName ?? `${biggest.firstName} ${biggest.lastName}`} — fällt sie weg, fehlt ein Fünftel oder mehr. Zweites Standbein im Vertrieb prüfen.`,
      href: `/admin/kunden/${biggest.id}`,
      source: 'Kundenwert über die gesamte Laufzeit',
    });
  }

  // --- Auslastungslücke: < 65 % bei gleichzeitigem Rückstand ---------------
  const utilization = series.get('employee.utilization')?.values.at(-1);
  const backlog = series.get('job.backlog')?.values.at(-1);
  if (utilization && backlog && utilization.value < 65 && backlog.value > 0) {
    const unassigned = await prisma.job.count({
      where: { organizationId, deletedAt: null, status: 'UNASSIGNED', scheduledStart: { gte: new Date() } },
    });
    if (unassigned > 0) {
      insights.push({
        key: 'utilization-gap',
        severity: 'warning',
        title: `Auslastung ${Math.round(utilization.value)} %, gleichzeitig ${unassigned} nicht zugeteilte Einsätze`,
        detail: 'Kapazität ist da, aber nicht verplant. Einsatzkalender prüfen.',
        href: '/admin/einsaetze?status=UNASSIGNED',
        source: 'Auslastung aus genehmigten Zeiteinträgen; Einsätze ohne Zuteilung',
      });
    }
  }

  // --- Fällige Prüfungen ----------------------------------------------------
  const due = await countDueReviews(organizationId);
  if (due.total > 0) {
    insights.push({
      key: 'reviews-due',
      severity: due.total > 5 ? 'warning' : 'info',
      title: `${due.total} ${due.total === 1 ? 'Eintrag wartet' : 'Einträge warten'} auf Prüfung`,
      detail: [
        due.objectives ? `${due.objectives} Ziele` : null,
        due.risks ? `${due.risks} Risiken` : null,
        due.controls ? `${due.controls} Kontrollen` : null,
        due.market ? `${due.market} Marktbeobachtungen` : null,
        due.documents ? `${due.documents} ablaufende Dokumente` : null,
      ]
        .filter(Boolean)
        .join(', '),
      href: due.risks ? '/admin/fuehrung/risiken?faellig=1' : '/admin/fuehrung/ziele',
      source: 'Prüfzyklen der Einträge',
    });
  }

  const order: Record<InsightSeverity, number> = { critical: 0, warning: 1, info: 2 };
  return insights.sort((a, b) => order[a.severity] - order[b.severity]);
}

export interface DueReviewCounts {
  objectives: number;
  risks: number;
  controls: number;
  market: number;
  documents: number;
  total: number;
}

/** Fällige Prüfungen über alle Bereiche — für Navigation, Cockpit und Nachtlauf. */
export async function countDueReviews(organizationId: string): Promise<DueReviewCounts> {
  const now = today();
  const soon = new Date(now.getTime() + 30 * 86_400_000);
  const [objectives, risks, controls, competitors, insights, boards, documents] = await Promise.all([
    prisma.objective.count({ where: { organizationId, deletedAt: null, status: { in: ['ACTIVE', 'AT_RISK'] }, nextReviewAt: { lt: now } } }),
    prisma.riskEntry.count({ where: { organizationId, deletedAt: null, status: { not: 'CLOSED' }, nextReviewAt: { lt: now } } }),
    prisma.controlEntry.count({ where: { organizationId, deletedAt: null, status: { in: ['ACTIVE', 'DUE', 'NON_COMPLIANT'] }, nextReviewAt: { lt: now } } }),
    prisma.competitor.count({ where: { organizationId, deletedAt: null, nextReviewAt: { lt: now } } }),
    prisma.marketInsight.count({ where: { organizationId, deletedAt: null, nextReviewAt: { lt: now } } }),
    prisma.analysisBoard.count({ where: { organizationId, supersededById: null, nextReviewAt: { lt: now } } }),
    prisma.managedDocument.count({ where: { organizationId, deletedAt: null, expiresOn: { gte: now, lte: soon } } }),
  ]);
  const market = competitors + insights + boards;
  return { objectives, risks, controls, market, documents, total: objectives + risks + controls + market };
}
