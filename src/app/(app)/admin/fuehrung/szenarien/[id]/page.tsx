import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Calculator } from 'lucide-react';

import { requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { toNumber } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';
import { formatCurrency, formatDateTime } from '@/lib/utils';
import { SCENARIO_KIND_LABELS, optionsOf } from '@/lib/bi/labels';
import type { ScenarioResult } from '@/lib/bi/math';
import { getOrganizationId } from '@/server/services/organization.service';
import { getScenario } from '@/server/services/scenario.service';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { KpiTile } from '@/components/app/kpi-tile';
import { ListCard, PageHeader, TableScroll } from '@/components/app/page-parts';
import { ScenarioChart } from '@/components/charts/lazy';
import { ActionButton } from '@/features/fuehrung/action-button';
import { FormDialog } from '@/features/fuehrung/resource-form';
import { ScenarioEditor } from '@/features/fuehrung/scenario-editor';

export const metadata: Metadata = {
  title: 'Szenario',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function ScenarioDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission('scenario:read');
  const { id } = await params;
  const organizationId = await getOrganizationId();
  const scenario = await getScenario(organizationId, id).catch((error) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const result = scenario.result as unknown as ScenarioResult | null;
  const canManage = can(session.role, 'scenario:manage');

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-3">
        <Link href="/admin/fuehrung/szenarien">
          <ArrowLeft aria-hidden />
          Alle Szenarien
        </Link>
      </Button>

      <PageHeader
        title={scenario.name}
        description={`${SCENARIO_KIND_LABELS[scenario.kind]} · Geschäftsjahr ${scenario.fiscalYear} · ${scenario.horizonMonths} Monate · Startliquidität ${formatCurrency(toNumber(scenario.openingCash))}${scenario.computedAt ? ` · gerechnet ${formatDateTime(scenario.computedAt)}` : ''}`}
        actions={
          <>
            <Badge variant={scenario.kind === 'BEST' ? 'success' : scenario.kind === 'WORST' ? 'destructive' : 'default'}>{SCENARIO_KIND_LABELS[scenario.kind]}</Badge>
            {canManage ? (
              <>
                <ActionButton endpoint={`/api/bi/scenarios/${id}/compute`} label="Neu rechnen" successMessage="Szenario neu gerechnet.">
                  <Calculator aria-hidden />
                </ActionButton>
                <FormDialog
                  title="Szenario bearbeiten"
                  triggerLabel="Bearbeiten"
                  triggerVariant="outline"
                  plainTrigger
                  endpoint={`/api/bi/scenarios/${id}`}
                  method="PATCH"
                  successMessage="Szenario gespeichert."
                  fields={[
                    { name: 'name', label: 'Bezeichnung', required: true },
                    { name: 'kind', label: 'Art', type: 'select', required: true, half: true, options: optionsOf(SCENARIO_KIND_LABELS) },
                    { name: 'fiscalYear', label: 'Geschäftsjahr', type: 'number', required: true, half: true },
                    { name: 'horizonMonths', label: 'Horizont', type: 'number', required: true, half: true, suffix: 'Monate' },
                    { name: 'openingCash', label: 'Startliquidität', type: 'number', required: true, half: true, suffix: 'CHF' },
                    { name: 'description', label: 'Beschreibung', type: 'textarea', rows: 2, nullable: true },
                  ]}
                  values={{ name: scenario.name, kind: scenario.kind, fiscalYear: scenario.fiscalYear, horizonMonths: scenario.horizonMonths, openingCash: toNumber(scenario.openingCash), description: scenario.description }}
                />
                <ActionButton endpoint={`/api/bi/scenarios/${id}`} method="DELETE" label="Löschen" confirm="Das Szenario wandert in den Papierkorb." variant="ghost" redirectTo="/admin/fuehrung/szenarien" />
              </>
            ) : null}
          </>
        }
      />

      {result ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <KpiTile label="Umsatz im Horizont" value={formatCurrency(result.totals.revenue)} hint={result.totals.contributionMarginPct !== null ? `Deckungsbeitrag ${result.totals.contributionMarginPct} %` : undefined} />
          <KpiTile label="Ergebnis" value={formatCurrency(result.totals.result)} accent={result.totals.result < 0 ? 'destructive' : undefined} hint={result.breakEvenMonth ? `Break-even in Monat ${result.breakEvenMonth}` : 'Kein Break-even im Horizont'} />
          <KpiTile label="Liquiditätstiefpunkt" value={formatCurrency(result.liquidityLow.cash)} accent={result.liquidityLow.cash < 0 ? 'destructive' : result.liquidityLow.cash < toNumber(scenario.openingCash) * 0.25 ? 'warning' : undefined} hint={`Monat ${result.liquidityLow.month} · Ende ${formatCurrency(result.closingCash)}`} />
          <KpiTile label="Benötigt" value={`${result.peakEmployees} VZÄ`} hint={`${result.peakCustomers} Kundschaft · Break-even-Umsatz ${result.breakEvenRevenue ? formatCurrency(result.breakEvenRevenue) : '—'} / Monat`} />
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="space-y-6">
          <ScenarioChart data={result?.months.map((m) => ({ month: m.month, revenue: m.revenue, result: m.result, cash: m.cash })) ?? []} />
          {result ? (
            <ListCard title="Monatswerte">
              <TableScroll minWidth="60rem">
                <table className="data-table">
                  <caption className="sr-only">Szenario je Monat</caption>
                  <thead>
                    <tr>
                      <th scope="col">Monat</th>
                      <th scope="col" className="text-right">Aufträge</th>
                      <th scope="col" className="text-right">Umsatz</th>
                      <th scope="col" className="text-right">Variabel</th>
                      <th scope="col" className="text-right">Fixkosten</th>
                      <th scope="col" className="text-right">Ergebnis</th>
                      <th scope="col" className="text-right">Kumuliert</th>
                      <th scope="col" className="text-right">Liquidität</th>
                      <th scope="col" className="text-right">VZÄ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.months.map((m) => (
                      <tr key={m.month}>
                        <td>M{m.month}</td>
                        <td className="num">{m.jobs}</td>
                        <td className="num">{formatCurrency(m.revenue)}</td>
                        <td className="num text-muted-foreground">{formatCurrency(m.variableCost)}</td>
                        <td className="num text-muted-foreground">{formatCurrency(m.overhead)}</td>
                        <td className={`num ${m.result < 0 ? 'text-destructive' : ''}`}>{formatCurrency(m.result)}</td>
                        <td className={`num ${m.cumulativeResult < 0 ? 'text-destructive' : 'text-success'}`}>{formatCurrency(m.cumulativeResult)}</td>
                        <td className={`num font-medium ${m.cash < 0 ? 'text-destructive' : ''}`}>{formatCurrency(m.cash)}</td>
                        <td className="num text-muted-foreground">{m.employeesRequired}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            </ListCard>
          ) : null}
        </div>
        <ScenarioEditor scenarioId={id} assumptions={scenario.assumptions.map((a) => ({ key: a.key, label: a.label, value: toNumber(a.value), unit: a.unit, monthlyChangePct: toNumber(a.monthlyChangePct), sortOrder: a.sortOrder }))} canEdit={canManage} />
      </div>
    </div>
  );
}
