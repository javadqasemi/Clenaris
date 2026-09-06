import type { Metadata } from 'next';
import { Download, FileSpreadsheet } from 'lucide-react';

import { requirePermission } from '@/lib/auth/session';
import { formatCurrency, formatDate, formatNumber } from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import {
  getCashflowForecast,
  getEmployeeUtilization,
  getProfitAndLoss,
  getRevenueByService,
  getRevenueTimeSeries,
  getTopCustomers,
  getVatReport,
  resolveRange,
} from '@/server/services/analytics.service';
import { toNumber } from '@/lib/db';
import { Button } from '@/components/ui/button';
import { RangePicker } from '@/components/app/range-picker';
import { DetailRow, DetailSection, PageHeader } from '@/components/app/page-parts';
import {
  CashflowChart,
  RevenueTrendChart,
  ServiceRevenueChart,
  UtilizationChart,
} from '@/components/charts/lazy';
import { ExportPanel } from '@/features/admin/export-panel';

export const metadata: Metadata = {
  title: 'Auswertungen',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const EXPENSE_LABELS: Record<string, string> = {
  MATERIAL: 'Material',
  EQUIPMENT: 'Geräte',
  VEHICLE: 'Fahrzeuge',
  FUEL: 'Treibstoff',
  INSURANCE: 'Versicherungen',
  RENT: 'Miete',
  SALARY: 'Löhne',
  SOCIAL_SECURITY: 'Sozialversicherungen',
  MARKETING: 'Marketing',
  SOFTWARE: 'Software',
  TRAINING: 'Weiterbildung',
  TAXES: 'Steuern',
  OTHER: 'Übriges',
};

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ zeitraum?: string }>;
}) {
  await requirePermission('report:read');

  const params = await searchParams;
  const range = (params.zeitraum ?? 'year') as 'month' | 'quarter' | 'year';
  const organizationId = await getOrganizationId();
  const period = resolveRange(range);

  const [timeSeries, serviceRevenue, utilization, cashflow, pnl, vat, topCustomers] =
    await Promise.all([
      getRevenueTimeSeries({
        organizationId,
        from: period.from,
        to: period.to,
        granularity: range === 'year' ? 'month' : 'week',
      }),
      getRevenueByService({ organizationId, from: period.from, to: period.to }),
      getEmployeeUtilization({ organizationId, from: period.from, to: period.to }),
      getCashflowForecast({ organizationId, weeks: 12 }),
      getProfitAndLoss({ organizationId, from: period.from, to: period.to }),
      getVatReport({ organizationId, from: period.from, to: period.to }),
      getTopCustomers({ organizationId, limit: 10 }),
    ]);

  const fromIso = period.from.toISOString().slice(0, 10);
  const toIso = period.to.toISOString().slice(0, 10);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Auswertungen"
        description={`${period.label} · ${formatDate(period.from)} – ${formatDate(period.to)}`}
        actions={
          <>
            <RangePicker current={range} />
            <Button asChild variant="outline">
              <a href={`/api/exports/rechnungen?from=${fromIso}&to=${toIso}`} download>
                <Download aria-hidden />
                Rechnungen
              </a>
            </Button>
          </>
        }
      />

      {/* Diagramme */}
      <div className="grid gap-6 xl:grid-cols-2">
        <RevenueTrendChart data={timeSeries} className="xl:col-span-2" />
        <ServiceRevenueChart data={serviceRevenue} />
        <UtilizationChart data={utilization} />
        <CashflowChart data={cashflow} className="xl:col-span-2" />
      </div>

      {/* Erfolgsrechnung */}
      <div className="grid gap-6 lg:grid-cols-2">
        <DetailSection title="Erfolgsrechnung (vereinfacht)">
          <dl className="protocol-list">
            <DetailRow label="Umsatz netto">{formatCurrency(pnl.revenue.net)}</DetailRow>
            <DetailRow label="Lohnkosten (erfasst)">{formatCurrency(pnl.laborCost)}</DetailRow>
            <DetailRow label="Bruttogewinn">
              <span className={pnl.grossProfit >= 0 ? 'text-success' : 'text-destructive'}>
                {formatCurrency(pnl.grossProfit)}
              </span>
            </DetailRow>

            {pnl.expenses.map((expense) => (
              <DetailRow key={expense.category} label={EXPENSE_LABELS[expense.category] ?? expense.category}>
                <span className="text-muted-foreground">− {formatCurrency(expense.amount)}</span>
              </DetailRow>
            ))}

            <DetailRow label="Aufwand total">{formatCurrency(pnl.expenseTotal)}</DetailRow>
            <DetailRow label="Betriebsergebnis">
              <span
                className={
                  pnl.operatingProfit >= 0
                    ? 'font-display text-lg font-bold text-success'
                    : 'font-display text-lg font-bold text-destructive'
                }
              >
                {formatCurrency(pnl.operatingProfit)}
              </span>
            </DetailRow>
            <DetailRow label="Marge">{formatNumber(pnl.marginPercent, 'de', 1)} %</DetailRow>
          </dl>
        </DetailSection>

        <DetailSection title="Mehrwertsteuer">
          <dl className="protocol-list">
            <DetailRow label="Steuerbarer Umsatz">{formatCurrency(vat.turnoverNet)}</DetailRow>
            <DetailRow label="Umsatzsteuer (geschuldet)">{formatCurrency(vat.outputVat)}</DetailRow>
            <DetailRow label="Vorsteuer (abziehbar)">
              <span className="text-success">− {formatCurrency(vat.inputVat)}</span>
            </DetailRow>
            <DetailRow label="Saldo an die ESTV">
              <span className="font-display text-lg font-bold">{formatCurrency(vat.payable)}</span>
            </DetailRow>
          </dl>
          <p className="py-4 text-sm leading-relaxed text-muted-foreground">{vat.note}</p>
        </DetailSection>
      </div>

      {/* Wichtigste Kundschaft */}
      <DetailSection title="Umsatzstärkste Kundschaft">
        <div className="overflow-x-auto py-2">
          <table className="data-table data-table--sticky">
            <caption className="sr-only">Offene Posten nach Kundschaft</caption>
            <thead>
              <tr>
                <th scope="col">Kundschaft</th>
                <th scope="col">Nummer</th>
                <th scope="col" className="text-right">
                  Buchungen
                </th>
                <th scope="col" className="text-right">
                  Umsatz total
                </th>
                <th scope="col">Zuletzt</th>
              </tr>
            </thead>
            <tbody>
              {topCustomers.map((customer) => (
                <tr key={customer.id}>
                  <td className="font-medium">
                    {customer.companyName ?? `${customer.firstName} ${customer.lastName}`}
                  </td>
                  <td className="tabular-nums text-muted-foreground">{customer.number}</td>
                  <td className="num">{customer.totalBookings}</td>
                  <td className="num font-medium">
                    {formatCurrency(toNumber(customer.lifetimeValue))}
                  </td>
                  <td className="text-muted-foreground">
                    {customer.lastBookingAt ? formatDate(customer.lastBookingAt) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DetailSection>

      {/* Exporte */}
      <DetailSection
        title="Exporte"
        action={<FileSpreadsheet className="size-4 text-muted-foreground" aria-hidden />}
      >
        <ExportPanel defaultFrom={fromIso} defaultTo={toIso} />
      </DetailSection>
    </div>
  );
}
