import type { Metadata } from 'next';
import { ListChecks } from 'lucide-react';

import { requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { formatDate, toQueryString } from '@/lib/utils';
import { CONTROL_KIND_LABELS, CONTROL_STATUS_LABELS, optionsOf } from '@/lib/bi/labels';
import { controlListQuery } from '@/lib/validation/bi-governance';
import { getOrganizationId } from '@/server/services/organization.service';
import { getQualitySummary, listControls } from '@/server/services/governance.service';
import { listStaffOptions } from '@/server/services/fuehrung-options.service';
import { Badge } from '@/components/ui/badge';
import { KpiTile } from '@/components/app/kpi-tile';
import { FilterBar } from '@/components/app/filter-bar';
import { EmptyState, PageHeader, Pagination } from '@/components/app/page-parts';
import { DataCell, DataList, DataListHeader, DataRow } from '@/components/app/data-list';
import { FormDialog } from '@/features/fuehrung/resource-form';
import { controlFields } from '@/features/fuehrung/field-specs';

export const metadata: Metadata = {
  title: 'Qualität und Compliance',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const COLUMNS = 'minmax(0,1fr) 9rem 8rem 8rem';
const STATUS_VARIANT: Record<string, 'neutral' | 'success' | 'warning' | 'destructive' | 'outline'> = { DRAFT: 'neutral', ACTIVE: 'success', DUE: 'warning', NON_COMPLIANT: 'destructive', RETIRED: 'outline' };

export default async function QualityPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const session = await requirePermission('control:read');
  const params = await searchParams;
  const organizationId = await getOrganizationId();
  const query = controlListQuery.parse({ page: params.seite ?? '1', pageSize: '25', q: params.q, kind: params.art, status: params.status, faellig: params.faellig === '1' ? '1' : '0', order: 'asc' });
  const [{ items, total }, summary, staff] = await Promise.all([listControls(organizationId, query), getQualitySummary(organizationId), listStaffOptions(organizationId)]);
  const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
  const baseHref = `/admin/fuehrung/qualitaet${toQueryString({ q: params.q, art: params.art, status: params.status, faellig: params.faellig })}`;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Qualität und Compliance"
        description="Abläufe, Qualitätsnormen, Compliance-Pflichten und Notfallpläne — eine Liste, ein Prüfzyklus je Eintrag. Abweichungen werden zu Massnahmen."
        actions={
          can(session.role, 'control:create') ? (
            <FormDialog title="Kontrolle anlegen" triggerLabel="Kontrolle" endpoint="/api/bi/controls" successMessage="Kontrolle angelegt." redirectTo="/admin/fuehrung/qualitaet/{id}" fields={controlFields(staff)} values={{ kind: 'SOP', status: 'ACTIVE', reviewIntervalDays: 180 }} />
          ) : null
        }
      >
        <FilterBar
          searchPlaceholder="Titel oder Referenz …"
          filters={[
            { param: 'art', label: 'Art', options: optionsOf(CONTROL_KIND_LABELS) },
            { param: 'status', label: 'Status', options: optionsOf(CONTROL_STATUS_LABELS) },
            { param: 'faellig', label: 'Prüfung', options: [{ value: '1', label: 'Nur fällige' }] },
          ]}
        />
      </PageHeader>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile label="Prüfungen fällig" value={String(summary.due)} accent={summary.due > 0 ? 'warning' : undefined} href="/admin/fuehrung/qualitaet?faellig=1" />
        <KpiTile label="Abweichungen" value={String(summary.nonCompliant)} accent={summary.nonCompliant > 0 ? 'destructive' : undefined} href="/admin/fuehrung/qualitaet?status=NON_COMPLIANT" />
        <KpiTile label="Offene Massnahmen" value={String(summary.openActions)} hint={summary.overdueActions > 0 ? `${summary.overdueActions} überfällig` : undefined} accent={summary.overdueActions > 0 ? 'warning' : undefined} href="/admin/fuehrung/massnahmen" />
        <KpiTile label="Reklamationen 90 Tage" value={String(summary.complaints)} hint="Bewertungen mit 1–2 Sternen" href="/admin/bewertungen" />
      </div>

      {items.length === 0 ? (
        <EmptyState icon={<ListChecks aria-hidden />} title="Keine Kontrollen" description="Beginnen Sie mit den Reinigungsstandards, die das Team täglich braucht, und den Pflichten mit Frist: Datenschutz, Versicherungen, Arbeitsrecht." />
      ) : (
        <div className="space-y-4">
          <DataList label="Kontrollen">
            <DataListHeader columns={COLUMNS}>
              <span>Kontrolle</span>
              <span>Art</span>
              <span>Status</span>
              <span>Prüfung</span>
            </DataListHeader>
            {items.map((c) => {
              const overdue = c.nextReviewAt && c.nextReviewAt < new Date() && c.status !== 'RETIRED';
              return (
                <DataRow key={c.id} columns={COLUMNS} href={`/admin/fuehrung/qualitaet/${c.id}`}>
                  <DataCell strong truncate>
                    {c.title}
                    <span className="block text-xs font-normal text-muted-foreground">
                      {c.reference ? `${c.reference} · ` : ''}
                      {c.owner ? `${c.owner.firstName} ${c.owner.lastName}` : 'Ohne Verantwortung'}
                    </span>
                  </DataCell>
                  <DataCell muted>{CONTROL_KIND_LABELS[c.kind]}</DataCell>
                  <DataCell>
                    <Badge size="sm" variant={STATUS_VARIANT[c.status]}>{CONTROL_STATUS_LABELS[c.status]}</Badge>
                  </DataCell>
                  <DataCell muted>
                    <span className={overdue ? 'font-medium text-warning' : ''}>{c.nextReviewAt ? formatDate(c.nextReviewAt) : '—'}</span>
                  </DataCell>
                </DataRow>
              );
            })}
          </DataList>
          <Pagination page={query.page} totalPages={totalPages} total={total} baseHref={baseHref} />
        </div>
      )}
    </div>
  );
}
