import 'server-only';

import type { Prisma } from '@prisma/client';

import { prisma, toNumber } from '@/lib/db';
import { healthStatus, subScore, weightedScore, type HealthStatus } from '@/lib/bi/math';
import { formatKpiValue } from '@/lib/bi/labels';
import { addDays, today } from '@/lib/bi/periods';

/**
 * Gesundheitswert der Firma.
 *
 * Sechs benannte Komponenten, jede aus ein bis zwei Kennzahlen. Die Gewichte
 * stehen auf `KpiDefinition.healthWeight` und sind von der Administration
 * änderbar — die Zuordnung Kennzahl → Komponente steht hier im Code, weil
 * sie fachlich ist und nicht betrieblich: Marge gehört zum Ertrag, egal
 * welche Firma.
 *
 * Kennzahlen ohne Zielwert, ohne Warnschwelle oder ohne Snapshot fliessen
 * nicht ein und nehmen ihr Gewicht aus dem Nenner. Ein erfundener Zielwert
 * wäre die schlechtere Variante: er sähe aus wie eine Vorgabe.
 */

export const HEALTH_COMPONENTS: { key: string; label: string; metrics: string[] }[] = [
  { key: 'liquiditaet', label: 'Liquidität', metrics: ['invoice.dso', 'invoice.overdue'] },
  { key: 'ertrag', label: 'Ertrag', metrics: ['margin.gross', 'profit.operating'] },
  { key: 'wachstum', label: 'Wachstum', metrics: ['revenue.growthYoY', 'customer.growth'] },
  { key: 'auftragslage', label: 'Auftragslage', metrics: ['job.backlog', 'booking.cancellationRate'] },
  { key: 'kundschaft', label: 'Kundschaft', metrics: ['customer.satisfaction', 'customer.repeatRate'] },
  { key: 'betrieb', label: 'Betrieb', metrics: ['employee.utilization', 'quote.conversion'] },
];

export interface HealthMetric {
  key: string;
  label: string;
  value: number | null;
  warn: number | null;
  target: number | null;
  unit: string;
  weight: number;
  subScore: number | null;
  periodLabel: string | null;
  /** Warum die Kennzahl nicht einfliesst — leer, wenn sie es tut. */
  excluded: string | null;
}

export interface HealthComponent {
  key: string;
  label: string;
  subScore: number | null;
  weight: number;
  /** Beitrag zum Gesamtwert in Punkten. */
  contribution: number;
  /** Was diese Komponente kostet: Gewicht − Beitrag. */
  shortfall: number;
  metrics: HealthMetric[];
}

export interface HealthResult {
  score: number | null;
  status: HealthStatus | null;
  components: HealthComponent[];
  topRisk: string | null;
  /** Kennzahlen, die ein Ziel bräuchten, um zu zählen. */
  missingTargets: string[];
}

export async function computeHealth(organizationId: string): Promise<HealthResult> {
  const definitions = await prisma.kpiDefinition.findMany({
    where: { organizationId, active: true, key: { in: HEALTH_COMPONENTS.flatMap((c) => c.metrics) } },
    include: {
      // Der jüngste Monatswert. Quartals- und Jahreswerte wären träger; der
      // Gesundheitswert soll Änderungen innerhalb eines Quartals zeigen.
      snapshots: { where: { period: 'MONTH' }, orderBy: { periodStart: 'desc' }, take: 1 },
    },
  });
  const byKey = new Map(definitions.map((d) => [d.key, d]));
  const missingTargets: string[] = [];

  const components: HealthComponent[] = HEALTH_COMPONENTS.map((component) => {
    const metrics: HealthMetric[] = component.metrics.map((key) => {
      const d = byKey.get(key);
      if (!d) {
        return { key, label: key, value: null, warn: null, target: null, unit: 'COUNT', weight: 0, subScore: null, periodLabel: null, excluded: 'Kennzahl nicht angelegt' };
      }
      const snap = d.snapshots[0];
      const warn = d.warnValue === null ? null : toNumber(d.warnValue);
      const target = d.targetValue === null ? null : toNumber(d.targetValue);
      const value = snap ? toNumber(snap.value) : null;
      let excluded: string | null = null;
      if (d.healthWeight === 0) excluded = 'Gewicht 0';
      else if (warn === null || target === null) {
        excluded = 'Ziel oder Warnschwelle fehlt';
        missingTargets.push(d.label);
      } else if (value === null) excluded = 'Noch kein Wert';
      const score = excluded === null && value !== null && warn !== null && target !== null ? subScore(value, warn, target) : null;
      return {
        key,
        label: d.label,
        value,
        warn,
        target,
        unit: d.unit,
        weight: d.healthWeight,
        subScore: score,
        periodLabel: snap ? snap.periodStart.toISOString().slice(0, 7) : null,
        excluded,
      };
    });

    const counted = metrics.filter((m) => m.subScore !== null);
    const weight = counted.reduce((sum, m) => sum + m.weight, 0);
    const score = weightedScore(counted.map((m) => ({ subScore: m.subScore!, weight: m.weight })));
    const contribution = score === null ? 0 : (score * weight) / 100;
    return {
      key: component.key,
      label: component.label,
      subScore: score,
      weight,
      contribution: Math.round(contribution * 10) / 10,
      shortfall: Math.round((weight - contribution) * 10) / 10,
      metrics,
    };
  });

  const counted = components.filter((c) => c.subScore !== null);
  const score = weightedScore(counted.map((c) => ({ subScore: c.subScore!, weight: c.weight })));

  // Die Komponente mit dem grössten Abstand zwischen Gewicht und Beitrag,
  // formuliert mit der Kennzahl, die sie drückt. Ein Cockpit, das „73 von
  // 100" sagt, hilft niemandem; eines, das sagt, welche Zahl die fehlenden
  // Punkte verursacht, löst eine Handlung aus.
  const worst = [...counted].sort((a, b) => b.shortfall - a.shortfall)[0];
  let topRisk: string | null = null;
  if (worst && worst.shortfall > 0) {
    const culprit = [...worst.metrics].filter((m) => m.subScore !== null).sort((a, b) => a.subScore! - b.subScore!)[0];
    topRisk = culprit
      ? `${worst.label} — ${culprit.label} bei ${formatKpiValue(culprit.value, culprit.unit)} (Ziel ${formatKpiValue(culprit.target, culprit.unit)})`
      : worst.label;
  }

  return {
    score,
    status: score === null ? null : healthStatus(score),
    components,
    topRisk,
    missingTargets: [...new Set(missingTargets)],
  };
}

/** Den heutigen Wert festschreiben — einmal je Tag, mit Herleitung. */
export async function snapshotHealth(organizationId: string): Promise<HealthResult & { scoreDelta: number | null }> {
  const result = await computeHealth(organizationId);
  if (result.score === null) return { ...result, scoreDelta: null };

  const takenOn = today();
  const monthAgo = await prisma.healthSnapshot.findFirst({
    where: { organizationId, takenOn: { lte: addDays(takenOn, -28) } },
    orderBy: { takenOn: 'desc' },
    select: { score: true },
  });
  const scoreDelta = monthAgo ? result.score - monthAgo.score : null;

  await prisma.healthSnapshot.upsert({
    where: { organizationId_takenOn: { organizationId, takenOn } },
    create: {
      organizationId,
      takenOn,
      score: result.score,
      scoreDelta,
      components: result.components as unknown as Prisma.InputJsonValue,
      topRisk: result.topRisk,
    },
    update: {
      score: result.score,
      scoreDelta,
      components: result.components as unknown as Prisma.InputJsonValue,
      topRisk: result.topRisk,
    },
  });
  return { ...result, scoreDelta };
}

export async function getHealthHistory(organizationId: string, days = 180) {
  const rows = await prisma.healthSnapshot.findMany({
    where: { organizationId, takenOn: { gte: addDays(today(), -days) } },
    orderBy: { takenOn: 'asc' },
    select: { takenOn: true, score: true, scoreDelta: true, topRisk: true },
  });
  return rows.map((r) => ({
    takenOn: r.takenOn.toISOString().slice(0, 10),
    score: r.score,
    scoreDelta: r.scoreDelta,
    topRisk: r.topRisk,
    status: healthStatus(r.score),
  }));
}
