import 'server-only';

import { prisma, toNumber } from '@/lib/db';
import { cache, cacheKeys } from '@/lib/redis';
import { growthPercent, round2 } from '@/lib/utils';

/**
 * Kennzahlen und Auswertungen.
 *
 * Architekturentscheide:
 *  1. Alle Kennzahlen werden aus den Primärdaten aggregiert, nicht aus einer
 *     Kennzahlentabelle. Bei der Datenmenge eines KMU (< 100k Zeilen) ist das
 *     schnell genug und kann nicht auseinanderlaufen. Der 5-Minuten-Cache
 *     fängt den Dashboard-Refresh ab.
 *  2. Umsatz wird auf Basis *ausgestellter* Rechnungen ermittelt (Soll-
 *     Prinzip), nicht auf Zahlungseingängen — das entspricht der Schweizer
 *     Buchführungspraxis. Der Cashflow wird separat auf Zahlungsbasis
 *     ausgewiesen.
 *  3. Jede Kennzahl wird mit der Vorperiode verglichen, damit das Dashboard
 *     eine Richtung zeigt und nicht nur eine Zahl.
 */

export interface KpiValue {
  value: number;
  previous: number;
  changePercent: number;
}

export interface DashboardKpis {
  period: { from: string; to: string; label: string };
  revenue: KpiValue;
  revenuePaid: KpiValue;
  expenses: KpiValue;
  profit: KpiValue;
  outstanding: { amount: number; count: number; overdueAmount: number; overdueCount: number };
  bookings: { upcoming: number; completed: number; cancelled: number; total: KpiValue };
  jobs: { today: number; inProgress: number; unassigned: number };
  customers: { total: number; new: KpiValue; active: number };
  leads: { new: KpiValue; conversionRate: number; openValue: number };
  employees: { active: number; workingNow: number; hoursThisPeriod: number };
  averageOrderValue: KpiValue;
  averageRating: number;
}

type Range = 'today' | 'week' | 'month' | 'quarter' | 'year' | 'custom';

export function resolveRange(range: Range, from?: Date, to?: Date) {
  const now = new Date();
  const end = to ?? now;
  let start: Date;
  let label: string;

  switch (range) {
    case 'today':
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      label = 'Heute';
      break;
    case 'week':
      start = new Date(now.getTime() - 7 * 86_400_000);
      label = 'Letzte 7 Tage';
      break;
    case 'quarter':
      start = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
      label = 'Aktuelles Quartal';
      break;
    case 'year':
      start = new Date(now.getFullYear(), 0, 1);
      label = 'Laufendes Jahr';
      break;
    case 'custom':
      start = from ?? new Date(now.getFullYear(), now.getMonth(), 1);
      label = 'Benutzerdefiniert';
      break;
    case 'month':
    default:
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      label = 'Aktueller Monat';
  }

  const durationMs = end.getTime() - start.getTime();
  return {
    from: start,
    to: end,
    label,
    previousFrom: new Date(start.getTime() - durationMs),
    previousTo: start,
  };
}

export async function getDashboardKpis(
  organizationId: string,
  range: Range = 'month',
  customFrom?: Date,
  customTo?: Date,
): Promise<DashboardKpis> {
  const cacheKey = `${cacheKeys.dashboardKpis(organizationId, range)}:${customFrom?.getTime() ?? 0}`;

  return cache.remember(cacheKey, 300, async () => {
    const period = resolveRange(range, customFrom, customTo);
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayEnd = new Date(todayStart.getTime() + 86_400_000);

    const invoiceScope = { organizationId, deletedAt: null, status: { not: 'CANCELLED' as const } };

    const [
      revenueNow,
      revenuePrev,
      paidNow,
      paidPrev,
      expensesNow,
      expensesPrev,
      outstandingAgg,
      overdueAgg,
      bookingsNow,
      bookingsPrev,
      upcomingBookings,
      completedBookings,
      cancelledBookings,
      jobsToday,
      jobsInProgress,
      jobsUnassigned,
      customersTotal,
      customersNew,
      customersNewPrev,
      activeCustomers,
      leadsNew,
      leadsNewPrev,
      leadsWon,
      leadsTotal,
      openLeadValue,
      employeesActive,
      workingNow,
      timeAgg,
      ratingAgg,
    ] = await Promise.all([
      prisma.invoice.aggregate({
        where: { ...invoiceScope, issueDate: { gte: period.from, lte: period.to } },
        _sum: { netTotal: true },
      }),
      prisma.invoice.aggregate({
        where: { ...invoiceScope, issueDate: { gte: period.previousFrom, lt: period.previousTo } },
        _sum: { netTotal: true },
      }),
      prisma.payment.aggregate({
        where: {
          status: 'SUCCEEDED',
          paidAt: { gte: period.from, lte: period.to },
          invoice: { organizationId },
        },
        _sum: { amount: true },
      }),
      prisma.payment.aggregate({
        where: {
          status: 'SUCCEEDED',
          paidAt: { gte: period.previousFrom, lt: period.previousTo },
          invoice: { organizationId },
        },
        _sum: { amount: true },
      }),
      prisma.expense.aggregate({
        where: { organizationId, expenseDate: { gte: period.from, lte: period.to } },
        _sum: { netAmount: true },
      }),
      prisma.expense.aggregate({
        where: { organizationId, expenseDate: { gte: period.previousFrom, lt: period.previousTo } },
        _sum: { netAmount: true },
      }),
      prisma.invoice.aggregate({
        where: { organizationId, deletedAt: null, balance: { gt: 0 }, status: { notIn: ['DRAFT', 'CANCELLED'] } },
        _sum: { balance: true },
        _count: true,
      }),
      prisma.invoice.aggregate({
        where: { organizationId, deletedAt: null, balance: { gt: 0 }, status: 'OVERDUE' },
        _sum: { balance: true },
        _count: true,
      }),
      prisma.booking.count({
        where: { organizationId, deletedAt: null, createdAt: { gte: period.from, lte: period.to } },
      }),
      prisma.booking.count({
        where: {
          organizationId,
          deletedAt: null,
          createdAt: { gte: period.previousFrom, lt: period.previousTo },
        },
      }),
      prisma.booking.count({
        where: {
          organizationId,
          deletedAt: null,
          status: { in: ['PENDING', 'CONFIRMED'] },
          scheduledStart: { gte: now },
        },
      }),
      prisma.booking.count({
        where: {
          organizationId,
          deletedAt: null,
          status: 'COMPLETED',
          completedAt: { gte: period.from, lte: period.to },
        },
      }),
      prisma.booking.count({
        where: {
          organizationId,
          deletedAt: null,
          status: 'CANCELLED',
          cancelledAt: { gte: period.from, lte: period.to },
        },
      }),
      prisma.job.count({
        where: {
          organizationId,
          deletedAt: null,
          status: { notIn: ['CANCELLED'] },
          scheduledStart: { gte: todayStart, lt: todayEnd },
        },
      }),
      prisma.job.count({ where: { organizationId, deletedAt: null, status: 'IN_PROGRESS' } }),
      prisma.job.count({
        where: {
          organizationId,
          deletedAt: null,
          status: 'UNASSIGNED',
          scheduledStart: { gte: now },
        },
      }),
      prisma.customer.count({ where: { organizationId, deletedAt: null } }),
      prisma.customer.count({
        where: { organizationId, deletedAt: null, createdAt: { gte: period.from, lte: period.to } },
      }),
      prisma.customer.count({
        where: {
          organizationId,
          deletedAt: null,
          createdAt: { gte: period.previousFrom, lt: period.previousTo },
        },
      }),
      prisma.customer.count({
        where: {
          organizationId,
          deletedAt: null,
          lastBookingAt: { gte: new Date(now.getTime() - 365 * 86_400_000) },
        },
      }),
      prisma.lead.count({
        where: { organizationId, deletedAt: null, createdAt: { gte: period.from, lte: period.to } },
      }),
      prisma.lead.count({
        where: {
          organizationId,
          deletedAt: null,
          createdAt: { gte: period.previousFrom, lt: period.previousTo },
        },
      }),
      prisma.lead.count({
        where: {
          organizationId,
          deletedAt: null,
          status: 'WON',
          convertedAt: { gte: period.from, lte: period.to },
        },
      }),
      prisma.lead.count({
        where: {
          organizationId,
          deletedAt: null,
          createdAt: { gte: period.from, lte: period.to },
          status: { in: ['WON', 'LOST'] },
        },
      }),
      prisma.lead.aggregate({
        where: { organizationId, deletedAt: null, status: { notIn: ['WON', 'LOST'] } },
        _sum: { estimatedValue: true },
      }),
      prisma.employee.count({ where: { organizationId, active: true } }),
      prisma.timeEntry.count({
        where: { endedAt: null, employee: { organizationId } },
      }),
      prisma.timeEntry.aggregate({
        where: {
          employee: { organizationId },
          startedAt: { gte: period.from, lte: period.to },
          endedAt: { not: null },
        },
        _sum: { minutes: true },
      }),
      prisma.review.aggregate({
        where: { organizationId, status: 'PUBLISHED' },
        _avg: { rating: true },
      }),
    ]);

    const revenue = toNumber(revenueNow._sum.netTotal);
    const revenuePrevious = toNumber(revenuePrev._sum.netTotal);
    const expenses = toNumber(expensesNow._sum.netAmount);
    const expensesPrevious = toNumber(expensesPrev._sum.netAmount);

    const kpi = (value: number, previous: number): KpiValue => ({
      value: round2(value),
      previous: round2(previous),
      changePercent: growthPercent(value, previous),
    });

    return {
      period: {
        from: period.from.toISOString(),
        to: period.to.toISOString(),
        label: period.label,
      },
      revenue: kpi(revenue, revenuePrevious),
      revenuePaid: kpi(toNumber(paidNow._sum.amount), toNumber(paidPrev._sum.amount)),
      expenses: kpi(expenses, expensesPrevious),
      profit: kpi(revenue - expenses, revenuePrevious - expensesPrevious),
      outstanding: {
        amount: round2(toNumber(outstandingAgg._sum.balance)),
        count: outstandingAgg._count,
        overdueAmount: round2(toNumber(overdueAgg._sum.balance)),
        overdueCount: overdueAgg._count,
      },
      bookings: {
        upcoming: upcomingBookings,
        completed: completedBookings,
        cancelled: cancelledBookings,
        total: kpi(bookingsNow, bookingsPrev),
      },
      jobs: { today: jobsToday, inProgress: jobsInProgress, unassigned: jobsUnassigned },
      customers: {
        total: customersTotal,
        new: kpi(customersNew, customersNewPrev),
        active: activeCustomers,
      },
      leads: {
        new: kpi(leadsNew, leadsNewPrev),
        conversionRate: leadsTotal > 0 ? round2((leadsWon / leadsTotal) * 100) : 0,
        openValue: round2(toNumber(openLeadValue._sum.estimatedValue)),
      },
      employees: {
        active: employeesActive,
        workingNow,
        hoursThisPeriod: round2((timeAgg._sum.minutes ?? 0) / 60),
      },
      averageOrderValue: kpi(
        bookingsNow > 0 ? revenue / bookingsNow : 0,
        bookingsPrev > 0 ? revenuePrevious / bookingsPrev : 0,
      ),
      averageRating: round2(ratingAgg._avg.rating ?? 0),
    };
  });
}

// ---------------------------------------------------------------------------
//  Zeitreihen
// ---------------------------------------------------------------------------

export interface TimeSeriesPoint {
  period: string;
  label: string;
  revenue: number;
  expenses: number;
  profit: number;
  bookings: number;
  newCustomers: number;
}

/**
 * Umsatz-, Kosten- und Buchungsverlauf.
 * Wir gruppieren in SQL (`date_trunc`), damit auch bei mehreren Jahren nur
 * eine Zeile pro Periode über die Leitung geht.
 */
export async function getRevenueTimeSeries(params: {
  organizationId: string;
  from: Date;
  to: Date;
  granularity: 'day' | 'week' | 'month' | 'quarter' | 'year';
}): Promise<TimeSeriesPoint[]> {
  const { organizationId, from, to, granularity } = params;

  const [revenueRows, expenseRows, bookingRows, customerRows] = await Promise.all([
    prisma.$queryRaw<{ bucket: Date; total: number }[]>`
      SELECT date_trunc(${granularity}, "issueDate")::timestamptz AS bucket,
             COALESCE(SUM("netTotal"), 0)::float8 AS total
      FROM invoices
      WHERE "organizationId" = ${organizationId}
        AND "deletedAt" IS NULL
        AND status <> 'CANCELLED'
        AND "issueDate" BETWEEN ${from} AND ${to}
      GROUP BY 1 ORDER BY 1
    `,
    prisma.$queryRaw<{ bucket: Date; total: number }[]>`
      SELECT date_trunc(${granularity}, "expenseDate")::timestamptz AS bucket,
             COALESCE(SUM("netAmount"), 0)::float8 AS total
      FROM expenses
      WHERE "organizationId" = ${organizationId}
        AND "expenseDate" BETWEEN ${from} AND ${to}
      GROUP BY 1 ORDER BY 1
    `,
    prisma.$queryRaw<{ bucket: Date; total: bigint }[]>`
      SELECT date_trunc(${granularity}, "createdAt")::timestamptz AS bucket,
             COUNT(*) AS total
      FROM bookings
      WHERE "organizationId" = ${organizationId}
        AND "deletedAt" IS NULL
        AND "createdAt" BETWEEN ${from} AND ${to}
      GROUP BY 1 ORDER BY 1
    `,
    prisma.$queryRaw<{ bucket: Date; total: bigint }[]>`
      SELECT date_trunc(${granularity}, "createdAt")::timestamptz AS bucket,
             COUNT(*) AS total
      FROM customers
      WHERE "organizationId" = ${organizationId}
        AND "deletedAt" IS NULL
        AND "createdAt" BETWEEN ${from} AND ${to}
      GROUP BY 1 ORDER BY 1
    `,
  ]);

  const buckets = new Map<string, TimeSeriesPoint>();

  const ensure = (date: Date): TimeSeriesPoint => {
    const key = date.toISOString();
    if (!buckets.has(key)) {
      buckets.set(key, {
        period: key,
        label: formatBucketLabel(date, granularity),
        revenue: 0,
        expenses: 0,
        profit: 0,
        bookings: 0,
        newCustomers: 0,
      });
    }
    return buckets.get(key)!;
  };

  for (const row of revenueRows) ensure(row.bucket).revenue = round2(row.total);
  for (const row of expenseRows) ensure(row.bucket).expenses = round2(row.total);
  for (const row of bookingRows) ensure(row.bucket).bookings = Number(row.total);
  for (const row of customerRows) ensure(row.bucket).newCustomers = Number(row.total);

  return [...buckets.values()]
    .map((point) => ({ ...point, profit: round2(point.revenue - point.expenses) }))
    .sort((a, b) => a.period.localeCompare(b.period));
}

function formatBucketLabel(date: Date, granularity: string): string {
  const options: Record<string, Intl.DateTimeFormatOptions> = {
    day: { day: '2-digit', month: 'short' },
    week: { day: '2-digit', month: 'short' },
    month: { month: 'short', year: '2-digit' },
    quarter: { month: 'short', year: '2-digit' },
    year: { year: 'numeric' },
  };
  return new Intl.DateTimeFormat('de-CH', {
    timeZone: 'Europe/Zurich',
    ...(options[granularity] ?? options.month),
  }).format(date);
}

// ---------------------------------------------------------------------------
//  Detailauswertungen
// ---------------------------------------------------------------------------

export async function getRevenueByService(params: {
  organizationId: string;
  from: Date;
  to: Date;
}) {
  const rows = await prisma.$queryRaw<
    { name: string; kind: string; revenue: number; jobs: bigint }[]
  >`
    SELECT s.name,
           s.kind::text AS kind,
           COALESCE(SUM(bi."lineTotal"), 0)::float8 AS revenue,
           COUNT(DISTINCT b.id) AS jobs
    FROM booking_items bi
    JOIN bookings b ON b.id = bi."bookingId"
    JOIN services s ON s.id = bi."serviceId"
    WHERE b."organizationId" = ${params.organizationId}
      AND b."deletedAt" IS NULL
      AND b.status <> 'CANCELLED'
      AND b."scheduledStart" BETWEEN ${params.from} AND ${params.to}
    GROUP BY s.id, s.name, s.kind
    ORDER BY revenue DESC
  `;

  const total = rows.reduce((sum, row) => sum + row.revenue, 0);

  return rows.map((row) => ({
    name: row.name,
    kind: row.kind,
    revenue: round2(row.revenue),
    jobs: Number(row.jobs),
    share: total > 0 ? round2((row.revenue / total) * 100) : 0,
  }));
}

export async function getTopCustomers(params: {
  organizationId: string;
  limit?: number;
}) {
  return prisma.customer.findMany({
    where: { organizationId: params.organizationId, deletedAt: null },
    orderBy: { lifetimeValue: 'desc' },
    take: params.limit ?? 10,
    select: {
      id: true,
      number: true,
      firstName: true,
      lastName: true,
      companyName: true,
      type: true,
      lifetimeValue: true,
      totalBookings: true,
      lastBookingAt: true,
    },
  });
}

export async function getEmployeeUtilization(params: {
  organizationId: string;
  from: Date;
  to: Date;
}) {
  const rows = await prisma.$queryRaw<
    { id: string; name: string; minutes: number; jobs: bigint; laborCost: number }[]
  >`
    SELECT e.id,
           u."firstName" || ' ' || u."lastName" AS name,
           COALESCE(SUM(te.minutes), 0)::float8 AS minutes,
           COUNT(DISTINCT te."jobId") AS jobs,
           COALESCE(SUM(te.minutes / 60.0 * COALESCE(te."hourlyRate", 0)), 0)::float8 AS "laborCost"
    FROM employees e
    JOIN users u ON u.id = e."userId"
    LEFT JOIN time_entries te
      ON te."employeeId" = e.id
     AND te."startedAt" BETWEEN ${params.from} AND ${params.to}
     AND te."endedAt" IS NOT NULL
    WHERE e."organizationId" = ${params.organizationId}
      AND e.active = true
    GROUP BY e.id, u."firstName", u."lastName"
    ORDER BY minutes DESC
  `;

  // Sollarbeitszeit im Zeitraum (Annahme: 8.4 h an Werktagen, 100 % Pensum).
  const workdays = countWorkdays(params.from, params.to);
  const targetMinutes = workdays * 8.4 * 60;

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    hours: round2(row.minutes / 60),
    jobs: Number(row.jobs),
    laborCost: round2(row.laborCost),
    utilizationPercent: targetMinutes > 0 ? round2((row.minutes / targetMinutes) * 100) : 0,
  }));
}

function countWorkdays(from: Date, to: Date): number {
  let count = 0;
  const cursor = new Date(from);
  while (cursor <= to) {
    const day = cursor.getDay();
    if (day !== 0 && day !== 6) count++;
    cursor.setDate(cursor.getDate() + 1);
  }
  return count;
}

/** Erfolgsrechnung nach Kostenkategorie. */
export async function getProfitAndLoss(params: {
  organizationId: string;
  from: Date;
  to: Date;
}) {
  const [revenue, expensesByCategory, laborCost] = await Promise.all([
    prisma.invoice.aggregate({
      where: {
        organizationId: params.organizationId,
        deletedAt: null,
        status: { not: 'CANCELLED' },
        issueDate: { gte: params.from, lte: params.to },
      },
      _sum: { netTotal: true, vatAmount: true },
    }),
    prisma.expense.groupBy({
      by: ['category'],
      where: {
        organizationId: params.organizationId,
        expenseDate: { gte: params.from, lte: params.to },
      },
      _sum: { netAmount: true, vatAmount: true },
    }),
    prisma.$queryRaw<{ total: number }[]>`
      SELECT COALESCE(SUM(te.minutes / 60.0 * COALESCE(te."hourlyRate", 0)), 0)::float8 AS total
      FROM time_entries te
      JOIN employees e ON e.id = te."employeeId"
      WHERE e."organizationId" = ${params.organizationId}
        AND te."startedAt" BETWEEN ${params.from} AND ${params.to}
        AND te."endedAt" IS NOT NULL
    `,
  ]);

  const revenueNet = round2(toNumber(revenue._sum.netTotal));
  const expenses = expensesByCategory.map((row) => ({
    category: row.category,
    amount: round2(toNumber(row._sum.netAmount)),
    vat: round2(toNumber(row._sum.vatAmount)),
  }));

  const expenseTotal = round2(expenses.reduce((sum, row) => sum + row.amount, 0));
  const labor = round2(laborCost[0]?.total ?? 0);

  return {
    period: { from: params.from.toISOString(), to: params.to.toISOString() },
    revenue: { net: revenueNet, vat: round2(toNumber(revenue._sum.vatAmount)) },
    expenses,
    expenseTotal,
    laborCost: labor,
    grossProfit: round2(revenueNet - labor),
    operatingProfit: round2(revenueNet - expenseTotal),
    marginPercent: revenueNet > 0 ? round2(((revenueNet - expenseTotal) / revenueNet) * 100) : 0,
  };
}

/** MWST-Abrechnung (Saldo aus Umsatz- und Vorsteuer). */
export async function getVatReport(params: {
  organizationId: string;
  from: Date;
  to: Date;
}) {
  const [output, input] = await Promise.all([
    prisma.invoice.groupBy({
      by: ['status'],
      where: {
        organizationId: params.organizationId,
        deletedAt: null,
        status: { not: 'CANCELLED' },
        issueDate: { gte: params.from, lte: params.to },
      },
      _sum: { netTotal: true, vatAmount: true },
    }),
    prisma.expense.aggregate({
      where: {
        organizationId: params.organizationId,
        vatDeductible: true,
        expenseDate: { gte: params.from, lte: params.to },
      },
      _sum: { netAmount: true, vatAmount: true },
    }),
  ]);

  const outputVat = round2(
    output.reduce((sum, row) => sum + toNumber(row._sum.vatAmount), 0),
  );
  const outputNet = round2(output.reduce((sum, row) => sum + toNumber(row._sum.netTotal), 0));
  const inputVat = round2(toNumber(input._sum.vatAmount));

  return {
    period: { from: params.from.toISOString(), to: params.to.toISOString() },
    turnoverNet: outputNet,
    outputVat,
    inputVat,
    payable: round2(outputVat - inputVat),
    note:
      'Provisorische Auswertung nach vereinbarten Entgelten (Soll-Prinzip). Die definitive Abrechnung erstellt Ihre Treuhandstelle.',
  };
}

/** Liquiditätsvorschau: fällige Rechnungen und geplante Umsätze. */
export async function getCashflowForecast(params: {
  organizationId: string;
  weeks?: number;
}) {
  const weeks = params.weeks ?? 12;
  const horizon = new Date(Date.now() + weeks * 7 * 86_400_000);

  const [receivables, upcomingJobs, plannedExpenses] = await Promise.all([
    prisma.invoice.findMany({
      where: {
        organizationId: params.organizationId,
        deletedAt: null,
        balance: { gt: 0 },
        status: { notIn: ['DRAFT', 'CANCELLED'] },
        dueDate: { lte: horizon },
      },
      select: { dueDate: true, balance: true },
    }),
    prisma.booking.findMany({
      where: {
        organizationId: params.organizationId,
        deletedAt: null,
        status: { in: ['CONFIRMED', 'PENDING'] },
        scheduledStart: { gte: new Date(), lte: horizon },
      },
      select: { scheduledStart: true, grossTotal: true },
    }),
    prisma.expense.findMany({
      where: {
        organizationId: params.organizationId,
        paid: false,
        expenseDate: { lte: horizon },
      },
      select: { expenseDate: true, grossAmount: true },
    }),
  ]);

  const buckets = new Map<string, { week: string; inflow: number; outflow: number }>();

  const weekKey = (date: Date) => {
    const monday = new Date(date);
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    monday.setHours(0, 0, 0, 0);
    return monday.toISOString().slice(0, 10);
  };

  const ensure = (date: Date) => {
    const key = weekKey(date);
    if (!buckets.has(key)) buckets.set(key, { week: key, inflow: 0, outflow: 0 });
    return buckets.get(key)!;
  };

  for (const invoice of receivables) {
    ensure(invoice.dueDate).inflow += toNumber(invoice.balance);
  }
  for (const booking of upcomingJobs) {
    // Zahlungseingang typischerweise 30 Tage nach Leistung.
    ensure(new Date(booking.scheduledStart.getTime() + 30 * 86_400_000)).inflow += toNumber(
      booking.grossTotal,
    );
  }
  for (const expense of plannedExpenses) {
    ensure(expense.expenseDate).outflow += toNumber(expense.grossAmount);
  }

  let cumulative = 0;
  return [...buckets.values()]
    .sort((a, b) => a.week.localeCompare(b.week))
    .map((bucket) => {
      const net = round2(bucket.inflow - bucket.outflow);
      cumulative = round2(cumulative + net);
      return {
        week: bucket.week,
        inflow: round2(bucket.inflow),
        outflow: round2(bucket.outflow),
        net,
        cumulative,
      };
    });
}
