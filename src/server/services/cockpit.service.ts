import 'server-only';

import { prisma } from '@/lib/db';
import { can } from '@/lib/auth/rbac';
import type { SessionUser } from '@/lib/auth/session';
import { healthStatus } from '@/lib/bi/math';
import { addDays, today, type PeriodName } from '@/lib/bi/periods';
import { computeHealth, getHealthHistory, type HealthResult } from './health.service';
import { countDueReviews, getInsights, type DueReviewCounts, type Insight } from './insight.service';
import { getKpiOverview, type KpiOverviewRow } from './kpi.service';
import { getObjectiveSummary } from './objective.service';
import { getQualitySummary, getRiskMatrix } from './governance.service';

/**
 * Das Führungscockpit — eine Seite, alle Bereiche.
 *
 * Die Kennzahlgruppen sind Anzeigegruppen, keine Rechtegrenzen; die
 * Rechtegrenze ist genau eine: ohne `cockpit:financials` fehlen die Gruppen
 * „Finanzen" und Marge/Liquidität im Gesundheitswert. Die Betriebsleitung
 * sieht Auslastung und Auftragslage, die Marge bleibt der Geschäftsleitung —
 * dieselbe Linie wie bei `dashboard:financials`.
 */

const FINANCIAL_GROUPS = new Set(['Finanzen']);
const FINANCIAL_COMPONENTS = new Set(['liquiditaet', 'ertrag']);

export interface Cockpit {
  period: PeriodName;
  financials: boolean;
  health: HealthResult & { history: Awaited<ReturnType<typeof getHealthHistory>> };
  groups: { name: string; rows: KpiOverviewRow[] }[];
  insights: Insight[];
  objectives: Awaited<ReturnType<typeof getObjectiveSummary>>;
  risks: Awaited<ReturnType<typeof getRiskMatrix>>;
  quality: Awaited<ReturnType<typeof getQualitySummary>>;
  due: DueReviewCounts;
  upcomingMeetings: { id: string; title: string; heldAt: Date }[];
  expiringDocuments: { id: string; title: string; expiresOn: Date | null }[];
  missingTargets: string[];
}

export async function getCockpit(session: SessionUser, organizationId: string, period: PeriodName = 'MONTH'): Promise<Cockpit> {
  const financials = can(session.role, 'cockpit:financials');
  const [health, history, overview, insights, objectives, risks, quality, due, upcomingMeetings, expiringDocuments] = await Promise.all([
    computeHealth(organizationId),
    getHealthHistory(organizationId, 180),
    getKpiOverview(organizationId, period, { active: true }),
    getInsights(organizationId),
    getObjectiveSummary(organizationId),
    getRiskMatrix(organizationId),
    getQualitySummary(organizationId),
    countDueReviews(organizationId),
    prisma.meeting.findMany({
      where: { organizationId, deletedAt: null, heldAt: { gte: new Date() } },
      orderBy: { heldAt: 'asc' },
      take: 3,
      select: { id: true, title: true, heldAt: true },
    }),
    prisma.managedDocument.findMany({
      where: { organizationId, deletedAt: null, expiresOn: { gte: today(), lte: addDays(today(), 30) } },
      orderBy: { expiresOn: 'asc' },
      take: 5,
      select: { id: true, title: true, expiresOn: true },
    }),
  ]);

  const visibleRows = overview.filter((row) => financials || !FINANCIAL_GROUPS.has(row.group));
  const groups = [...new Set(visibleRows.map((r) => r.group))].map((name) => ({ name, rows: visibleRows.filter((r) => r.group === name) }));

  // Ohne Finanzrecht bleiben die Finanzkomponenten unsichtbar — der
  // Gesamtwert bleibt derselbe (er ist keine Finanzzahl), die Herleitung
  // zeigt nur, was die Person sehen darf.
  const components = financials ? health.components : health.components.filter((c) => !FINANCIAL_COMPONENTS.has(c.key));
  const visibleInsights = financials ? insights : insights.filter((i) => !['liquidity-overdue', 'concentration', 'trend-margin.gross'].includes(i.key));

  return {
    period,
    financials,
    health: { ...health, components, status: health.score === null ? null : healthStatus(health.score), history },
    groups,
    insights: visibleInsights,
    objectives,
    risks,
    quality,
    due,
    upcomingMeetings,
    expiringDocuments,
    missingTargets: health.missingTargets,
  };
}
