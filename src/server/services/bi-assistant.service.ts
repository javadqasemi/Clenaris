import 'server-only';

import { prisma, toNumber } from '@/lib/db';
import { audit } from '@/lib/audit';
import type { SessionUser } from '@/lib/auth/session';
import { ConfigurationError, NotFoundError } from '@/lib/errors';
import { hasIntegration } from '@/lib/env';
import { formatKpiValue } from '@/lib/bi/labels';
import { periodFromKey, periodOf, zurichMidnight } from '@/lib/bi/periods';
import type { BiAssistantInput } from '@/lib/validation/bi-ai';
import {
  draftAnalysisBoard,
  draftFeedbackAnalysis,
  draftMarketingIdeas,
  draftMeetingMinutes,
  draftPeriodSummary,
  draftQuarterlyReview,
  draftRiskSuggestions,
  draftVarianceExplanation,
} from '@/lib/ai/features-bi';
import { namenErsetzen } from '@/lib/ai/governance';
import { computeHealth } from './health.service';
import { getInsights } from './insight.service';
import { getBudgetVariance } from './budget.service';

/**
 * Der Führungsassistent — Datensammlung für die KI-Entwürfe.
 *
 * Dieser Dienst entscheidet, *was* das Modell sieht. Die Regel: aggregierte
 * Zahlen und Titel; Löhne und Adressen gehen nie hinaus.
 *
 * **Freitext ist nicht anonym, und hier stand bis 2026-09-27, er sei es.**
 * Bewertungstexte, Check-in-Kommentare und Sitzungsnotizen gingen roh hinaus,
 * während dieser Kopf und die Seite „anonymisiert" und „keine Personendaten"
 * versprachen — „Frau Keller war super" erreichte das Modell mit Namen. Jetzt
 * ersetzt `namenErsetzen` jeden Namen, den die Datenbank kennt (Konten,
 * Kundschaft, Verfasser der Bewertung), durch `[NAME]`, bevor der Text das
 * Haus verlässt; der Ausgangsfilter des Clients nimmt E-Mail, Telefon, IBAN
 * und AHV-Nummer. Ein Name, den niemand erfasst hat, bleibt stehen — die
 * Übermittlung ist sparsam, nicht anonym, und so steht es jetzt auch in der
 * Oberfläche.
 */

/**
 * Die Namen, die diese Organisation kennt: Konten (Personal, Büro,
 * Kundschaft mit Konto) und Kundschaft samt Firmennamen. Für ein Assistenz-
 * Werkzeug, das auf Knopfdruck läuft, ist die Menge klein genug, um sie je
 * Aufruf frisch zu lesen — ein Zwischenspeicher wäre eine Liste, die einen
 * neuen Namen erst später kennt.
 */
async function bekannteNamen(organizationId: string): Promise<string[]> {
  const [konten, kundschaft] = await Promise.all([
    prisma.user.findMany({ where: { organizationId }, select: { firstName: true, lastName: true } }),
    prisma.customer.findMany({ where: { organizationId }, select: { firstName: true, lastName: true, companyName: true } }),
  ]);
  return [
    ...konten.flatMap((k) => [k.firstName, k.lastName]),
    ...kundschaft.flatMap((k) => [k.firstName, k.lastName, k.companyName ?? '']),
  ];
}

function assertAi() {
  if (!hasIntegration('ai')) {
    throw new ConfigurationError('Anthropic', 'Der Führungsassistent braucht ANTHROPIC_API_KEY. Alle übrigen Funktionen laufen unabhängig davon.');
  }
}

async function kpiDigest(organizationId: string, from?: Date, to?: Date, groups?: string[]): Promise<string> {
  const definitions = await prisma.kpiDefinition.findMany({
    where: { organizationId, active: true, ...(groups ? { group: { in: groups } } : {}) },
    orderBy: [{ group: 'asc' }, { sortOrder: 'asc' }],
    include: {
      snapshots: {
        where: { period: 'MONTH', ...(from ? { periodStart: { gte: from } } : {}), ...(to ? { periodStart: { lte: to } } : {}) },
        orderBy: { periodStart: 'desc' },
        take: 12,
      },
    },
  });
  return definitions
    .filter((d) => d.snapshots.length > 0)
    .map((d) => {
      const series = [...d.snapshots]
        .reverse()
        .map((s) => `${s.periodStart.toISOString().slice(0, 7)}: ${formatKpiValue(toNumber(s.value), d.unit)}${s.provisional ? ' (vorläufig)' : ''}`)
        .join('; ');
      const target = d.targetValue === null ? '' : ` Ziel ${formatKpiValue(toNumber(d.targetValue), d.unit)}.`;
      return `[${d.group}] ${d.label} (${d.key}, ${d.direction === 'UP_IS_GOOD' ? 'mehr ist besser' : 'weniger ist besser'}).${target} Verlauf: ${series}`;
    })
    .join('\n');
}

async function healthDigest(organizationId: string): Promise<string> {
  const h = await computeHealth(organizationId);
  if (h.score === null) return 'Gesundheitswert: noch nicht berechenbar (Zielwerte fehlen).';
  return `Gesundheitswert ${h.score}/100 (${h.status}). ${h.topRisk ? `Grösster Hebel: ${h.topRisk}. ` : ''}Komponenten: ${h.components.map((c) => `${c.label} ${c.subScore ?? '—'}`).join(', ')}.`;
}

async function insightDigest(organizationId: string): Promise<string> {
  const insights = await getInsights(organizationId);
  return insights.length ? insights.map((i) => `- [${i.severity}] ${i.title}. ${i.detail}`).join('\n') : '- keine Auffälligkeiten aus den Regeln';
}

async function objectivesDigest(organizationId: string, namen: string[], fiscalYear?: number, quarter?: number): Promise<string> {
  const objectives = await prisma.objective.findMany({
    where: {
      organizationId,
      deletedAt: null,
      status: { not: 'CANCELLED' },
      ...(fiscalYear ? { OR: [{ fiscalYear, ...(quarter ? { quarter } : {}) }, { horizon: 'STRATEGY' }] } : {}),
    },
    include: { keyResults: { include: { checkins: { orderBy: { recordedAt: 'desc' }, take: 3 } } } },
    orderBy: { progressPct: 'asc' },
    take: 30,
  });
  return objectives
    .map((o) => {
      const krs = o.keyResults
        // Der Check-in-Kommentar ist Freitext von Mitarbeitenden — Namen darin
        // werden ersetzt, bevor er hinausgeht.
        .map((kr) => `  · ${kr.title}: ${toNumber(kr.startValue)} → ${toNumber(kr.currentValue)} (Ziel ${toNumber(kr.targetValue)}), ${kr.progressPct} %${kr.checkins[0]?.comment ? ` — „${namenErsetzen(kr.checkins[0].comment, namen).text}"` : ''}`)
        .join('\n');
      return `- ${o.horizon} ${o.level}: ${o.title} [${o.status}, ${o.progressPct} %]${o.department ? ` Bereich ${o.department}` : ''}\n${krs}`;
    })
    .join('\n');
}

async function riskDigest(organizationId: string): Promise<string> {
  const risks = await prisma.riskEntry.findMany({
    where: { organizationId, deletedAt: null, status: { not: 'CLOSED' } },
    orderBy: { severity: 'desc' },
    select: { title: true, category: true, probability: true, impact: true, severity: true, status: true },
    take: 40,
  });
  return risks.length ? risks.map((r) => `- ${r.title} [${r.category}, W${r.probability}×A${r.impact}=${r.severity}, ${r.status}]`).join('\n') : '- Register leer';
}

async function marketDigest(organizationId: string): Promise<string> {
  const [competitors, insights] = await Promise.all([
    prisma.competitor.findMany({ where: { organizationId, deletedAt: null }, take: 20 }),
    prisma.marketInsight.findMany({ where: { organizationId, deletedAt: null }, orderBy: { observedOn: 'desc' }, take: 20 }),
  ]);
  const c = competitors.map((x) => `- ${x.name}${x.region ? ` (${x.region})` : ''}: Leistungen ${x.services.join(', ') || '—'}; Preise ${x.priceFrom ? toNumber(x.priceFrom) : '?'}–${x.priceTo ? toNumber(x.priceTo) : '?'} CHF; Stärken: ${x.strengths ?? '—'}; Schwächen: ${x.weaknesses ?? '—'}; Position: ${x.marketPosition ?? '—'}`).join('\n');
  const i = insights.map((x) => `- [${x.kind}, ${x.observedOn.toISOString().slice(0, 10)}] ${x.title}: ${x.body.slice(0, 400)}${x.impactNote ? ` Auswirkung: ${x.impactNote}` : ''}`).join('\n');
  return `Wettbewerber:\n${c || '- keine erfasst'}\n\nMarktbeobachtungen:\n${i || '- keine erfasst'}`;
}

export async function runAssistant(session: SessionUser, organizationId: string, input: BiAssistantInput) {
  assertAi();
  let result: unknown;

  switch (input.kind) {
    case 'summarizePeriod': {
      const data = [`Zeitraum ${input.from.toISOString().slice(0, 10)} bis ${input.to.toISOString().slice(0, 10)}`, await healthDigest(organizationId), 'Kennzahlen:', await kpiDigest(organizationId, input.from, input.to), 'Auffälligkeiten (regelbasiert):', await insightDigest(organizationId)].join('\n\n');
      result = await draftPeriodSummary({ data, question: input.question });
      break;
    }
    case 'draftSwot': {
      const data = [await healthDigest(organizationId), 'Kennzahlen:', await kpiDigest(organizationId), await marketDigest(organizationId), 'Offene Risiken:', await riskDigest(organizationId)].join('\n\n');
      result = await draftAnalysisBoard({ kind: 'SWOT', data });
      break;
    }
    case 'draftPestel': {
      result = await draftAnalysisBoard({ kind: 'PESTEL', data: await marketDigest(organizationId) });
      break;
    }
    case 'suggestRisks': {
      const openActions = await prisma.correctiveAction.count({ where: { organizationId, completedAt: null } });
      const data = [await healthDigest(organizationId), 'Kennzahlen:', await kpiDigest(organizationId), 'Bereits erfasste Risiken (nicht wiederholen):', await riskDigest(organizationId), `Offene Massnahmen: ${openActions}`, await marketDigest(organizationId)].join('\n\n');
      result = await draftRiskSuggestions({ data });
      break;
    }
    case 'explainVariance': {
      const variance = await getBudgetVariance(organizationId, input.budgetId);
      const data = [
        `Budget ${variance.period.name} ${variance.period.fiscalYear}, ${variance.elapsedMonths} von ${variance.totalMonths} Monaten verstrichen.`,
        ...variance.lines.map((l) => `- ${l.label} [${l.category}]: Plan ${l.plan}, anteilig ${l.planToDate}, Ist ${l.actual}, Abweichung ${l.variance} (${l.variancePct ?? '—'} %), Hochrechnung ${l.forecast ?? '—'}`),
        `Total: anteilig ${variance.totals.planToDate}, Ist ${variance.totals.actual}, Abweichung ${variance.totals.variance}`,
        variance.unbudgeted.length ? `Ohne Budgetzeile: ${variance.unbudgeted.map((u) => `${u.category} ${u.actual}`).join(', ')}` : '',
        'Kennzahlen Finanzen:',
        await kpiDigest(organizationId, undefined, undefined, ['Finanzen']),
      ].join('\n');
      result = await draftVarianceExplanation({ data });
      break;
    }
    case 'meetingMinutes': {
      // Sitzungsnotizen nennen Personen beim Namen („Anna übernimmt …"). Das
      // Protokoll braucht die Rollen der Pendenzen, nicht die Namen.
      const namen = await bekannteNamen(organizationId);
      result = await draftMeetingMinutes({
        notes: namenErsetzen(input.notes, namen).text,
        title: input.title === undefined ? undefined : namenErsetzen(input.title, namen).text,
      });
      break;
    }
    case 'quarterlyReview': {
      const q = periodOf('QUARTER', zurichMidnight(input.fiscalYear, (input.quarter - 1) * 3, 1));
      const data = [`Quartal ${q.label}`, await healthDigest(organizationId), 'Ziele und Schlüsselergebnisse:', await objectivesDigest(organizationId, await bekannteNamen(organizationId), input.fiscalYear, input.quarter), 'Kennzahlen im Quartal:', await kpiDigest(organizationId, q.periodStart, q.periodEnd), 'Offene Risiken:', await riskDigest(organizationId)].join('\n\n');
      result = await draftQuarterlyReview({ data });
      break;
    }
    case 'analyzeFeedback': {
      const reviews = await prisma.review.findMany({
        where: { organizationId, createdAt: { gte: input.from, lte: input.to } },
        select: { rating: true, title: true, body: true, serviceKind: true, createdAt: true, authorName: true },
        orderBy: { createdAt: 'desc' },
        take: 200,
      });
      if (reviews.length === 0) throw new NotFoundError('Bewertungen im Zeitraum');
      // Ohne Verfasser und Kundschaft als Feld — und im Text selbst ersetzt,
      // was die Datenbank als Namen kennt, samt dem Verfasser dieser Bewertung
      // (der nicht immer ein Konto oder eine Kundenakte hat).
      const namen = await bekannteNamen(organizationId);
      const data = reviews
        .map((r, i) => {
          const eigene = [...namen, r.authorName, ...r.authorName.split(/\s+/)];
          const text = namenErsetzen(`${r.title ? `${r.title} — ` : ''}${r.body.slice(0, 600)}`, eigene).text;
          return `#${i + 1} ${r.createdAt.toISOString().slice(0, 10)} ${r.rating}/5${r.serviceKind ? ` ${r.serviceKind}` : ''}: ${text}`;
        })
        .join('\n');
      result = await draftFeedbackAnalysis({ data });
      break;
    }
    case 'marketingIdeas': {
      const leads = await prisma.lead.groupBy({ by: ['source', 'status'], where: { organizationId, deletedAt: null }, _count: { _all: true } });
      const bySource = leads.map((l) => `- ${l.source}/${l.status}: ${l._count._all}`).join('\n');
      const data = ['Leads nach Quelle und Status:', bySource, 'Kennzahlen Vertrieb und Marketing:', await kpiDigest(organizationId, undefined, undefined, ['Vertrieb', 'Marketing', 'Kundschaft']), await marketDigest(organizationId)].join('\n\n');
      result = await draftMarketingIdeas({ data });
      break;
    }
  }

  const bounds = periodFromKey('MONTH', new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)));
  await audit.created({ organizationId, userId: session.id, entity: 'AssistantDraft', summary: `Führungsassistent: ${input.kind} (${bounds.label})` });
  return { kind: input.kind, generatedAt: new Date().toISOString(), ...(result as object) };
}
