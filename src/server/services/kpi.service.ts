import 'server-only';

import type { KpiPeriod, Prisma } from '@prisma/client';

import { prisma, toNumber } from '@/lib/db';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import {
  periodFromKey,
  periodOf,
  previousYear,
  shiftPeriod,
  toDateOnly,
  workingDays,
  type PeriodBounds,
  type PeriodName,
} from '@/lib/bi/periods';
import { changePct, round2 } from '@/lib/bi/math';
import type {
  CreateKpiDefinitionInput,
  HealthWeightsInput,
  KpiSeriesQuery,
  KpiTargetInput,
  ManualKpiValueInput,
  UpdateKpiDefinitionInput,
} from '@/lib/validation/bi-kpi';

const log = logger('kpi');

/**
 * Kennzahlmaschine.
 *
 * Architekturentscheid — der wichtigste dieses Moduls: **der Verlauf wird
 * gespeichert, nicht jedes Mal neu gerechnet.** Eine live gerechnete Kurve
 * schreibt die Vergangenheit um, sobald eine Buchung storniert, eine
 * Kundschaft zusammengeführt oder eine Gutschrift gebucht wird. Wer im März
 * 31 % Marge gemeldet hat und im Juni 28 % auf demselben Chart sieht, glaubt
 * der Zahl zu Recht nicht mehr. Deshalb schreibt der Nachtlauf Snapshots; die
 * laufende Periode ist `provisional` und wird beim Periodenwechsel
 * festgeschrieben.
 *
 * Gemeinsame Regeln aller Rechner (aus `docs/bi/04-KENNZAHLEN.md`):
 *  • Umsatz = Rechnungen `ISSUED|SENT|PARTIALLY_PAID|PAID|OVERDUE` nach
 *    `issueDate`, netto, abzüglich Gutschriften.
 *  • Leerer Nenner ergibt `null`, nicht 0 — eine Quote von 0 % bei null
 *    Offerten ist eine Falschaussage. Ohne Wert wird kein Snapshot geschrieben.
 *  • `sampleSize` hält die Fallzahl fest, damit „100 % Annahmequote" bei zwei
 *    Offerten als das erkennbar ist, was es ist.
 */

export interface KpiComputation {
  value: number | null;
  sampleSize?: number;
  breakdown?: Record<string, unknown>;
}

export interface KpiContext {
  organizationId: string;
  bounds: PeriodBounds;
  from: Date;
  to: Date;
}

export type KpiCalculator = (ctx: KpiContext) => Promise<KpiComputation>;

const REVENUE_STATUSES = ['ISSUED', 'SENT', 'PARTIALLY_PAID', 'PAID', 'OVERDUE'] as const;

function ratio(numerator: number, denominator: number, scale = 100): number | null {
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * scale * 100) / 100;
}

async function revenueNet(ctx: KpiContext): Promise<{ invoices: number; credits: number; count: number }> {
  const [inv, credits] = await Promise.all([
    prisma.invoice.aggregate({
      where: {
        organizationId: ctx.organizationId,
        deletedAt: null,
        status: { in: [...REVENUE_STATUSES] },
        issueDate: { gte: ctx.bounds.periodStart, lte: ctx.bounds.periodEnd },
      },
      _sum: { netTotal: true },
      _count: true,
    }),
    prisma.creditNote.aggregate({
      where: {
        organizationId: ctx.organizationId,
        issueDate: { gte: ctx.bounds.periodStart, lte: ctx.bounds.periodEnd },
      },
      _sum: { netTotal: true },
    }),
  ]);
  return { invoices: toNumber(inv._sum.netTotal), credits: toNumber(credits._sum.netTotal), count: inv._count };
}

async function operatingCost(ctx: KpiContext): Promise<number> {
  const agg = await prisma.expense.aggregate({
    where: {
      organizationId: ctx.organizationId,
      expenseDate: { gte: ctx.bounds.periodStart, lte: ctx.bounds.periodEnd },
    },
    _sum: { netAmount: true },
  });
  return toNumber(agg._sum.netAmount);
}

/** Aktive Kundschaft = mindestens eine abgeschlossene Buchung in den 12 Monaten bis zum Periodenende. */
async function activeCustomerIds(ctx: KpiContext): Promise<Map<string, number>> {
  const windowStart = new Date(ctx.to);
  windowStart.setUTCFullYear(windowStart.getUTCFullYear() - 1);
  const groups = await prisma.booking.groupBy({
    by: ['customerId'],
    where: {
      organizationId: ctx.organizationId,
      deletedAt: null,
      status: 'COMPLETED',
      completedAt: { gte: windowStart, lt: ctx.to },
    },
    _count: { _all: true },
  });
  return new Map(groups.map((g) => [g.customerId, g._count._all]));
}

/** Sollminuten aller aktiven Mitarbeitenden in der Periode. */
async function targetMinutes(ctx: KpiContext): Promise<{ minutes: number; headcount: number; fte: number }> {
  const [org, employees, holidays] = await Promise.all([
    prisma.organization.findUniqueOrThrow({
      where: { id: ctx.organizationId },
      select: { weeklyHours: true },
    }),
    prisma.employee.findMany({
      where: { organizationId: ctx.organizationId, active: true },
      select: {
        id: true,
        workloadPct: true,
        absences: {
          where: {
            status: 'APPROVED',
            startDate: { lte: ctx.bounds.periodEnd },
            endDate: { gte: ctx.bounds.periodStart },
          },
          select: { days: true },
        },
      },
    }),
    prisma.holiday.findMany({
      where: {
        organizationId: ctx.organizationId,
        date: { gte: ctx.bounds.periodStart, lte: ctx.bounds.periodEnd },
      },
      select: { date: true },
    }),
  ]);

  const days = workingDays(ctx.bounds.periodStart, ctx.bounds.periodEnd, holidays.map((h) => h.date));
  const dailyMinutes = (toNumber(org.weeklyHours) / 5) * 60;
  let minutes = 0;
  let fte = 0;
  for (const employee of employees) {
    const share = employee.workloadPct / 100;
    fte += share;
    const absentDays = employee.absences.reduce((sum, a) => sum + toNumber(a.days), 0);
    minutes += Math.max(0, (days - absentDays) * dailyMinutes * share);
  }
  return { minutes, headcount: employees.length, fte: Math.round(fte * 100) / 100 };
}

/**
 * Die Registry. Eine `KpiDefinition` mit `source = DERIVED` ohne Eintrag hier
 * ist ein Konfigurationsfehler, den der Nachtlauf meldet statt still eine Null
 * zu schreiben — die sähe im Chart wie ein Einbruch aus.
 */
export const KPI_CALCULATORS: Record<string, KpiCalculator> = {
  // --- Finanzen -------------------------------------------------------------
  'revenue.net': async (ctx) => {
    const r = await revenueNet(ctx);
    return {
      value: round2(r.invoices - r.credits),
      sampleSize: r.count,
      breakdown: { rechnungen: r.invoices, gutschriften: r.credits },
    };
  },
  'revenue.recurring': async (ctx) => {
    const agg = await prisma.invoice.aggregate({
      where: {
        organizationId: ctx.organizationId,
        deletedAt: null,
        status: { in: [...REVENUE_STATUSES] },
        issueDate: { gte: ctx.bounds.periodStart, lte: ctx.bounds.periodEnd },
        booking: { OR: [{ frequency: { not: 'ONCE' } }, { recurrenceRuleId: { not: null } }] },
      },
      _sum: { netTotal: true },
      _count: true,
    });
    return { value: round2(toNumber(agg._sum.netTotal)), sampleSize: agg._count };
  },
  'revenue.recurringShare': async (ctx) => {
    const [total, recurring] = await Promise.all([
      KPI_CALCULATORS['revenue.net'](ctx),
      KPI_CALCULATORS['revenue.recurring'](ctx),
    ]);
    const t = total.value ?? 0;
    return {
      value: t > 0 ? ratio(recurring.value ?? 0, t) : null,
      sampleSize: total.sampleSize,
      breakdown: { wiederkehrend: recurring.value, gesamt: t },
    };
  },
  'revenue.growthYoY': async (ctx) => {
    const prev = previousYear(ctx.bounds);
    const [now, before] = await Promise.all([
      KPI_CALCULATORS['revenue.net'](ctx),
      KPI_CALCULATORS['revenue.net']({ ...ctx, bounds: prev, from: prev.from, to: prev.to }),
    ]);
    const value = changePct(now.value ?? 0, before.value);
    return { value, breakdown: { aktuell: now.value, vorjahr: before.value } };
  },
  'margin.gross': async (ctx) => {
    const jobs = await prisma.job.findMany({
      where: {
        organizationId: ctx.organizationId,
        deletedAt: null,
        status: { in: ['COMPLETED', 'VERIFIED'] },
        actualEnd: { gte: ctx.from, lt: ctx.to },
      },
      select: { revenue: true, laborCost: true, materialCost: true },
    });
    const revenue = jobs.reduce((s, j) => s + toNumber(j.revenue), 0);
    const cost = jobs.reduce((s, j) => s + toNumber(j.laborCost) + toNumber(j.materialCost), 0);
    const withCosting = jobs.filter((j) => toNumber(j.laborCost) > 0 || toNumber(j.materialCost) > 0).length;
    return {
      value: revenue > 0 ? ratio(revenue - cost, revenue) : null,
      sampleSize: jobs.length,
      breakdown: { erloes: round2(revenue), kosten: round2(cost), mitNachkalkulation: withCosting },
    };
  },
  'cost.operating': async (ctx) => ({ value: round2(await operatingCost(ctx)) }),
  'profit.operating': async (ctx) => {
    const [rev, cost] = await Promise.all([KPI_CALCULATORS['revenue.net'](ctx), operatingCost(ctx)]);
    return { value: round2((rev.value ?? 0) - cost), breakdown: { umsatz: rev.value, kosten: cost } };
  },
  'invoice.outstanding': async (ctx) => {
    const agg = await prisma.invoice.aggregate({
      where: {
        organizationId: ctx.organizationId,
        deletedAt: null,
        status: { in: ['SENT', 'PARTIALLY_PAID', 'OVERDUE'] },
        issueDate: { lte: ctx.bounds.periodEnd },
      },
      _sum: { balance: true },
      _count: true,
    });
    return { value: round2(toNumber(agg._sum.balance)), sampleSize: agg._count };
  },
  'invoice.overdue': async (ctx) => {
    const agg = await prisma.invoice.aggregate({
      where: {
        organizationId: ctx.organizationId,
        deletedAt: null,
        status: 'OVERDUE',
        issueDate: { lte: ctx.bounds.periodEnd },
      },
      _sum: { balance: true },
      _count: true,
    });
    return { value: round2(toNumber(agg._sum.balance)), sampleSize: agg._count };
  },
  'invoice.dso': async (ctx) => {
    const paid = await prisma.invoice.findMany({
      where: {
        organizationId: ctx.organizationId,
        deletedAt: null,
        status: 'PAID',
        paidAt: { gte: ctx.from, lt: ctx.to },
      },
      select: { issueDate: true, paidAt: true },
    });
    if (paid.length === 0) return { value: null, sampleSize: 0 };
    const days = paid.map((i) => (i.paidAt!.getTime() - i.issueDate.getTime()) / 86_400_000);
    return { value: round2(days.reduce((s, d) => s + d, 0) / days.length), sampleSize: paid.length };
  },
  'cashflow.net': async (ctx) => {
    const [inflow, outflow] = await Promise.all([
      prisma.payment.aggregate({
        where: {
          status: 'SUCCEEDED',
          paidAt: { gte: ctx.from, lt: ctx.to },
          OR: [{ invoice: { organizationId: ctx.organizationId } }, { customer: { organizationId: ctx.organizationId } }],
        },
        _sum: { amount: true },
      }),
      prisma.expense.aggregate({
        where: {
          organizationId: ctx.organizationId,
          paid: true,
          paidAt: { gte: ctx.from, lt: ctx.to },
        },
        _sum: { grossAmount: true },
      }),
    ]);
    const cashIn = toNumber(inflow._sum.amount);
    const cashOut = toNumber(outflow._sum.grossAmount);
    return { value: round2(cashIn - cashOut), breakdown: { einzahlungen: cashIn, auszahlungen: cashOut } };
  },

  // --- Vertrieb -------------------------------------------------------------
  'quote.sent': async (ctx) => {
    const count = await prisma.quote.count({
      where: { organizationId: ctx.organizationId, sentAt: { gte: ctx.from, lt: ctx.to } },
    });
    return { value: count, sampleSize: count };
  },
  'quote.conversion': async (ctx) => {
    // Kohorte, nicht Zeitfenster: Offerten, die in der Periode *gesendet*
    // wurden, und ihr Ausgang zum Zeitpunkt der Rechnung. Die Quote reift
    // deshalb noch — `offen` im Breakdown sagt, wie viele noch entscheiden.
    const quotes = await prisma.quote.findMany({
      where: { organizationId: ctx.organizationId, sentAt: { gte: ctx.from, lt: ctx.to } },
      select: { acceptedAt: true, rejectedAt: true, status: true },
    });
    if (quotes.length === 0) return { value: null, sampleSize: 0 };
    const accepted = quotes.filter((q) => q.acceptedAt || q.status === 'CONVERTED').length;
    const open = quotes.filter((q) => !q.acceptedAt && !q.rejectedAt && ['SENT', 'VIEWED'].includes(q.status)).length;
    return { value: ratio(accepted, quotes.length), sampleSize: quotes.length, breakdown: { angenommen: accepted, offen: open } };
  },
  'quote.avgValue': async (ctx) => {
    const agg = await prisma.quote.aggregate({
      where: { organizationId: ctx.organizationId, sentAt: { gte: ctx.from, lt: ctx.to } },
      _avg: { netTotal: true },
      _count: true,
    });
    return { value: agg._count ? round2(toNumber(agg._avg.netTotal)) : null, sampleSize: agg._count };
  },
  'quote.timeToDecision': async (ctx) => {
    const decided = await prisma.quote.findMany({
      where: {
        organizationId: ctx.organizationId,
        sentAt: { gte: ctx.from, lt: ctx.to },
        OR: [{ acceptedAt: { not: null } }, { rejectedAt: { not: null } }],
      },
      select: { sentAt: true, acceptedAt: true, rejectedAt: true },
    });
    if (decided.length === 0) return { value: null, sampleSize: 0 };
    const days = decided.map((q) => ((q.acceptedAt ?? q.rejectedAt)!.getTime() - q.sentAt!.getTime()) / 86_400_000);
    return { value: round2(days.reduce((s, d) => s + d, 0) / days.length), sampleSize: decided.length };
  },
  'lead.new': async (ctx) => {
    const count = await prisma.lead.count({
      where: { organizationId: ctx.organizationId, deletedAt: null, createdAt: { gte: ctx.from, lt: ctx.to } },
    });
    return { value: count, sampleSize: count };
  },
  'lead.conversion': async (ctx) => {
    const [total, won] = await Promise.all([
      prisma.lead.count({
        where: { organizationId: ctx.organizationId, deletedAt: null, createdAt: { gte: ctx.from, lt: ctx.to } },
      }),
      prisma.lead.count({
        where: {
          organizationId: ctx.organizationId,
          deletedAt: null,
          createdAt: { gte: ctx.from, lt: ctx.to },
          status: 'WON',
        },
      }),
    ]);
    return { value: total > 0 ? ratio(won, total) : null, sampleSize: total, breakdown: { gewonnen: won } };
  },
  'lead.costPerLead': async (ctx) => {
    const [spend, leads] = await Promise.all([
      prisma.expense.aggregate({
        where: {
          organizationId: ctx.organizationId,
          category: 'MARKETING',
          expenseDate: { gte: ctx.bounds.periodStart, lte: ctx.bounds.periodEnd },
        },
        _sum: { netAmount: true },
      }),
      prisma.lead.count({
        where: { organizationId: ctx.organizationId, deletedAt: null, createdAt: { gte: ctx.from, lt: ctx.to } },
      }),
    ]);
    const cost = toNumber(spend._sum.netAmount);
    return { value: leads > 0 ? round2(cost / leads) : null, sampleSize: leads, breakdown: { marketingkosten: cost } };
  },

  // --- Auftragslage ---------------------------------------------------------
  'booking.created': async (ctx) => {
    const count = await prisma.booking.count({
      where: { organizationId: ctx.organizationId, deletedAt: null, createdAt: { gte: ctx.from, lt: ctx.to } },
    });
    return { value: count, sampleSize: count };
  },
  'booking.completed': async (ctx) => {
    const count = await prisma.booking.count({
      where: {
        organizationId: ctx.organizationId,
        deletedAt: null,
        status: 'COMPLETED',
        completedAt: { gte: ctx.from, lt: ctx.to },
      },
    });
    return { value: count, sampleSize: count };
  },
  'booking.cancelled': async (ctx) => {
    const count = await prisma.booking.count({
      where: {
        organizationId: ctx.organizationId,
        deletedAt: null,
        status: { in: ['CANCELLED', 'NO_SHOW'] },
        cancelledAt: { gte: ctx.from, lt: ctx.to },
      },
    });
    return { value: count, sampleSize: count };
  },
  'booking.cancellationRate': async (ctx) => {
    const [completed, cancelled] = await Promise.all([
      KPI_CALCULATORS['booking.completed'](ctx),
      KPI_CALCULATORS['booking.cancelled'](ctx),
    ]);
    const c = completed.value ?? 0;
    const x = cancelled.value ?? 0;
    return { value: c + x > 0 ? ratio(x, c + x) : null, sampleSize: c + x, breakdown: { abgeschlossen: c, storniert: x } };
  },
  'booking.avgTicket': async (ctx) => {
    const agg = await prisma.booking.aggregate({
      where: {
        organizationId: ctx.organizationId,
        deletedAt: null,
        status: 'COMPLETED',
        completedAt: { gte: ctx.from, lt: ctx.to },
      },
      _avg: { netTotal: true },
      _count: true,
    });
    return { value: agg._count ? round2(toNumber(agg._avg.netTotal)) : null, sampleSize: agg._count };
  },
  'job.backlog': async (ctx) => {
    const count = await prisma.job.count({
      where: {
        organizationId: ctx.organizationId,
        deletedAt: null,
        scheduledStart: { gte: ctx.to },
        status: { notIn: ['CANCELLED', 'COMPLETED', 'VERIFIED'] },
      },
    });
    return { value: count, sampleSize: count };
  },

  // --- Kundschaft -----------------------------------------------------------
  'customer.active': async (ctx) => {
    const active = await activeCustomerIds(ctx);
    return { value: active.size, sampleSize: active.size };
  },
  'customer.new': async (ctx) => {
    const count = await prisma.customer.count({
      where: { organizationId: ctx.organizationId, deletedAt: null, createdAt: { gte: ctx.from, lt: ctx.to } },
    });
    return { value: count, sampleSize: count };
  },
  'customer.growth': async (ctx) => {
    const prev = previousYear(ctx.bounds);
    const [now, before] = await Promise.all([
      activeCustomerIds(ctx),
      activeCustomerIds({ ...ctx, bounds: prev, from: prev.from, to: prev.to }),
    ]);
    return { value: changePct(now.size, before.size), breakdown: { aktuell: now.size, vorjahr: before.size } };
  },
  'customer.repeatRate': async (ctx) => {
    const active = await activeCustomerIds(ctx);
    if (active.size === 0) return { value: null, sampleSize: 0 };
    const repeat = [...active.values()].filter((n) => n >= 2).length;
    return { value: ratio(repeat, active.size), sampleSize: active.size, breakdown: { wiederkehrend: repeat } };
  },
  'customer.satisfaction': async (ctx) => {
    const agg = await prisma.review.aggregate({
      where: {
        organizationId: ctx.organizationId,
        status: 'PUBLISHED',
        createdAt: { gte: ctx.from, lt: ctx.to },
      },
      _avg: { rating: true },
      _count: true,
    });
    return { value: agg._count ? round2((agg._avg.rating ?? 0) * 20) : null, sampleSize: agg._count };
  },
  'customer.jobRating': async (ctx) => {
    const agg = await prisma.job.aggregate({
      where: {
        organizationId: ctx.organizationId,
        deletedAt: null,
        customerRating: { not: null },
        actualEnd: { gte: ctx.from, lt: ctx.to },
      },
      _avg: { customerRating: true },
      _count: true,
    });
    return { value: agg._count ? round2((agg._avg.customerRating ?? 0) * 20) : null, sampleSize: agg._count };
  },
  'response.firstReply': async (ctx) => {
    // Fensterfunktion: je Verlauf die erste Kundennachricht und die erste
    // Antwort danach. In Prisma wären das N+1 Abfragen über alle Verläufe.
    const rows = await prisma.$queryRaw<{ hours: number | null; n: bigint }[]>`
      WITH first_customer AS (
        SELECT DISTINCT ON (m."threadId") m."threadId", m."createdAt" AS asked_at
        FROM messages m
        JOIN message_threads t ON t.id = m."threadId"
        JOIN customers c ON c.id = t."customerId"
        WHERE m."authorType" = 'CUSTOMER'
          AND c."organizationId" = ${ctx.organizationId}
          AND m."createdAt" >= ${ctx.from} AND m."createdAt" < ${ctx.to}
        ORDER BY m."threadId", m."createdAt"
      ),
      first_reply AS (
        SELECT fc."threadId", MIN(r."createdAt") AS replied_at
        FROM first_customer fc
        JOIN messages r ON r."threadId" = fc."threadId"
          AND r."authorType" <> 'CUSTOMER' AND r."createdAt" > fc.asked_at
        GROUP BY fc."threadId"
      )
      SELECT AVG(EXTRACT(EPOCH FROM (fr.replied_at - fc.asked_at)) / 3600)::float AS hours,
             COUNT(*)::bigint AS n
      FROM first_customer fc JOIN first_reply fr ON fr."threadId" = fc."threadId"
    `;
    const row = rows[0];
    const n = Number(row?.n ?? 0);
    return { value: n > 0 && row.hours !== null ? round2(row.hours) : null, sampleSize: n };
  },

  // --- Personal -------------------------------------------------------------
  'employee.utilization': async (ctx) => {
    const [worked, target] = await Promise.all([
      prisma.timeEntry.aggregate({
        where: {
          approved: true,
          jobId: { not: null },
          startedAt: { gte: ctx.from, lt: ctx.to },
          employee: { organizationId: ctx.organizationId },
        },
        _sum: { minutes: true },
      }),
      targetMinutes(ctx),
    ]);
    const minutes = worked._sum.minutes ?? 0;
    return {
      value: target.minutes > 0 ? ratio(minutes, target.minutes) : null,
      sampleSize: target.headcount,
      breakdown: { istMinuten: minutes, sollMinuten: Math.round(target.minutes) },
    };
  },
  'employee.headcountFte': async (ctx) => {
    const t = await targetMinutes(ctx);
    return { value: t.fte, sampleSize: t.headcount };
  },
  'employee.revenuePerFte': async (ctx) => {
    const [rev, t] = await Promise.all([KPI_CALCULATORS['revenue.net'](ctx), targetMinutes(ctx)]);
    return { value: t.fte > 0 ? round2((rev.value ?? 0) / t.fte) : null, sampleSize: t.headcount };
  },
  'employee.absenceRate': async (ctx) => {
    const [absences, holidays, employees] = await Promise.all([
      prisma.absence.aggregate({
        where: {
          status: 'APPROVED',
          employee: { organizationId: ctx.organizationId, active: true },
          startDate: { lte: ctx.bounds.periodEnd },
          endDate: { gte: ctx.bounds.periodStart },
        },
        _sum: { days: true },
      }),
      prisma.holiday.findMany({
        where: { organizationId: ctx.organizationId, date: { gte: ctx.bounds.periodStart, lte: ctx.bounds.periodEnd } },
        select: { date: true },
      }),
      prisma.employee.count({ where: { organizationId: ctx.organizationId, active: true } }),
    ]);
    const targetDays = workingDays(ctx.bounds.periodStart, ctx.bounds.periodEnd, holidays.map((h) => h.date)) * employees;
    const absent = toNumber(absences._sum.days);
    return { value: targetDays > 0 ? ratio(absent, targetDays) : null, sampleSize: employees, breakdown: { abwesend: absent, soll: targetDays } };
  },
};

export const KPI_KEYS = Object.keys(KPI_CALCULATORS);

// ---------------------------------------------------------------------------
//  Snapshots
// ---------------------------------------------------------------------------

function contextFor(organizationId: string, bounds: PeriodBounds): KpiContext {
  return { organizationId, bounds, from: bounds.from, to: bounds.to };
}

/** Zielwert für eine Periode: die Ausnahme (`KpiTarget`) schlägt den Dauerwert. */
async function targetFor(definitionId: string, fallback: number | null, bounds: PeriodBounds): Promise<number | null> {
  const special = await prisma.kpiTarget.findUnique({
    where: { definitionId_period_periodStart: { definitionId, period: bounds.period, periodStart: bounds.periodStart } },
  });
  return special ? toNumber(special.targetValue) : fallback;
}

/**
 * Einen Snapshot rechnen und schreiben.
 *
 * Ein bereits festgeschriebener Snapshot (`provisional = false`) wird nicht
 * mehr angefasst — dieselbe Haltung wie bei ausgestellten Rechnungen. Nur die
 * Rückwärtsfüllung darf mit `force` darüber schreiben.
 */
export async function writeSnapshot(params: {
  organizationId: string;
  definition: { id: string; key: string; source: string; targetValue: Prisma.Decimal | null };
  bounds: PeriodBounds;
  final: boolean;
  force?: boolean;
}): Promise<'written' | 'skipped' | 'kept' | 'no-calculator' | 'no-value'> {
  const { organizationId, definition, bounds } = params;
  if (definition.source !== 'DERIVED') return 'skipped';

  const calculator = KPI_CALCULATORS[definition.key];
  if (!calculator) {
    log.warn('Kennzahl ohne Rechner', { key: definition.key });
    return 'no-calculator';
  }

  const existing = await prisma.kpiSnapshot.findUnique({
    where: { definitionId_period_periodStart: { definitionId: definition.id, period: bounds.period, periodStart: bounds.periodStart } },
    select: { provisional: true },
  });
  if (existing && !existing.provisional && !params.force) return 'kept';

  const ctx = contextFor(organizationId, bounds);
  const result = await calculator(ctx);
  if (result.value === null) return 'no-value';

  const prev = previousYear(bounds);
  const prevSnapshot = await prisma.kpiSnapshot.findUnique({
    where: { definitionId_period_periodStart: { definitionId: definition.id, period: prev.period, periodStart: prev.periodStart } },
    select: { value: true },
  });
  let previousYearValue: number | null = prevSnapshot ? toNumber(prevSnapshot.value) : null;
  if (previousYearValue === null) {
    const before = await calculator(contextFor(organizationId, prev)).catch(() => ({ value: null }) as KpiComputation);
    previousYearValue = before.value;
  }

  const targetValue = await targetFor(definition.id, definition.targetValue ? toNumber(definition.targetValue) : null, bounds);

  await prisma.kpiSnapshot.upsert({
    where: { definitionId_period_periodStart: { definitionId: definition.id, period: bounds.period, periodStart: bounds.periodStart } },
    create: {
      organizationId,
      definitionId: definition.id,
      period: bounds.period,
      periodStart: bounds.periodStart,
      periodEnd: bounds.periodEnd,
      value: result.value,
      targetValue,
      previousYearValue,
      sampleSize: result.sampleSize ?? null,
      breakdown: (result.breakdown ?? undefined) as Prisma.InputJsonValue | undefined,
      provisional: !params.final,
      computedAt: new Date(),
    },
    update: {
      value: result.value,
      targetValue,
      previousYearValue,
      sampleSize: result.sampleSize ?? null,
      breakdown: (result.breakdown ?? undefined) as Prisma.InputJsonValue | undefined,
      provisional: !params.final,
      computedAt: new Date(),
    },
  });
  return 'written';
}

export interface SnapshotRunSummary {
  written: number;
  kept: number;
  noValue: number;
  missingCalculators: string[];
  failures: { key: string; error: string }[];
}

/**
 * Nachtlauf: laufende Periode vorläufig, die vorangehende endgültig.
 *
 * Try/catch je Rechner — ein einzelner Fehler (etwa eine geänderte Spalte)
 * darf nicht alle anderen Kennzahlen mitreissen. Der Lauf meldet, was
 * gelungen ist und was nicht.
 */
export async function runKpiSnapshots(organizationId: string, now = new Date()): Promise<SnapshotRunSummary> {
  const definitions = await prisma.kpiDefinition.findMany({
    where: { organizationId, active: true, source: 'DERIVED' },
  });
  const summary: SnapshotRunSummary = { written: 0, kept: 0, noValue: 0, missingCalculators: [], failures: [] };

  for (const definition of definitions) {
    for (const period of definition.periods) {
      const current = periodOf(period as PeriodName, now);
      const previous = shiftPeriod(current, -1);
      for (const [bounds, final] of [
        [previous, true],
        [current, false],
      ] as const) {
        try {
          const outcome = await writeSnapshot({ organizationId, definition, bounds, final });
          if (outcome === 'written') summary.written += 1;
          else if (outcome === 'kept') summary.kept += 1;
          else if (outcome === 'no-value') summary.noValue += 1;
          else if (outcome === 'no-calculator' && !summary.missingCalculators.includes(definition.key)) {
            summary.missingCalculators.push(definition.key);
          }
        } catch (error) {
          summary.failures.push({ key: definition.key, error: error instanceof Error ? error.message : String(error) });
          log.error('Kennzahl fehlgeschlagen', { key: definition.key, period, error });
        }
      }
    }
  }
  return summary;
}

/** Rückwärtsfüllung: vergangene Perioden endgültig nachrechnen. */
export async function backfillKpi(organizationId: string, months: number, now = new Date()): Promise<SnapshotRunSummary> {
  const definitions = await prisma.kpiDefinition.findMany({
    where: { organizationId, active: true, source: 'DERIVED' },
  });
  const summary: SnapshotRunSummary = { written: 0, kept: 0, noValue: 0, missingCalculators: [], failures: [] };
  const stepsFor: Record<PeriodName, number> = {
    DAY: 0,
    WEEK: Math.ceil((months * 31) / 7),
    MONTH: months,
    QUARTER: Math.ceil(months / 3),
    YEAR: Math.ceil(months / 12),
  };

  for (const definition of definitions) {
    for (const period of definition.periods) {
      const steps = stepsFor[period as PeriodName];
      const current = periodOf(period as PeriodName, now);
      for (let back = steps; back >= 1; back -= 1) {
        const bounds = shiftPeriod(current, -back);
        try {
          const outcome = await writeSnapshot({ organizationId, definition, bounds, final: true, force: true });
          if (outcome === 'written') summary.written += 1;
          else if (outcome === 'no-value') summary.noValue += 1;
          else if (outcome === 'no-calculator' && !summary.missingCalculators.includes(definition.key)) {
            summary.missingCalculators.push(definition.key);
          }
        } catch (error) {
          summary.failures.push({ key: definition.key, error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
//  Lesen
// ---------------------------------------------------------------------------

export interface KpiSeriesPoint {
  periodStart: string;
  label: string;
  value: number;
  targetValue: number | null;
  previousYearValue: number | null;
  sampleSize: number | null;
  provisional: boolean;
}

export async function getKpiSeries(
  organizationId: string,
  definitionId: string,
  query: KpiSeriesQuery,
): Promise<KpiSeriesPoint[]> {
  const rows = await prisma.kpiSnapshot.findMany({
    where: {
      organizationId,
      definitionId,
      period: query.period as KpiPeriod,
      ...(query.from ? { periodStart: { gte: toDateOnly(query.from) } } : {}),
      ...(query.to ? { periodEnd: { lte: toDateOnly(query.to) } } : {}),
    },
    orderBy: { periodStart: 'desc' },
    take: query.limit,
  });
  return rows
    .reverse()
    .map((row) => ({
      periodStart: row.periodStart.toISOString().slice(0, 10),
      label: periodFromKey(row.period as PeriodName, row.periodStart).label,
      value: toNumber(row.value),
      targetValue: row.targetValue === null ? null : toNumber(row.targetValue),
      previousYearValue: row.previousYearValue === null ? null : toNumber(row.previousYearValue),
      sampleSize: row.sampleSize,
      provisional: row.provisional,
    }));
}

export interface KpiOverviewRow {
  id: string;
  key: string;
  label: string;
  description: string | null;
  group: string;
  unit: string;
  direction: string;
  source: string;
  periods: string[];
  targetValue: number | null;
  warnValue: number | null;
  healthWeight: number;
  active: boolean;
  current: KpiSeriesPoint | null;
  previous: KpiSeriesPoint | null;
  changePct: number | null;
  yoyPct: number | null;
  hasCalculator: boolean;
}

/** Alle Definitionen mit dem jüngsten und dem vorangehenden Wert einer Periodenart. */
export async function getKpiOverview(
  organizationId: string,
  period: PeriodName = 'MONTH',
  filter: { group?: string; active?: boolean; q?: string } = {},
): Promise<KpiOverviewRow[]> {
  const definitions = await prisma.kpiDefinition.findMany({
    where: {
      organizationId,
      ...(filter.group ? { group: filter.group } : {}),
      ...(filter.active !== undefined ? { active: filter.active } : {}),
      ...(filter.q ? { OR: [{ label: { contains: filter.q, mode: 'insensitive' } }, { key: { contains: filter.q, mode: 'insensitive' } }] } : {}),
    },
    orderBy: [{ group: 'asc' }, { sortOrder: 'asc' }, { label: 'asc' }],
    include: {
      snapshots: { where: { period }, orderBy: { periodStart: 'desc' }, take: 2 },
    },
  });

  return definitions.map((d) => {
    const [cur, prev] = d.snapshots;
    const toPoint = (row: (typeof d.snapshots)[number] | undefined): KpiSeriesPoint | null =>
      row
        ? {
            periodStart: row.periodStart.toISOString().slice(0, 10),
            label: periodFromKey(row.period as PeriodName, row.periodStart).label,
            value: toNumber(row.value),
            targetValue: row.targetValue === null ? null : toNumber(row.targetValue),
            previousYearValue: row.previousYearValue === null ? null : toNumber(row.previousYearValue),
            sampleSize: row.sampleSize,
            provisional: row.provisional,
          }
        : null;
    const current = toPoint(cur);
    const previous = toPoint(prev);
    return {
      id: d.id,
      key: d.key,
      label: d.label,
      description: d.description,
      group: d.group,
      unit: d.unit,
      direction: d.direction,
      source: d.source,
      periods: d.periods,
      targetValue: d.targetValue === null ? null : toNumber(d.targetValue),
      warnValue: d.warnValue === null ? null : toNumber(d.warnValue),
      healthWeight: d.healthWeight,
      active: d.active,
      current,
      previous,
      changePct: current && previous ? changePct(current.value, previous.value) : null,
      yoyPct: current ? changePct(current.value, current.previousYearValue) : null,
      hasCalculator: d.source === 'MANUAL' || Boolean(KPI_CALCULATORS[d.key]),
    };
  });
}

// ---------------------------------------------------------------------------
//  Schreiben
// ---------------------------------------------------------------------------

export async function createKpiDefinition(organizationId: string, input: CreateKpiDefinitionInput) {
  if (input.source === 'DERIVED' && !KPI_CALCULATORS[input.key]) {
    throw new BusinessRuleError(
      `Für den Schlüssel „${input.key}" gibt es keinen Rechner. Berechnete Kennzahlen brauchen eine Formel im Code; ` +
        'für selbst gepflegte Zahlen wählen Sie „Manuell erfasst".',
    );
  }
  assertThresholds(input.direction, input.warnValue ?? null, input.targetValue ?? null);
  return prisma.kpiDefinition.create({
    data: {
      organizationId,
      key: input.key,
      label: input.label,
      description: input.description ?? null,
      group: input.group,
      unit: input.unit,
      direction: input.direction,
      source: input.source,
      periods: input.periods as KpiPeriod[],
      targetValue: input.targetValue ?? null,
      warnValue: input.warnValue ?? null,
      healthWeight: input.healthWeight,
      active: input.active,
      sortOrder: input.sortOrder,
    },
  });
}

/**
 * Warnschwelle und Zielwert müssen zur Richtung passen: bei „mehr ist besser"
 * liegt die Warnschwelle unter dem Ziel, sonst darüber. Verkehrt gesetzt
 * ergäbe die Teilnote das Gegenteil dessen, was gemeint war — still.
 */
function assertThresholds(direction: string, warn: number | null, target: number | null) {
  if (warn === null || target === null) return;
  if (direction === 'UP_IS_GOOD' && warn > target) {
    throw new BusinessRuleError('Bei „mehr ist besser" muss die Warnschwelle unter dem Zielwert liegen.');
  }
  if (direction === 'DOWN_IS_GOOD' && warn < target) {
    throw new BusinessRuleError('Bei „weniger ist besser" muss die Warnschwelle über dem Zielwert liegen.');
  }
}

export async function updateKpiDefinition(organizationId: string, id: string, input: UpdateKpiDefinitionInput) {
  const before = await prisma.kpiDefinition.findFirst({ where: { id, organizationId } });
  if (!before) throw new NotFoundError('Kennzahl');
  const direction = input.direction ?? before.direction;
  const warn = input.warnValue === undefined ? (before.warnValue === null ? null : toNumber(before.warnValue)) : input.warnValue;
  const target = input.targetValue === undefined ? (before.targetValue === null ? null : toNumber(before.targetValue)) : input.targetValue;
  assertThresholds(direction, warn, target);

  return prisma.kpiDefinition.update({
    where: { id },
    data: {
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.description !== undefined ? { description: input.description || null } : {}),
      ...(input.group !== undefined ? { group: input.group } : {}),
      ...(input.unit !== undefined ? { unit: input.unit } : {}),
      ...(input.direction !== undefined ? { direction: input.direction } : {}),
      ...(input.periods !== undefined ? { periods: input.periods as KpiPeriod[] } : {}),
      ...(input.targetValue !== undefined ? { targetValue: input.targetValue } : {}),
      ...(input.warnValue !== undefined ? { warnValue: input.warnValue } : {}),
      ...(input.healthWeight !== undefined ? { healthWeight: input.healthWeight } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
    },
  });
}

export async function deleteKpiDefinition(organizationId: string, id: string) {
  const definition = await prisma.kpiDefinition.findFirst({
    where: { id, organizationId },
    include: { _count: { select: { keyResults: true } } },
  });
  if (!definition) throw new NotFoundError('Kennzahl');
  if (definition._count.keyResults > 0) {
    throw new BusinessRuleError(
      'Diese Kennzahl misst noch Schlüsselergebnisse. Lösen Sie die Verknüpfung dort, oder deaktivieren Sie die Kennzahl statt sie zu löschen.',
    );
  }
  await prisma.kpiDefinition.delete({ where: { id } });
}

/** Manueller Wert — nur für Kennzahlen mit `source = MANUAL`. */
export async function recordManualValue(organizationId: string, id: string, input: ManualKpiValueInput) {
  const definition = await prisma.kpiDefinition.findFirst({ where: { id, organizationId } });
  if (!definition) throw new NotFoundError('Kennzahl');
  if (definition.source !== 'MANUAL') {
    throw new BusinessRuleError('Diese Kennzahl wird berechnet — ein manueller Wert würde beim nächsten Nachtlauf überschrieben.');
  }
  const bounds = periodFromKey(input.period as PeriodName, input.periodStart);
  const targetValue = await targetFor(definition.id, definition.targetValue ? toNumber(definition.targetValue) : null, bounds);
  return prisma.kpiSnapshot.upsert({
    where: { definitionId_period_periodStart: { definitionId: id, period: bounds.period, periodStart: bounds.periodStart } },
    create: {
      organizationId,
      definitionId: id,
      period: bounds.period,
      periodStart: bounds.periodStart,
      periodEnd: bounds.periodEnd,
      value: input.value,
      targetValue,
      breakdown: input.note ? { notiz: input.note } : undefined,
      provisional: false,
    },
    update: { value: input.value, targetValue, breakdown: input.note ? { notiz: input.note } : undefined, provisional: false, computedAt: new Date() },
  });
}

export async function setKpiTarget(organizationId: string, id: string, input: KpiTargetInput) {
  const definition = await prisma.kpiDefinition.findFirst({ where: { id, organizationId } });
  if (!definition) throw new NotFoundError('Kennzahl');
  const bounds = periodFromKey(input.period as PeriodName, input.periodStart);
  return prisma.kpiTarget.upsert({
    where: { definitionId_period_periodStart: { definitionId: id, period: bounds.period, periodStart: bounds.periodStart } },
    create: { definitionId: id, period: bounds.period, periodStart: bounds.periodStart, targetValue: input.targetValue, note: input.note ?? null },
    update: { targetValue: input.targetValue, note: input.note ?? null },
  });
}

export async function updateHealthWeights(organizationId: string, input: HealthWeightsInput) {
  const total = input.weights.reduce((sum, w) => sum + w.healthWeight, 0);
  if (total === 0) {
    throw new BusinessRuleError('Mindestens eine Kennzahl braucht ein Gewicht grösser als null, sonst gibt es keinen Gesundheitswert.');
  }
  await prisma.$transaction(
    input.weights.map((w) =>
      prisma.kpiDefinition.updateMany({ where: { organizationId, key: w.key }, data: { healthWeight: w.healthWeight } }),
    ),
  );
  return prisma.kpiDefinition.findMany({
    where: { organizationId, healthWeight: { gt: 0 } },
    select: { key: true, label: true, healthWeight: true },
    orderBy: { healthWeight: 'desc' },
  });
}
