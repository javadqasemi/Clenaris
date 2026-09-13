import type { Metadata } from 'next';
import Link from 'next/link';
import { TrendingUp } from 'lucide-react';

import { requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { formatKpiValue, KPI_DIRECTIONS_LABELS, KPI_PERIOD_LABELS, KPI_SOURCE_LABELS, KPI_UNIT_LABELS, optionsOf } from '@/lib/bi/labels';
import { getOrganizationId } from '@/server/services/organization.service';
import { getKpiOverview } from '@/server/services/kpi.service';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/primitives';
import { EmptyState, ListCard, PageHeader, TableScroll } from '@/components/app/page-parts';
import { FormDialog } from '@/features/fuehrung/resource-form';

export const metadata: Metadata = {
  title: 'Kennzahlen',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function KpiListPage({ searchParams }: { searchParams: Promise<{ gruppe?: string }> }) {
  const session = await requirePermission('kpi:read');
  const params = await searchParams;
  const organizationId = await getOrganizationId();
  const rows = await getKpiOverview(organizationId, 'MONTH', { group: params.gruppe });
  const groups = [...new Set(rows.map((r) => r.group))];
  const canManage = can(session.role, 'kpi:manage');
  const missingCalculators = rows.filter((r) => !r.hasCalculator);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Kennzahlen"
        description="Berechnete Werte aus Buchungen, Rechnungen, Einsätzen und Zeiterfassung — festgeschrieben je Monat, Quartal und Jahr. Zielwert und Warnschwelle machen daraus eine Note im Gesundheitswert."
        actions={
          canManage ? (
            <FormDialog
              title="Kennzahl anlegen"
              description="Berechnete Kennzahlen brauchen einen Rechner im Code; manuelle Kennzahlen tragen Sie selbst nach — etwa den Google-Bewertungsschnitt."
              triggerLabel="Kennzahl"
              endpoint="/api/bi/kpis"
              successMessage="Kennzahl angelegt."
              fields={[
                { name: 'key', label: 'Schlüssel', required: true, half: true, placeholder: 'z. B. website.sessions', hint: 'Kleinbuchstaben und Punkte; nachträglich nicht änderbar.' },
                { name: 'label', label: 'Bezeichnung', required: true, half: true },
                { name: 'group', label: 'Gruppe', required: true, half: true, placeholder: 'Finanzen, Vertrieb, Marketing …' },
                { name: 'source', label: 'Herkunft', type: 'select', required: true, half: true, options: optionsOf(KPI_SOURCE_LABELS) },
                { name: 'unit', label: 'Einheit', type: 'select', required: true, half: true, options: optionsOf(KPI_UNIT_LABELS) },
                { name: 'direction', label: 'Richtung', type: 'select', required: true, half: true, options: optionsOf(KPI_DIRECTIONS_LABELS) },
                { name: 'targetValue', label: 'Zielwert', type: 'number', half: true },
                { name: 'warnValue', label: 'Warnschwelle', type: 'number', half: true },
                { name: 'healthWeight', label: 'Gewicht im Gesundheitswert', type: 'number', half: true, min: 0, max: 100 },
                { name: 'description', label: 'Beschreibung', type: 'textarea', rows: 2 },
              ]}
              values={{ group: 'Marketing', source: 'MANUAL', unit: 'COUNT', direction: 'UP_IS_GOOD', healthWeight: 0 }}
            />
          ) : null
        }
      >
        <nav className="flex flex-wrap gap-2" aria-label="Gruppen">
          <Link href="/admin/fuehrung/kennzahlen" className={`rounded-full border px-3 py-1 text-sm ${!params.gruppe ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}>
            Alle
          </Link>
          {groups.map((g) => (
            <Link key={g} href={`/admin/fuehrung/kennzahlen?gruppe=${encodeURIComponent(g)}`} className={`rounded-full border px-3 py-1 text-sm ${params.gruppe === g ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}>
              {g}
            </Link>
          ))}
        </nav>
      </PageHeader>

      {missingCalculators.length > 0 ? (
        <Alert variant="warning" title="Kennzahlen ohne Rechner">
          {missingCalculators.map((r) => r.key).join(', ')} sind als berechnet markiert, haben aber keine Formel im Code. Der Nachtlauf überspringt sie.
        </Alert>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState icon={<TrendingUp aria-hidden />} title="Keine Kennzahlen" description="Der Seed legt die Startbestückung an: npm run db:seed. Danach füllt der Nachtlauf die Werte." />
      ) : (
        <ListCard>
          <TableScroll minWidth="56rem">
            <table className="data-table">
              <caption className="sr-only">Kennzahlen mit aktuellem Monatswert</caption>
              <thead>
                <tr>
                  <th scope="col">Kennzahl</th>
                  <th scope="col">Gruppe</th>
                  <th scope="col" className="text-right">Aktuell</th>
                  <th scope="col" className="text-right">Vorperiode</th>
                  <th scope="col" className="text-right">Vorjahr</th>
                  <th scope="col" className="text-right">Ziel</th>
                  <th scope="col" className="text-right">Gewicht</th>
                  <th scope="col">Perioden</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const good = row.changePct === null ? null : (row.changePct >= 0) === (row.direction === 'UP_IS_GOOD');
                  return (
                    <tr key={row.id}>
                      <td>
                        <Link href={`/admin/fuehrung/kennzahlen/${row.id}`} className="font-medium hover:text-primary">
                          {row.label}
                        </Link>
                        <span className="block text-xs text-muted-foreground">
                          {row.key} · {KPI_SOURCE_LABELS[row.source]}
                          {!row.active ? ' · inaktiv' : ''}
                        </span>
                      </td>
                      <td className="text-muted-foreground">{row.group}</td>
                      <td className="num font-medium">
                        {formatKpiValue(row.current?.value ?? null, row.unit)}
                        {row.current?.provisional ? <span className="ml-1 text-2xs text-muted-foreground">vorl.</span> : null}
                      </td>
                      <td className="num text-muted-foreground">
                        {formatKpiValue(row.previous?.value ?? null, row.unit)}
                        {row.changePct !== null ? <span className={`ml-1 text-xs ${good ? 'text-success' : 'text-destructive'}`}>{row.changePct > 0 ? '+' : ''}{row.changePct} %</span> : null}
                      </td>
                      <td className="num text-muted-foreground">{row.yoyPct === null ? '—' : `${row.yoyPct > 0 ? '+' : ''}${row.yoyPct} %`}</td>
                      <td className="num text-muted-foreground">{formatKpiValue(row.targetValue, row.unit)}</td>
                      <td className="num">{row.healthWeight > 0 ? <Badge size="sm" variant="default">{row.healthWeight}</Badge> : <span className="text-muted-foreground">—</span>}</td>
                      <td className="text-xs text-muted-foreground">{row.periods.map((p) => KPI_PERIOD_LABELS[p]).join(', ')}</td>
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
