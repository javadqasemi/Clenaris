import type { Metadata } from 'next';
import { PiggyBank } from 'lucide-react';

import { requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { formatCurrency, formatDate } from '@/lib/utils';
import { BUDGET_STATUS_LABELS } from '@/lib/bi/labels';
import { getOrganizationId } from '@/server/services/organization.service';
import { listBudgets } from '@/server/services/budget.service';
import { Badge } from '@/components/ui/badge';
import { EmptyState, PageHeader } from '@/components/app/page-parts';
import { DataCell, DataList, DataListHeader, DataRow } from '@/components/app/data-list';
import { FormDialog } from '@/features/fuehrung/resource-form';

export const metadata: Metadata = {
  title: 'Budget',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const COLUMNS = 'minmax(0,1fr) 8rem 8rem 9rem 8rem';
const STATUS_VARIANT: Record<string, 'neutral' | 'success' | 'outline'> = { DRAFT: 'neutral', APPROVED: 'success', CLOSED: 'outline' };

export default async function BudgetListPage() {
  const session = await requirePermission('budget:read');
  const organizationId = await getOrganizationId();
  const budgets = await listBudgets(organizationId, {});
  const year = new Date().getFullYear();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Budget"
        description="Planwerte je Kostenart, gemessen am Ist aus den Ausgaben. Genehmigen friert den Plan ein — Korrekturen laufen als Nachtrag, damit Plan und Änderung getrennt sichtbar bleiben."
        actions={
          can(session.role, 'budget:create') ? (
            <FormDialog
              title="Budgetperiode anlegen"
              description="In der Regel ein Geschäftsjahr. Zeilen kommen auf der Detailseite dazu."
              triggerLabel="Budget"
              endpoint="/api/bi/budgets"
              successMessage="Budget angelegt."
              redirectTo="/admin/fuehrung/budget/{id}"
              fields={[
                { name: 'name', label: 'Bezeichnung', required: true, placeholder: `Budget ${year + 1}` },
                { name: 'fiscalYear', label: 'Geschäftsjahr', type: 'number', required: true, half: true },
                { name: 'startsOn', label: 'Beginn', type: 'date', required: true, half: true },
                { name: 'endsOn', label: 'Ende', type: 'date', required: true, half: true },
                { name: 'note', label: 'Notiz', type: 'textarea', rows: 2 },
              ]}
              values={{ fiscalYear: year + 1, startsOn: `${year + 1}-01-01`, endsOn: `${year + 1}-12-31` }}
            />
          ) : null
        }
      />

      {budgets.length === 0 ? (
        <EmptyState icon={<PiggyBank aria-hidden />} title="Kein Budget" description="Legen Sie eine Budgetperiode an und erfassen Sie je Kostenart einen Jahresplan. Das Ist kommt aus den Ausgaben." />
      ) : (
        <DataList label="Budgetperioden">
          <DataListHeader columns={COLUMNS}>
            <span>Budget</span>
            <span>Jahr</span>
            <span>Status</span>
            <span className="text-right">Plansumme</span>
            <span>Zeilen</span>
          </DataListHeader>
          {budgets.map((b) => (
            <DataRow key={b.id} columns={COLUMNS} href={`/admin/fuehrung/budget/${b.id}`}>
              <DataCell strong truncate>
                {b.name}
                <span className="block text-xs font-normal text-muted-foreground">
                  {formatDate(b.startsOn)} – {formatDate(b.endsOn)}
                  {b.approvedAt ? ` · genehmigt ${formatDate(b.approvedAt)}` : ''}
                </span>
              </DataCell>
              <DataCell muted>{b.fiscalYear}</DataCell>
              <DataCell>
                <Badge size="sm" variant={STATUS_VARIANT[b.status]}>{BUDGET_STATUS_LABELS[b.status]}</Badge>
              </DataCell>
              <DataCell numeric>{formatCurrency(b.plannedTotal)}</DataCell>
              <DataCell muted>{b.lineCount}</DataCell>
            </DataRow>
          ))}
        </DataList>
      )}
    </div>
  );
}
