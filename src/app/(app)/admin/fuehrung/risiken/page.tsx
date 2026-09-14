import type { Metadata } from 'next';
import { ShieldAlert } from 'lucide-react';

import { requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { formatDate, toQueryString } from '@/lib/utils';
import { optionsOf, RISK_BAND_LABELS, RISK_CATEGORY_LABELS, RISK_STATUS_LABELS } from '@/lib/bi/labels';
import { riskListQuery } from '@/lib/validation/bi-governance';
import { getOrganizationId } from '@/server/services/organization.service';
import { getRiskMatrix, listRisks } from '@/server/services/governance.service';
import { listStaffOptions } from '@/server/services/fuehrung-options.service';
import { Badge } from '@/components/ui/badge';
import { FilterBar } from '@/components/app/filter-bar';
import { DetailSection, EmptyState, PageHeader, Pagination } from '@/components/app/page-parts';
import { DataCell, DataList, DataListHeader, DataRow } from '@/components/app/data-list';
import { RiskMatrix } from '@/features/fuehrung/risk-matrix';
import { FormDialog } from '@/features/fuehrung/resource-form';
import { riskFields } from '@/features/fuehrung/field-specs';

export const metadata: Metadata = {
  title: 'Risiken',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const COLUMNS = 'minmax(0,1fr) 8rem 7rem 8rem 8rem';
const BAND_VARIANT: Record<string, 'success' | 'warning' | 'destructive' | 'neutral'> = { LOW: 'success', MEDIUM: 'neutral', HIGH: 'warning', CRITICAL: 'destructive' };

export default async function RisksPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const session = await requirePermission('risk:read');
  const params = await searchParams;
  const organizationId = await getOrganizationId();
  const query = riskListQuery.parse({ page: params.seite ?? '1', pageSize: '25', q: params.q, category: params.kategorie, status: params.status, faellig: params.faellig === '1' ? '1' : '0', sort: params.sort, order: params.order ?? 'desc' });
  const [{ items, total }, matrix, staff] = await Promise.all([listRisks(organizationId, query), getRiskMatrix(organizationId), listStaffOptions(organizationId)]);
  const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
  const baseHref = `/admin/fuehrung/risiken${toQueryString({ q: params.q, kategorie: params.kategorie, status: params.status, faellig: params.faellig })}`;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Risiken"
        description="Register mit Wahrscheinlichkeit und Auswirkung, brutto und netto. Jedes Risiko hat einen Prüfzyklus — der Nachtlauf meldet, was überfällig ist."
        actions={
          can(session.role, 'risk:create') ? (
            <FormDialog title="Risiko erfassen" triggerLabel="Risiko" endpoint="/api/bi/risks" successMessage="Risiko erfasst." redirectTo="/admin/fuehrung/risiken/{id}" fields={riskFields(staff)} values={{ category: 'OPERATIONAL', status: 'IDENTIFIED', probability: '3', impact: '3', reviewIntervalDays: 90 }} />
          ) : null
        }
      >
        <FilterBar
          searchPlaceholder="Risiko suchen …"
          filters={[
            { param: 'kategorie', label: 'Kategorie', options: optionsOf(RISK_CATEGORY_LABELS) },
            { param: 'status', label: 'Status', options: optionsOf(RISK_STATUS_LABELS) },
            { param: 'faellig', label: 'Prüfung', options: [{ value: '1', label: 'Nur fällige' }] },
          ]}
        />
      </PageHeader>

      <div className="grid gap-6 lg:grid-cols-[22rem_1fr]">
        <DetailSection title="Matrix" description={`${matrix.total} offen · ${matrix.bands.CRITICAL} kritisch · ${matrix.bands.HIGH} hoch · ${matrix.bands.MEDIUM} mittel · ${matrix.bands.LOW} gering`} body="form">
          <RiskMatrix cells={matrix.cells} />
        </DetailSection>

        {items.length === 0 ? (
          <EmptyState icon={<ShieldAlert aria-hidden />} title="Keine Risiken" description="Ein leeres Register heisst nicht, dass es keine Risiken gibt. Beginnen Sie mit den fünf, die Ihnen nachts einfallen." />
        ) : (
          <div className="space-y-4">
            <DataList label="Risikoregister">
              <DataListHeader columns={COLUMNS}>
                <span>Risiko</span>
                <span>Kategorie</span>
                <span>Schwere</span>
                <span>Status</span>
                <span>Prüfung</span>
              </DataListHeader>
              {items.map((r) => {
                const overdue = r.nextReviewAt && r.nextReviewAt < new Date() && r.status !== 'CLOSED';
                return (
                  <DataRow key={r.id} columns={COLUMNS} href={`/admin/fuehrung/risiken/${r.id}`}>
                    <DataCell strong truncate>
                      {r.title}
                      <span className="block text-xs font-normal text-muted-foreground">
                        {r.owner ? `${r.owner.firstName} ${r.owner.lastName}` : 'Ohne Verantwortung'}
                        {r._count.actions ? ` · ${r._count.actions} Massnahmen` : ''}
                      </span>
                    </DataCell>
                    <DataCell muted>{RISK_CATEGORY_LABELS[r.category]}</DataCell>
                    <DataCell>
                      <Badge size="sm" variant={BAND_VARIANT[r.band]}>{RISK_BAND_LABELS[r.band]} · {r.severity}</Badge>
                    </DataCell>
                    <DataCell muted>{RISK_STATUS_LABELS[r.status]}</DataCell>
                    <DataCell muted>
                      <span className={overdue ? 'font-medium text-warning' : ''}>{r.nextReviewAt ? formatDate(r.nextReviewAt) : '—'}</span>
                    </DataCell>
                  </DataRow>
                );
              })}
            </DataList>
            <Pagination page={query.page} totalPages={totalPages} total={total} baseHref={baseHref} />
          </div>
        )}
      </div>
    </div>
  );
}
