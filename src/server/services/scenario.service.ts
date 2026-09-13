import 'server-only';

import type { Prisma } from '@prisma/client';

import { prisma, toNumber } from '@/lib/db';
import { audit } from '@/lib/audit';
import type { SessionUser } from '@/lib/auth/session';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { computeScenario, round2, type ScenarioDriverKey, type ScenarioResult } from '@/lib/bi/math';
import { SCENARIO_DRIVER_LABELS } from '@/lib/bi/labels';
import { periodOf, shiftPeriod } from '@/lib/bi/periods';
import type { CreateScenarioInput, ScenarioAssumptionInput, UpdateScenarioInput } from '@/lib/validation/bi-finance';

/**
 * Geschäftsszenarien.
 *
 * Ein Szenario speichert Treiber, nicht Ergebnisse. Das Ergebnis rechnet
 * `computeScenario` und wird als `result` abgelegt, damit ein Vergleich dreier
 * Szenarien nicht bei jedem Seitenaufruf neu rechnet — und ein zur
 * Entscheidung vorgelegtes Szenario nachvollziehbar bleibt.
 */

const include = { assumptions: { orderBy: { sortOrder: 'asc' as const } } } satisfies Prisma.ScenarioInclude;

/**
 * Vorbelegung aus den letzten zwölf Monaten. Ein leeres Formular mit acht
 * Zahlenfeldern füllt niemand aus; eines, das bei den echten Werten steht und
 * zum Verändern einlädt, schon.
 */
export async function suggestAssumptions(organizationId: string): Promise<ScenarioAssumptionInput[]> {
  const now = new Date();
  const current = periodOf('MONTH', now);
  const from = shiftPeriod(current, -12).from;
  const to = current.from;

  const [bookings, jobs, expenses, invoices, employees, org] = await Promise.all([
    prisma.booking.aggregate({
      where: { organizationId, deletedAt: null, status: 'COMPLETED', completedAt: { gte: from, lt: to } },
      _count: true,
      _avg: { netTotal: true },
    }),
    prisma.job.aggregate({
      where: { organizationId, deletedAt: null, status: { in: ['COMPLETED', 'VERIFIED'] }, actualEnd: { gte: from, lt: to } },
      _sum: { revenue: true, laborCost: true, materialCost: true, estimatedMin: true },
      _count: true,
    }),
    prisma.expense.groupBy({
      by: ['category'],
      where: { organizationId, expenseDate: { gte: shiftPeriod(current, -12).periodStart, lt: current.periodStart } },
      _sum: { netAmount: true },
    }),
    prisma.invoice.findMany({
      where: { organizationId, deletedAt: null, status: 'PAID', paidAt: { gte: from, lt: to } },
      select: { issueDate: true, paidAt: true },
    }),
    prisma.employee.aggregate({ where: { organizationId, active: true }, _avg: { hourlyRate: true } }),
    prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { weeklyHours: true } }),
  ]);

  const jobsPerMonth = Math.max(1, Math.round(bookings._count / 12));
  const averageTicket = round2(toNumber(bookings._avg.netTotal)) || 250;
  const jobRevenue = toNumber(jobs._sum.revenue);
  const laborPct = jobRevenue > 0 ? round2((toNumber(jobs._sum.laborCost) / jobRevenue) * 100) : 45;
  const materialPct = jobRevenue > 0 ? round2((toNumber(jobs._sum.materialCost) / jobRevenue) * 100) : 6;

  const fixed = new Set(['RENT', 'INSURANCE', 'SOFTWARE', 'VEHICLE', 'MARKETING', 'TAXES', 'OTHER', 'TRAINING']);
  const overheadYear = expenses.filter((e) => fixed.has(e.category)).reduce((s, e) => s + toNumber(e._sum.netAmount), 0);
  const investmentYear = expenses.filter((e) => e.category === 'EQUIPMENT').reduce((s, e) => s + toNumber(e._sum.netAmount), 0);

  const delay = invoices.length
    ? Math.round(invoices.reduce((s, i) => s + (i.paidAt!.getTime() - i.issueDate.getTime()) / 86_400_000, 0) / invoices.length)
    : 30;
  const hoursPerJob = jobs._count > 0 ? round2(toNumber(jobs._sum.estimatedMin) / 60 / jobs._count) : 3;

  void employees;
  void org;

  const mk = (key: ScenarioDriverKey, value: number, sortOrder: number): ScenarioAssumptionInput => ({
    key,
    label: SCENARIO_DRIVER_LABELS[key].label,
    value,
    unit: SCENARIO_DRIVER_LABELS[key].unit as ScenarioAssumptionInput['unit'],
    monthlyChangePct: 0,
    sortOrder,
  });

  return [
    mk('jobsPerMonth', jobsPerMonth, 0),
    mk('averageTicket', averageTicket, 1),
    mk('laborCostPct', laborPct || 45, 2),
    mk('materialCostPct', materialPct || 6, 3),
    mk('overheadPerMonth', round2(overheadYear / 12), 4),
    mk('investmentPerMonth', round2(investmentYear / 12), 5),
    mk('churnPct', 1, 6),
    mk('paymentDelayDays', delay, 7),
    mk('hoursPerJob', hoursPerJob || 3, 8),
    mk('targetUtilizationPct', 80, 9),
  ];
}

async function rechnungskontext(organizationId: string) {
  const now = new Date();
  const current = periodOf('MONTH', now);
  const from = shiftPeriod(current, -12).from;
  const [org, groups] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { weeklyHours: true } }),
    prisma.booking.groupBy({
      by: ['customerId'],
      where: { organizationId, deletedAt: null, status: 'COMPLETED', completedAt: { gte: from, lt: current.from } },
      _count: { _all: true },
    }),
  ]);
  const jobsPerCustomerMonth =
    groups.length > 0 ? groups.reduce((s, g) => s + g._count._all, 0) / groups.length / 12 : 0.5;
  return {
    hoursPerFteMonth: (toNumber(org.weeklyHours) * 52) / 12,
    jobsPerCustomerMonth: Math.max(0.1, Math.round(jobsPerCustomerMonth * 100) / 100),
  };
}

export async function computeAndStore(organizationId: string, id: string): Promise<ScenarioResult> {
  const scenario = await prisma.scenario.findFirst({ where: { id, organizationId, deletedAt: null }, include });
  if (!scenario) throw new NotFoundError('Szenario');
  if (scenario.assumptions.length === 0) throw new BusinessRuleError('Das Szenario hat noch keine Annahmen — ohne Treiber gibt es nichts zu rechnen.');

  const ctx = await rechnungskontext(organizationId);
  const drivers: Partial<Record<ScenarioDriverKey, { value: number; monthlyChangePct: number }>> = {};
  for (const a of scenario.assumptions) {
    drivers[a.key as ScenarioDriverKey] = { value: toNumber(a.value), monthlyChangePct: toNumber(a.monthlyChangePct) };
  }
  const result = computeScenario({
    horizonMonths: scenario.horizonMonths,
    openingCash: toNumber(scenario.openingCash),
    drivers,
    ...ctx,
  });
  await prisma.scenario.update({
    where: { id },
    data: { result: result as unknown as Prisma.InputJsonValue, computedAt: new Date() },
  });
  return result;
}

export async function listScenarios(organizationId: string, filter: { fiscalYear?: number; kind?: string }) {
  return prisma.scenario.findMany({
    where: {
      organizationId,
      deletedAt: null,
      ...(filter.fiscalYear ? { fiscalYear: filter.fiscalYear } : {}),
      ...(filter.kind ? { kind: filter.kind as never } : {}),
    },
    include: { _count: { select: { assumptions: true } } },
    orderBy: [{ fiscalYear: 'desc' }, { kind: 'asc' }, { name: 'asc' }],
  });
}

export async function getScenario(organizationId: string, id: string) {
  const scenario = await prisma.scenario.findFirst({ where: { id, organizationId, deletedAt: null }, include });
  if (!scenario) throw new NotFoundError('Szenario');
  return scenario;
}

export async function createScenario(session: SessionUser, organizationId: string, input: CreateScenarioInput) {
  const assumptions = input.assumptions && input.assumptions.length > 0 ? input.assumptions : await suggestAssumptions(organizationId);
  const scenario = await prisma.scenario.create({
    data: {
      organizationId,
      name: input.name,
      kind: input.kind,
      fiscalYear: input.fiscalYear,
      horizonMonths: input.horizonMonths,
      description: input.description ?? null,
      openingCash: input.openingCash,
      createdById: session.id,
      assumptions: {
        create: assumptions.map((a) => ({
          key: a.key,
          label: a.label,
          value: a.value,
          unit: a.unit,
          monthlyChangePct: a.monthlyChangePct,
          note: a.note ?? null,
          sortOrder: a.sortOrder,
        })),
      },
    },
  });
  await computeAndStore(organizationId, scenario.id);
  await audit.created({ organizationId, userId: session.id, entity: 'Scenario', entityId: scenario.id, summary: `Szenario „${scenario.name}" angelegt` });
  return scenario;
}

export async function updateScenario(session: SessionUser, organizationId: string, id: string, input: UpdateScenarioInput) {
  const before = await prisma.scenario.findFirst({ where: { id, organizationId, deletedAt: null } });
  if (!before) throw new NotFoundError('Szenario');
  await prisma.$transaction(async (tx) => {
    await tx.scenario.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.fiscalYear !== undefined ? { fiscalYear: input.fiscalYear } : {}),
        ...(input.horizonMonths !== undefined ? { horizonMonths: input.horizonMonths } : {}),
        ...(input.description !== undefined ? { description: input.description || null } : {}),
        ...(input.openingCash !== undefined ? { openingCash: input.openingCash } : {}),
      },
    });
    if (input.assumptions) {
      // Annahmen werden als Ganzes ersetzt — das Formular zeigt sie als Ganzes.
      await tx.scenarioAssumption.deleteMany({ where: { scenarioId: id } });
      await tx.scenarioAssumption.createMany({
        data: input.assumptions.map((a) => ({
          scenarioId: id,
          key: a.key,
          label: a.label,
          value: a.value,
          unit: a.unit,
          monthlyChangePct: a.monthlyChangePct,
          note: a.note ?? null,
          sortOrder: a.sortOrder,
        })),
      });
    }
  });
  const result = await computeAndStore(organizationId, id);
  await audit.updated({ organizationId, userId: session.id, entity: 'Scenario', entityId: id, summary: `Szenario „${input.name ?? before.name}" geändert`, changes: input });
  return result;
}

export async function deleteScenario(session: SessionUser, organizationId: string, id: string) {
  const scenario = await prisma.scenario.findFirst({ where: { id, organizationId, deletedAt: null } });
  if (!scenario) throw new NotFoundError('Szenario');
  await prisma.scenario.update({ where: { id }, data: { deletedAt: new Date() } });
  await audit.deleted({ organizationId, userId: session.id, entity: 'Scenario', entityId: id, summary: `Szenario „${scenario.name}" gelöscht` });
}

/** Vergleich: alle Szenarien eines Jahres oder ausdrücklich genannte. */
export async function compareScenarios(organizationId: string, filter: { fiscalYear?: number; ids?: string[] }) {
  const scenarios = await prisma.scenario.findMany({
    where: {
      organizationId,
      deletedAt: null,
      ...(filter.ids?.length ? { id: { in: filter.ids } } : {}),
      ...(filter.fiscalYear ? { fiscalYear: filter.fiscalYear } : {}),
    },
    include,
    orderBy: [{ kind: 'asc' }, { name: 'asc' }],
  });
  const rows = [];
  for (const scenario of scenarios) {
    const result = (scenario.result as unknown as ScenarioResult | null) ?? (await computeAndStore(organizationId, scenario.id));
    rows.push({
      id: scenario.id,
      name: scenario.name,
      kind: scenario.kind,
      fiscalYear: scenario.fiscalYear,
      horizonMonths: scenario.horizonMonths,
      openingCash: toNumber(scenario.openingCash),
      computedAt: scenario.computedAt,
      assumptions: scenario.assumptions.map((a) => ({ key: a.key, label: a.label, value: toNumber(a.value), unit: a.unit, monthlyChangePct: toNumber(a.monthlyChangePct) })),
      totals: result.totals,
      breakEvenMonth: result.breakEvenMonth,
      breakEvenRevenue: result.breakEvenRevenue,
      liquidityLow: result.liquidityLow,
      closingCash: result.closingCash,
      peakEmployees: result.peakEmployees,
      peakCustomers: result.peakCustomers,
      months: result.months,
    });
  }
  return rows;
}
