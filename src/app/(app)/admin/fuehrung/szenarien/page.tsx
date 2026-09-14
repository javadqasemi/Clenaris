import type { Metadata } from 'next';
import Link from 'next/link';
import { GitFork } from 'lucide-react';

import { requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { formatCurrency } from '@/lib/utils';
import { SCENARIO_KIND_LABELS, optionsOf } from '@/lib/bi/labels';
import type { ScenarioResult } from '@/lib/bi/math';
import { getOrganizationId } from '@/server/services/organization.service';
import { compareScenarios, listScenarios } from '@/server/services/scenario.service';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ListCard, PageHeader, TableScroll } from '@/components/app/page-parts';
import { FormDialog } from '@/features/fuehrung/resource-form';

export const metadata: Metadata = {
  title: 'Szenarien',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const KIND_VARIANT: Record<string, 'success' | 'default' | 'destructive'> = { BEST: 'success', EXPECTED: 'default', WORST: 'destructive' };

export default async function ScenariosPage({ searchParams }: { searchParams: Promise<{ jahr?: string }> }) {
  const session = await requirePermission('scenario:read');
  const params = await searchParams;
  const organizationId = await getOrganizationId();
  const scenarios = await listScenarios(organizationId, {});
  const years = [...new Set(scenarios.map((s) => s.fiscalYear))].sort((a, b) => b - a);
  const year = Number(params.jahr) || years[0] || new Date().getFullYear() + 1;
  const compare = scenarios.length > 0 ? await compareScenarios(organizationId, { fiscalYear: year }) : [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Szenarien"
        description="Bester, erwarteter und schlechtester Fall aus denselben Treibern. Gerechnet wird monatsweise — Umsatz, Deckungsbeitrag, Ergebnis und Liquidität mit Zahlungsverzug."
        actions={
          can(session.role, 'scenario:manage') ? (
            <FormDialog
              title="Szenario anlegen"
              description="Die Annahmen werden aus den letzten zwölf Monaten vorbelegt und lassen sich danach anpassen."
              triggerLabel="Szenario"
              endpoint="/api/bi/scenarios"
              successMessage="Szenario angelegt und gerechnet."
              redirectTo="/admin/fuehrung/szenarien/{id}"
              fields={[
                { name: 'name', label: 'Bezeichnung', required: true, placeholder: `Erwarteter Fall ${year}` },
                { name: 'kind', label: 'Art', type: 'select', required: true, half: true, options: optionsOf(SCENARIO_KIND_LABELS) },
                { name: 'fiscalYear', label: 'Geschäftsjahr', type: 'number', required: true, half: true },
                { name: 'horizonMonths', label: 'Horizont', type: 'number', required: true, half: true, suffix: 'Monate' },
                { name: 'openingCash', label: 'Startliquidität', type: 'number', required: true, half: true, suffix: 'CHF' },
                { name: 'description', label: 'Beschreibung', type: 'textarea', rows: 2 },
              ]}
              values={{ kind: 'EXPECTED', fiscalYear: year, horizonMonths: 12, openingCash: 0 }}
            />
          ) : null
        }
      >
        {years.length > 1 ? (
          <nav className="flex flex-wrap gap-2" aria-label="Jahr">
            {years.map((y) => (
              <Link key={y} href={`/admin/fuehrung/szenarien?jahr=${y}`} className={`rounded-full border px-3 py-1 text-sm ${y === year ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}>
                {y}
              </Link>
            ))}
          </nav>
        ) : null}
      </PageHeader>

      {scenarios.length === 0 ? (
        <EmptyState icon={<GitFork aria-hidden />} title="Keine Szenarien" description="Legen Sie den erwarteten Fall an — die Treiber kommen aus dem Ist. Bester und schlechtester Fall sind danach Kopien mit veränderten Annahmen." />
      ) : (
        <ListCard title={`Vergleich ${year}`}>
          <TableScroll minWidth="56rem">
            <table className="data-table">
              <caption className="sr-only">Szenarien im Vergleich</caption>
              <thead>
                <tr>
                  <th scope="col">Szenario</th>
                  <th scope="col" className="text-right">Umsatz</th>
                  <th scope="col" className="text-right">Deckungsbeitrag</th>
                  <th scope="col" className="text-right">Ergebnis</th>
                  <th scope="col" className="text-right">Break-even</th>
                  <th scope="col" className="text-right">Liquiditätstief</th>
                  <th scope="col" className="text-right">Endliquidität</th>
                  <th scope="col" className="text-right">Personal / Kundschaft</th>
                </tr>
              </thead>
              <tbody>
                {compare.map((s) => {
                  const totals = s.totals as ScenarioResult['totals'];
                  return (
                    <tr key={s.id}>
                      <td>
                        <Link href={`/admin/fuehrung/szenarien/${s.id}`} className="font-medium hover:text-primary">{s.name}</Link>
                        <span className="block text-xs">
                          <Badge size="sm" variant={KIND_VARIANT[s.kind]}>{SCENARIO_KIND_LABELS[s.kind]}</Badge>
                          <span className="ml-2 text-muted-foreground">{s.horizonMonths} Monate</span>
                        </span>
                      </td>
                      <td className="num">{formatCurrency(totals.revenue)}</td>
                      <td className="num">{formatCurrency(totals.contribution)}{totals.contributionMarginPct !== null ? <span className="ml-1 text-xs text-muted-foreground">{totals.contributionMarginPct} %</span> : null}</td>
                      <td className={`num font-medium ${totals.result < 0 ? 'text-destructive' : 'text-success'}`}>{formatCurrency(totals.result)}</td>
                      <td className="num">{s.breakEvenMonth ? `Monat ${s.breakEvenMonth}` : '—'}</td>
                      <td className={`num ${s.liquidityLow.cash < 0 ? 'text-destructive' : ''}`}>{formatCurrency(s.liquidityLow.cash)}<span className="ml-1 text-xs text-muted-foreground">M{s.liquidityLow.month}</span></td>
                      <td className="num">{formatCurrency(s.closingCash)}</td>
                      <td className="num text-muted-foreground">{s.peakEmployees} VZÄ · {s.peakCustomers}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableScroll>
        </ListCard>
      )}
    </div>
  );
}
