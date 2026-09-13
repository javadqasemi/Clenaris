import 'server-only';

import type { Prisma } from '@prisma/client';

import { prisma, toNumber } from '@/lib/db';
import { audit } from '@/lib/audit';
import type { SessionUser } from '@/lib/auth/session';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { budgetVariance, round2, type VarianceResult } from '@/lib/bi/math';
import { today, wholeMonthsBetween } from '@/lib/bi/periods';
import type {
  CreateBudgetLineInput,
  CreateBudgetPeriodInput,
  UpdateBudgetLineInput,
  UpdateBudgetPeriodInput,
} from '@/lib/validation/bi-finance';

/**
 * Budget.
 *
 * `APPROVED` friert die Planwerte ein. Ein Budget, das man nachträglich an
 * das Ist anpassen kann, misst nichts; die Abweichung ist der einzige Grund,
 * warum es existiert. Korrekturen laufen über `revisedAmount` auf der Zeile,
 * damit Plan und Nachtrag getrennt sichtbar bleiben.
 */

function spreadEvenly(amount: number): number[] {
  const base = Math.floor((amount / 12) * 100) / 100;
  const plan = Array.from({ length: 12 }, () => base);
  // Rundungsrest in den Dezember, damit die Summe exakt aufgeht.
  plan[11] = round2(amount - base * 11);
  return plan;
}

export async function listBudgets(organizationId: string, filter: { fiscalYear?: number; status?: string }) {
  const periods = await prisma.budgetPeriod.findMany({
    where: {
      organizationId,
      ...(filter.fiscalYear ? { fiscalYear: filter.fiscalYear } : {}),
      ...(filter.status ? { status: filter.status as never } : {}),
    },
    include: { lines: { select: { plannedAmount: true, revisedAmount: true } } },
    orderBy: [{ fiscalYear: 'desc' }, { name: 'asc' }],
  });
  return periods.map((p) => ({
    ...p,
    lines: undefined,
    lineCount: p.lines.length,
    plannedTotal: round2(p.lines.reduce((sum, l) => sum + toNumber(l.revisedAmount ?? l.plannedAmount), 0)),
  }));
}

export async function getBudget(organizationId: string, id: string) {
  const period = await prisma.budgetPeriod.findFirst({
    where: { id, organizationId },
    include: { lines: { orderBy: [{ sortOrder: 'asc' }, { category: 'asc' }] } },
  });
  if (!period) throw new NotFoundError('Budget');
  return period;
}

export async function createBudget(session: SessionUser, organizationId: string, input: CreateBudgetPeriodInput) {
  const period = await prisma.budgetPeriod.create({
    data: {
      organizationId,
      name: input.name,
      fiscalYear: input.fiscalYear,
      startsOn: input.startsOn,
      endsOn: input.endsOn,
      note: input.note ?? null,
    },
  });
  await audit.created({ organizationId, userId: session.id, entity: 'BudgetPeriod', entityId: period.id, summary: `Budget „${period.name}" angelegt` });
  return period;
}

async function requireEditable(organizationId: string, id: string) {
  const period = await prisma.budgetPeriod.findFirst({ where: { id, organizationId } });
  if (!period) throw new NotFoundError('Budget');
  if (period.status === 'CLOSED') throw new BusinessRuleError('Dieses Budget ist abgeschlossen und kann nicht mehr geändert werden.');
  return period;
}

export async function updateBudget(session: SessionUser, organizationId: string, id: string, input: UpdateBudgetPeriodInput) {
  const before = await requireEditable(organizationId, id);
  const period = await prisma.budgetPeriod.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.fiscalYear !== undefined ? { fiscalYear: input.fiscalYear } : {}),
      ...(input.startsOn !== undefined ? { startsOn: input.startsOn } : {}),
      ...(input.endsOn !== undefined ? { endsOn: input.endsOn } : {}),
      ...(input.note !== undefined ? { note: input.note || null } : {}),
    },
  });
  await audit.updated({ organizationId, userId: session.id, entity: 'BudgetPeriod', entityId: id, summary: `Budget „${before.name}" geändert`, changes: input });
  return period;
}

export async function deleteBudget(session: SessionUser, organizationId: string, id: string) {
  const period = await prisma.budgetPeriod.findFirst({ where: { id, organizationId } });
  if (!period) throw new NotFoundError('Budget');
  if (period.status === 'APPROVED') {
    throw new BusinessRuleError('Ein genehmigtes Budget wird nicht gelöscht — schliessen Sie es ab, damit die Abweichungen nachvollziehbar bleiben.');
  }
  await prisma.budgetPeriod.delete({ where: { id } });
  await audit.deleted({ organizationId, userId: session.id, entity: 'BudgetPeriod', entityId: id, summary: `Budget „${period.name}" gelöscht` });
}

export async function approveBudget(session: SessionUser, organizationId: string, id: string) {
  const period = await requireEditable(organizationId, id);
  if (period.status === 'APPROVED') throw new BusinessRuleError('Dieses Budget ist bereits genehmigt.');
  const lines = await prisma.budgetLine.count({ where: { periodId: id } });
  if (lines === 0) throw new BusinessRuleError('Ein Budget ohne Zeilen lässt sich nicht genehmigen.');
  const updated = await prisma.budgetPeriod.update({
    where: { id },
    data: { status: 'APPROVED', approvedAt: new Date(), approvedById: session.id },
  });
  await audit.updated({ organizationId, userId: session.id, entity: 'BudgetPeriod', entityId: id, summary: `Budget „${period.name}" genehmigt` });
  return updated;
}

export async function closeBudget(session: SessionUser, organizationId: string, id: string) {
  const period = await requireEditable(organizationId, id);
  const updated = await prisma.budgetPeriod.update({ where: { id }, data: { status: 'CLOSED' } });
  await audit.updated({ organizationId, userId: session.id, entity: 'BudgetPeriod', entityId: id, summary: `Budget „${period.name}" abgeschlossen` });
  return updated;
}

// ---------------------------------------------------------------------------
//  Zeilen
// ---------------------------------------------------------------------------

export async function addBudgetLine(session: SessionUser, organizationId: string, periodId: string, input: CreateBudgetLineInput) {
  const period = await requireEditable(organizationId, periodId);
  if (period.status === 'APPROVED') {
    throw new BusinessRuleError('Das Budget ist genehmigt. Neue Positionen gehören als Nachtrag auf eine bestehende Zeile oder in ein neues Budget.');
  }
  const line = await prisma.budgetLine.create({
    data: {
      periodId,
      category: input.category,
      label: input.label,
      plannedAmount: input.plannedAmount,
      monthlyPlan: input.monthlyPlan ?? spreadEvenly(input.plannedAmount),
      note: input.note ?? null,
      sortOrder: input.sortOrder,
    },
  });
  await audit.created({ organizationId, userId: session.id, entity: 'BudgetLine', entityId: line.id, summary: `Budgetzeile „${line.label}" (${period.name})` });
  return line;
}

/**
 * Nach der Genehmigung bleiben Plan und Monatsverteilung eingefroren; nur
 * `revisedAmount`, Bezeichnung und Notiz sind noch änderbar.
 */
export async function updateBudgetLine(session: SessionUser, organizationId: string, id: string, input: UpdateBudgetLineInput) {
  const line = await prisma.budgetLine.findFirst({ where: { id, period: { organizationId } }, include: { period: true } });
  if (!line) throw new NotFoundError('Budgetzeile');
  if (line.period.status === 'CLOSED') throw new BusinessRuleError('Dieses Budget ist abgeschlossen.');
  const frozen = line.period.status === 'APPROVED';
  if (frozen && (input.plannedAmount !== undefined || input.monthlyPlan !== undefined || input.category !== undefined)) {
    throw new BusinessRuleError('Das Budget ist genehmigt — Planwert, Kategorie und Monatsverteilung sind eingefroren. Erfassen Sie einen Nachtrag.');
  }
  const planned = input.plannedAmount ?? toNumber(line.plannedAmount);
  const updated = await prisma.budgetLine.update({
    where: { id },
    data: {
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.plannedAmount !== undefined ? { plannedAmount: input.plannedAmount } : {}),
      ...(input.monthlyPlan !== undefined
        ? { monthlyPlan: input.monthlyPlan }
        : input.plannedAmount !== undefined
          ? { monthlyPlan: spreadEvenly(planned) }
          : {}),
      ...(input.revisedAmount !== undefined ? { revisedAmount: input.revisedAmount } : {}),
      ...(input.note !== undefined ? { note: input.note || null } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
    },
  });
  await audit.updated({ organizationId, userId: session.id, entity: 'BudgetLine', entityId: id, summary: `Budgetzeile „${updated.label}" geändert`, changes: input });
  return updated;
}

export async function deleteBudgetLine(session: SessionUser, organizationId: string, id: string) {
  const line = await prisma.budgetLine.findFirst({ where: { id, period: { organizationId } }, include: { period: true } });
  if (!line) throw new NotFoundError('Budgetzeile');
  if (line.period.status !== 'DRAFT') throw new BusinessRuleError('Zeilen eines genehmigten Budgets werden nicht gelöscht.');
  await prisma.budgetLine.delete({ where: { id } });
  await audit.deleted({ organizationId, userId: session.id, entity: 'BudgetLine', entityId: id, summary: `Budgetzeile „${line.label}" gelöscht` });
}

// ---------------------------------------------------------------------------
//  Abweichung
// ---------------------------------------------------------------------------

export interface BudgetVarianceLine extends VarianceResult {
  id: string;
  category: string;
  label: string;
  revised: boolean;
  monthly: { plan: number; actual: number }[];
}

export interface BudgetVarianceReport {
  period: { id: string; name: string; fiscalYear: number; status: string; startsOn: Date; endsOn: Date };
  asOf: Date;
  elapsedMonths: number;
  totalMonths: number;
  lines: BudgetVarianceLine[];
  totals: VarianceResult;
  /** Ausgaben in Kategorien, für die keine Budgetzeile existiert. */
  unbudgeted: { category: string; actual: number }[];
}

export async function getBudgetVariance(organizationId: string, id: string, asOf = today()): Promise<BudgetVarianceReport> {
  const period = await getBudget(organizationId, id);
  const end = asOf < period.endsOn ? asOf : period.endsOn;
  const totalMonths = Math.max(1, wholeMonthsBetween(period.startsOn, period.endsOn) + 1);
  // Verstrichen = begonnene Monate: im April sind es vier, egal an welchem Tag.
  const elapsedMonths = asOf < period.startsOn ? 0 : Math.min(totalMonths, wholeMonthsBetween(period.startsOn, end) + 1);

  const expenses = await prisma.expense.findMany({
    where: { organizationId, expenseDate: { gte: period.startsOn, lte: end } },
    select: { category: true, netAmount: true, expenseDate: true },
  });

  const actualByCategory = new Map<string, number>();
  const monthlyByCategory = new Map<string, number[]>();
  for (const e of expenses) {
    actualByCategory.set(e.category, (actualByCategory.get(e.category) ?? 0) + toNumber(e.netAmount));
    const idx = Math.min(totalMonths - 1, wholeMonthsBetween(period.startsOn, e.expenseDate));
    const arr = monthlyByCategory.get(e.category) ?? Array.from({ length: totalMonths }, () => 0);
    arr[idx] += toNumber(e.netAmount);
    monthlyByCategory.set(e.category, arr);
  }

  // Mehrere Zeilen derselben Kategorie teilen sich das Ist anteilig nach Plan.
  const planByCategory = new Map<string, number>();
  for (const line of period.lines) {
    const plan = toNumber(line.revisedAmount ?? line.plannedAmount);
    planByCategory.set(line.category, (planByCategory.get(line.category) ?? 0) + plan);
  }

  const lines: BudgetVarianceLine[] = period.lines.map((line) => {
    const plan = toNumber(line.revisedAmount ?? line.plannedAmount);
    const categoryPlan = planByCategory.get(line.category) ?? 0;
    const share = categoryPlan > 0 ? plan / categoryPlan : 1;
    const actual = (actualByCategory.get(line.category) ?? 0) * share;
    const monthlyPlan = line.monthlyPlan.map(toNumber);
    const monthlyActual = monthlyByCategory.get(line.category) ?? Array.from({ length: totalMonths }, () => 0);
    return {
      id: line.id,
      category: line.category,
      label: line.label,
      revised: line.revisedAmount !== null,
      ...budgetVariance({ plan, monthlyPlan, actual, elapsedMonths, totalMonths }),
      monthly: Array.from({ length: totalMonths }, (_, i) => ({
        plan: round2(monthlyPlan[i] ?? plan / totalMonths),
        actual: round2((monthlyActual[i] ?? 0) * share),
      })),
    };
  });

  const totals = budgetVariance({
    plan: lines.reduce((s, l) => s + l.plan, 0),
    monthlyPlan: [],
    actual: lines.reduce((s, l) => s + l.actual, 0),
    elapsedMonths,
    totalMonths,
  });
  // Die anteilige Summe aus den Zeilen, nicht linear — sonst widerspricht das
  // Total den Zeilen bei ungleicher Monatsverteilung.
  totals.planToDate = round2(lines.reduce((s, l) => s + l.planToDate, 0));
  totals.variance = round2(totals.actual - totals.planToDate);
  totals.variancePct = totals.planToDate > 0 ? Math.round((totals.variance / totals.planToDate) * 1000) / 10 : null;

  const unbudgeted = [...actualByCategory.entries()]
    .filter(([category]) => !planByCategory.has(category))
    .map(([category, actual]) => ({ category, actual: round2(actual) }))
    .sort((a, b) => b.actual - a.actual);

  return {
    period: { id: period.id, name: period.name, fiscalYear: period.fiscalYear, status: period.status, startsOn: period.startsOn, endsOn: period.endsOn },
    asOf,
    elapsedMonths,
    totalMonths,
    lines,
    totals,
    unbudgeted,
  };
}

export type BudgetWithLines = Prisma.BudgetPeriodGetPayload<{ include: { lines: true } }>;
