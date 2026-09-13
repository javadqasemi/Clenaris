import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, CheckCircle2, Lock } from 'lucide-react';

import { requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { NotFoundError } from '@/lib/errors';
import { formatCurrency, formatDate } from '@/lib/utils';
import { BUDGET_STATUS_LABELS, EXPENSE_CATEGORY_LABELS } from '@/lib/bi/labels';
import { getOrganizationId } from '@/server/services/organization.service';
import { getBudgetVariance } from '@/server/services/budget.service';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/primitives';
import { KpiTile } from '@/components/app/kpi-tile';
import { PageHeader } from '@/components/app/page-parts';
import { BudgetVarianceChart } from '@/components/charts/lazy';
import { ActionButton } from '@/features/fuehrung/action-button';
import { FormDialog } from '@/features/fuehrung/resource-form';
import { BudgetLinesEditor } from '@/features/fuehrung/budget-lines-editor';

export const metadata: Metadata = {
  title: 'Budget',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

export default async function BudgetDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission('budget:read');
  const { id } = await params;
  const organizationId = await getOrganizationId();
  const variance = await getBudgetVariance(organizationId, id).catch((error) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const { period, totals, lines } = variance;
  const canEdit = can(session.role, 'budget:update');
  const canApprove = can(session.role, 'budget:approve');

  const monthly = Array.from({ length: variance.totalMonths }, (_, i) => ({
    label: MONTHS[(period.startsOn.getUTCMonth() + i) % 12],
    plan: lines.reduce((s, l) => s + (l.monthly[i]?.plan ?? 0), 0),
    actual: lines.reduce((s, l) => s + (l.monthly[i]?.actual ?? 0), 0),
  }));

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-3">
        <Link href="/admin/fuehrung/budget">
          <ArrowLeft aria-hidden />
          Alle Budgets
        </Link>
      </Button>

      <PageHeader
        title={period.name}
        description={`${formatDate(period.startsOn)} – ${formatDate(period.endsOn)} · ${variance.elapsedMonths} von ${variance.totalMonths} Monaten begonnen`}
        actions={
          <>
            <Badge variant={period.status === 'APPROVED' ? 'success' : period.status === 'CLOSED' ? 'outline' : 'neutral'}>{BUDGET_STATUS_LABELS[period.status]}</Badge>
            {canEdit && period.status !== 'CLOSED' ? (
              <FormDialog
                title="Budget bearbeiten"
                triggerLabel="Bearbeiten"
                triggerVariant="outline"
                plainTrigger
                endpoint={`/api/bi/budgets/${id}`}
                method="PATCH"
                successMessage="Budget gespeichert."
                fields={[
                  { name: 'name', label: 'Bezeichnung', required: true },
                  { name: 'fiscalYear', label: 'Geschäftsjahr', type: 'number', required: true, half: true },
                  { name: 'startsOn', label: 'Beginn', type: 'date', required: true, half: true },
                  { name: 'endsOn', label: 'Ende', type: 'date', required: true, half: true },
                ]}
                values={{ name: period.name, fiscalYear: period.fiscalYear, startsOn: period.startsOn, endsOn: period.endsOn }}
              />
            ) : null}
            {canApprove && period.status === 'DRAFT' ? (
              <ActionButton endpoint={`/api/bi/budgets/${id}/approve`} label="Genehmigen" confirm="Die Planwerte werden eingefroren. Änderungen laufen danach als Nachtrag je Zeile." successMessage="Budget genehmigt." variant="default">
                <CheckCircle2 aria-hidden />
              </ActionButton>
            ) : null}
            {canApprove && period.status === 'APPROVED' ? (
              <ActionButton endpoint={`/api/bi/budgets/${id}/close`} label="Abschliessen" confirm="Danach ist nichts mehr änderbar — auch keine Nachträge." successMessage="Budget abgeschlossen.">
                <Lock aria-hidden />
              </ActionButton>
            ) : null}
            {can(session.role, 'budget:delete') && period.status === 'DRAFT' ? (
              <ActionButton endpoint={`/api/bi/budgets/${id}`} method="DELETE" label="Löschen" confirm="Der Entwurf wird mit allen Zeilen gelöscht." variant="ghost" redirectTo="/admin/fuehrung/budget" />
            ) : null}
          </>
        }
      />

      {period.status === 'DRAFT' ? <Alert variant="info">Im Entwurf messen die Abweichungen noch gegen einen beweglichen Plan. Genehmigen Sie das Budget, sobald die Zeilen stehen.</Alert> : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile label="Jahresplan" value={formatCurrency(totals.plan)} />
        <KpiTile label="Plan bis heute" value={formatCurrency(totals.planToDate)} hint="anteilig nach Monatsverteilung" />
        <KpiTile label="Ist bis heute" value={formatCurrency(totals.actual)} changePercent={totals.variancePct ?? undefined} invertTrend hint={totals.variance > 0 ? 'über Plan' : 'unter Plan'} />
        <KpiTile label="Hochrechnung Jahr" value={totals.forecast === null ? '—' : formatCurrency(totals.forecast)} hint={totals.forecast === null ? 'ab drei Monaten' : totals.forecastVariance !== null ? `${totals.forecastVariance > 0 ? '+' : ''}${formatCurrency(totals.forecastVariance)} zum Plan` : undefined} accent={totals.forecastVariance !== null && totals.forecastVariance > 0 ? 'warning' : undefined} />
      </div>

      <BudgetVarianceChart data={monthly} />

      <BudgetLinesEditor budgetId={id} status={period.status} lines={lines} canEdit={canEdit} />

      {variance.unbudgeted.length > 0 ? (
        <Alert variant="warning" title="Ausgaben ohne Budgetzeile">
          {variance.unbudgeted.map((u) => `${EXPENSE_CATEGORY_LABELS[u.category] ?? u.category} ${formatCurrency(u.actual)}`).join(' · ')}
        </Alert>
      ) : null}
    </div>
  );
}
