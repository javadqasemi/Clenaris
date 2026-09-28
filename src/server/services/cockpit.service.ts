import 'server-only';

import { prisma } from '@/lib/db';
import { can } from '@/lib/auth/rbac';
import type { SessionUser } from '@/lib/auth/session';
import { healthStatus } from '@/lib/bi/math';
import { addDays, today, type PeriodName } from '@/lib/bi/periods';
import { computeHealth, getHealthHistory, type HealthResult } from './health.service';
import { countDueReviews, getInsights, insightScopeFor, type DueReviewCounts, type Insight, type InsightScope } from './insight.service';
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
  /** `null`, wenn die Rolle das Risikoregister nicht lesen darf (`risk:read`). */
  risks: Awaited<ReturnType<typeof getRiskMatrix>> | null;
  quality: Awaited<ReturnType<typeof getQualitySummary>>;
  due: DueReviewCounts;
  /** Welche Register hinter dem Cockpit die Rolle öffnen darf — die Seite lässt die übrigen weg. */
  scope: InsightScope;
  upcomingMeetings: { id: string; title: string; heldAt: Date }[];
  /** Leer ohne `document:read` — die Ablage ist Geschäftsleitungssache. */
  expiringDocuments: { id: string; title: string; expiresOn: Date | null }[];
  missingTargets: string[];
}

/**
 * Das Cockpit für eine Person.
 *
 * Neben der Finanzgrenze gibt es seit 2026-09-28 eine zweite: die Register
 * mit eigenem Leserecht. Die Betriebsleitung hält `cockpit:view`, aber weder
 * `risk:read` noch `market:read` noch `document:read`. Bis dahin lud der
 * Dienst Risikomatrix, fällige Marktprüfungen und ablaufende Dokumente für
 * jede Rolle, und die Seite verlinkte sie — Risikotitel und Dokumentnamen
 * standen im HTML und in `GET /api/bi/cockpit`, obwohl die Register selbst
 * der Rolle verschlossen sind. Deshalb wird hier gar nicht erst geladen, was
 * die Rolle nicht sehen darf; Ausblenden in der Seite allein hätte die
 * JSON-Antwort unverändert gelassen.
 */
export async function getCockpit(session: SessionUser, organizationId: string, period: PeriodName = 'MONTH'): Promise<Cockpit> {
  const financials = can(session.role, 'cockpit:financials');
  const scope = insightScopeFor(session.role);
  const [health, history, overview, insights, objectives, risks, quality, due, upcomingMeetings, expiringDocuments] = await Promise.all([
    computeHealth(organizationId),
    getHealthHistory(organizationId, 180),
    getKpiOverview(organizationId, period, { active: true }),
    getInsights(organizationId, scope),
    getObjectiveSummary(organizationId),
    scope.risks ? getRiskMatrix(organizationId) : Promise.resolve(null),
    getQualitySummary(organizationId),
    countDueReviews(organizationId, scope),
    prisma.meeting.findMany({
      where: { organizationId, deletedAt: null, heldAt: { gte: new Date() } },
      orderBy: { heldAt: 'asc' },
      take: 3,
      select: { id: true, title: true, heldAt: true },
    }),
    scope.documents
      ? prisma.managedDocument.findMany({
          where: { organizationId, deletedAt: null, expiresOn: { gte: today(), lte: addDays(today(), 30) } },
          orderBy: { expiresOn: 'asc' },
          take: 5,
          select: { id: true, title: true, expiresOn: true },
        })
      : Promise.resolve([] as { id: string; title: string; expiresOn: Date | null }[]),
  ]);

  const visibleRows = overview.filter((row) => financials || !FINANCIAL_GROUPS.has(row.group));
  const groups = [...new Set(visibleRows.map((r) => r.group))].map((name) => ({ name, rows: visibleRows.filter((r) => r.group === name) }));

  // Ohne Finanzrecht bleiben die Finanzkomponenten unsichtbar — der
  // Gesamtwert bleibt derselbe (er ist keine Finanzzahl), die Herleitung
  // zeigt nur, was die Person sehen darf.
  const components = financials ? health.components : health.components.filter((c) => !FINANCIAL_COMPONENTS.has(c.key));
  // Die Finanz-Auffälligkeiten filtert `getInsights` selbst (Sicht
  // `financials`), für das Cockpit und die eigene Route gleich.
  const visibleInsights = insights;

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
    scope,
    upcomingMeetings,
    expiringDocuments,
    missingTargets: health.missingTargets,
  };
}
