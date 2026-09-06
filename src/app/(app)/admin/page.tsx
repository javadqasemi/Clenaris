import type { Metadata } from 'next';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  CircleDollarSign,
  Users,
} from 'lucide-react';

import { prisma, toNumber } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { formatCurrency, formatDate, formatNumber, formatTime } from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import {
  getCashflowForecast,
  getDashboardKpis,
  getEmployeeUtilization,
  getRevenueByService,
  getRevenueTimeSeries,
  resolveRange,
} from '@/server/services/analytics.service';
import { KpiTile } from '@/components/app/kpi-tile';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PersonAvatar } from '@/components/ui/primitives';
import {
  CashflowChart,
  RevenueTrendChart,
  ServiceRevenueChart,
  UtilizationChart,
} from '@/components/charts/lazy';
import { RangePicker } from '@/components/app/range-picker';

export const metadata: Metadata = {
  title: 'Übersicht',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

type Range = 'today' | 'week' | 'month' | 'quarter' | 'year';

export default async function AdminDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ zeitraum?: string }>;
}) {
  await requirePermission('dashboard:view');

  const params = await searchParams;
  const range = (params.zeitraum ?? 'month') as Range;
  const organizationId = await getOrganizationId();
  const period = resolveRange(range);

  const [kpis, timeSeries, serviceRevenue, utilization, cashflow, todayJobs, attention] =
    await Promise.all([
      getDashboardKpis(organizationId, range),
      getRevenueTimeSeries({
        organizationId,
        from: new Date(new Date().getFullYear(), 0, 1),
        to: new Date(),
        granularity: 'month',
      }),
      getRevenueByService({ organizationId, from: period.from, to: period.to }),
      getEmployeeUtilization({ organizationId, from: period.from, to: period.to }),
      getCashflowForecast({ organizationId, weeks: 12 }),
      loadTodayJobs(organizationId),
      loadAttentionItems(organizationId),
    ]);

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-title font-bold tracking-tight">Übersicht</h1>
          <p className="text-sm text-muted-foreground">
            {kpis.period.label} · {formatDate(kpis.period.from)} – {formatDate(kpis.period.to)}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <RangePicker current={range} />
          <Button asChild variant="outline">
            <Link href="/admin/auswertungen">
              Auswertungen
              <ArrowRight aria-hidden />
            </Link>
          </Button>
        </div>
      </header>

      {/* Handlungsbedarf zuerst — was das Team heute anpacken muss. */}
      {attention.length > 0 ? (
        <section aria-label="Handlungsbedarf" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {attention.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="group flex items-center gap-3 rounded-xl border border-warning/25 bg-warning/8 p-4 transition-colors hover:bg-warning/12"
            >
              <AlertTriangle className="size-5 shrink-0 text-warning" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold tabular-nums text-warning">{item.count}</p>
                <p className="truncate text-meta text-warning/90">{item.label}</p>
              </div>
              <ArrowRight
                className="size-4 shrink-0 text-warning transition-transform duration-200 ease-spring group-hover:translate-x-0.5"
                aria-hidden
              />
            </Link>
          ))}
        </section>
      ) : null}

      {/* Kennzahlen */}
      <section aria-label="Kennzahlen" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile
          label="Umsatz"
          value={formatCurrency(kpis.revenue.value)}
          changePercent={kpis.revenue.changePercent}
          hint="netto, ausgestellt"
          href="/admin/rechnungen"
        />
        <KpiTile
          label="Gewinn"
          value={formatCurrency(kpis.profit.value)}
          changePercent={kpis.profit.changePercent}
          hint={`Kosten ${formatCurrency(kpis.expenses.value)}`}
          href="/admin/auswertungen"
        />
        <KpiTile
          label="Offene Posten"
          value={formatCurrency(kpis.outstanding.amount)}
          hint={`${kpis.outstanding.count} Rechnungen · ${formatCurrency(kpis.outstanding.overdueAmount)} überfällig`}
          href="/admin/rechnungen?status=OVERDUE"
          accent={kpis.outstanding.overdueAmount > 0 ? 'warning' : undefined}
        />
        <KpiTile
          label="Neue Kunden"
          value={formatNumber(kpis.customers.new.value)}
          changePercent={kpis.customers.new.changePercent}
          hint={`${kpis.customers.total} insgesamt`}
          href="/admin/kunden"
        />
      </section>

      <section aria-label="Betrieb" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile
          label="Einsätze heute"
          value={formatNumber(kpis.jobs.today)}
          hint={`${kpis.jobs.inProgress} laufen gerade`}
          href="/admin/kalender"
        />
        <KpiTile
          label="Kommende Buchungen"
          value={formatNumber(kpis.bookings.upcoming)}
          hint={`${kpis.bookings.cancelled} storniert im Zeitraum`}
          href="/admin/buchungen"
        />
        <KpiTile
          label="Abschlussquote Leads"
          value={`${formatNumber(kpis.leads.conversionRate, 'de', 0)} %`}
          hint={`${formatCurrency(kpis.leads.openValue)} in der Pipeline`}
          href="/admin/leads"
        />
        <KpiTile
          label="Geleistete Stunden"
          value={formatNumber(kpis.employees.hoursThisPeriod, 'de', 1)}
          hint={`${kpis.employees.workingNow} von ${kpis.employees.active} arbeiten jetzt`}
          href="/admin/personal"
        />
      </section>

      {/* Diagramme */}
      <div className="grid gap-6 xl:grid-cols-2">
        <RevenueTrendChart data={timeSeries} className="xl:col-span-2" />
        <ServiceRevenueChart data={serviceRevenue} />
        <UtilizationChart data={utilization} />
        <CashflowChart data={cashflow} className="xl:col-span-2" />
      </div>

      {/* Heutige Einsätze */}
      <section className="rounded-2xl border border-border bg-card shadow-soft" aria-label="Einsätze heute">
        <header className="flex items-center justify-between gap-4 border-b border-border p-6">
          <div className="flex items-center gap-3">
            <CalendarClock className="size-5 text-primary" aria-hidden />
            <h2 className="font-display text-base font-semibold tracking-tight">Einsätze heute</h2>
          </div>
          <Button asChild variant="ghost" size="sm">
            <Link href="/admin/kalender">
              Kalender
              <ArrowRight aria-hidden />
            </Link>
          </Button>
        </header>

        {todayJobs.length === 0 ? (
          <p className="p-10 text-center text-sm text-muted-foreground">
            Für heute sind keine Einsätze geplant.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {todayJobs.map((job) => (
              <li key={job.id}>
                {/* Festes Raster: Uhrzeit, Auftrag, Team und Status fluchten
                    dadurch über alle Zeilen. Unter `sm` wird gestapelt. */}
                <Link
                  href={`/admin/einsaetze/${job.id}`}
                  className="grid gap-2 p-4 transition-colors hover:bg-muted/50 sm:grid-cols-[4rem_minmax(0,1fr)_auto_7rem] sm:items-center sm:gap-4 sm:px-6"
                >
                  <span className="text-sm font-semibold tabular-nums">
                    {formatTime(job.scheduledStart)}
                  </span>

                  <div className="min-w-0">
                    <p className="truncate font-medium">{job.title}</p>
                    <p className="truncate text-meta text-muted-foreground">
                      {job.address
                        ? `${job.address.street} ${job.address.streetNo ?? ''}, ${job.address.postalCode} ${job.address.city}`
                        : 'Keine Adresse hinterlegt'}
                    </p>
                  </div>

                  <div className="flex -space-x-2">
                    {job.assignments.map((assignment) => (
                      <PersonAvatar
                        key={assignment.employee.id}
                        firstName={assignment.employee.user.firstName}
                        lastName={assignment.employee.user.lastName}
                        color={assignment.employee.color}
                        size="sm"
                        className="ring-2 ring-card"
                      />
                    ))}
                    {job.assignments.length === 0 ? (
                      <span className="rounded-full bg-warning/12 px-2.5 py-1 text-xs font-medium text-warning">
                        Nicht zugeteilt
                      </span>
                    ) : null}
                  </div>

                  <StatusBadge status={job.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Umsatzstärkste Kundschaft */}
      <section className="rounded-2xl border border-border bg-card shadow-soft" aria-label="Wichtigste Kundschaft">
        <header className="flex items-center justify-between gap-4 border-b border-border p-6">
          <div className="flex items-center gap-3">
            <Users className="size-5 text-primary" aria-hidden />
            <h2 className="font-display text-base font-semibold tracking-tight">
              Umsatzstärkste Kundschaft
            </h2>
          </div>
          <Button asChild variant="ghost" size="sm">
            <Link href="/admin/kunden">
              Alle Kunden
              <ArrowRight aria-hidden />
            </Link>
          </Button>
        </header>

        <TopCustomers organizationId={organizationId} />
      </section>
    </div>
  );
}

async function TopCustomers({ organizationId }: { organizationId: string }) {
  const customers = await prisma.customer.findMany({
    where: { organizationId, deletedAt: null, lifetimeValue: { gt: 0 } },
    orderBy: { lifetimeValue: 'desc' },
    take: 5,
    select: {
      id: true,
      number: true,
      firstName: true,
      lastName: true,
      companyName: true,
      lifetimeValue: true,
      totalBookings: true,
      lastBookingAt: true,
    },
  });

  if (customers.length === 0) {
    return (
      <p className="p-10 text-center text-sm text-muted-foreground">
        Sobald die ersten Rechnungen bezahlt sind, erscheint hier die Rangliste.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-border">
      {customers.map((customer) => (
        <li key={customer.id}>
          <Link
            href={`/admin/kunden/${customer.id}`}
            className="flex items-center gap-4 p-4 transition-colors hover:bg-muted/50 sm:px-6"
          >
            <PersonAvatar firstName={customer.firstName} lastName={customer.lastName} size="sm" />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">
                {customer.companyName ?? `${customer.firstName} ${customer.lastName}`}
              </p>
              <p className="text-sm text-muted-foreground">
                {customer.number} · {customer.totalBookings} Buchungen
                {customer.lastBookingAt ? ` · zuletzt ${formatDate(customer.lastBookingAt)}` : ''}
              </p>
            </div>
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm font-semibold tabular-nums">
              <CircleDollarSign className="size-4 text-muted-foreground" aria-hidden />
              {formatCurrency(toNumber(customer.lifetimeValue))}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

async function loadTodayJobs(organizationId: string) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 86_400_000);

  return prisma.job.findMany({
    where: {
      organizationId,
      deletedAt: null,
      status: { not: 'CANCELLED' },
      scheduledStart: { gte: start, lt: end },
    },
    orderBy: { scheduledStart: 'asc' },
    take: 12,
    include: {
      address: { select: { street: true, streetNo: true, postalCode: true, city: true } },
      assignments: {
        include: {
          employee: {
            select: {
              id: true,
              color: true,
              user: { select: { firstName: true, lastName: true } },
            },
          },
        },
      },
    },
  });
}

/** Die vier Zahlen, die eine Handlung auslösen — nicht mehr. */
async function loadAttentionItems(organizationId: string) {
  const now = new Date();

  const [pendingBookings, unassignedJobs, overdueInvoices, staleLeads] = await Promise.all([
    prisma.booking.count({ where: { organizationId, deletedAt: null, status: 'PENDING' } }),
    prisma.job.count({
      where: {
        organizationId,
        deletedAt: null,
        status: 'UNASSIGNED',
        scheduledStart: { gte: now, lte: new Date(now.getTime() + 7 * 86_400_000) },
      },
    }),
    prisma.invoice.count({ where: { organizationId, deletedAt: null, status: 'OVERDUE' } }),
    prisma.lead.count({
      where: {
        organizationId,
        deletedAt: null,
        status: { in: ['NEW', 'CONTACTED'] },
        createdAt: { lt: new Date(now.getTime() - 3 * 86_400_000) },
      },
    }),
  ]);

  return [
    { count: pendingBookings, label: 'Buchungen zu bestätigen', href: '/admin/buchungen?status=PENDING' },
    { count: unassignedJobs, label: 'Einsätze ohne Team (7 Tage)', href: '/admin/kalender' },
    { count: overdueInvoices, label: 'Überfällige Rechnungen', href: '/admin/rechnungen?status=OVERDUE' },
    { count: staleLeads, label: 'Leads seit 3 Tagen offen', href: '/admin/leads' },
  ].filter((item) => item.count > 0);
}
