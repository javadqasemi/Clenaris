import type { Metadata } from 'next';
import { FolderOpen } from 'lucide-react';

import { requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { formatBytes, formatDate, toQueryString } from '@/lib/utils';
import { DOCUMENT_CATEGORY_LABELS, DOCUMENT_VISIBILITY_LABELS, optionsOf } from '@/lib/bi/labels';
import { documentListQuery } from '@/lib/validation/bi-knowledge';
import { getOrganizationId } from '@/server/services/organization.service';
import { listDocuments } from '@/server/services/document.service';
import { listEmployeeOptions, listSupplierOptions } from '@/server/services/fuehrung-options.service';
import { Badge } from '@/components/ui/badge';
import { FilterBar } from '@/components/app/filter-bar';
import { EmptyState, PageHeader, Pagination } from '@/components/app/page-parts';
import { DataCell, DataList, DataListHeader, DataRow } from '@/components/app/data-list';
import { DocumentUploadDialog } from '@/features/fuehrung/document-upload';

export const metadata: Metadata = {
  title: 'Dokumente',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const COLUMNS = 'minmax(0,1fr) 8rem 12rem 8rem';

export default async function DocumentsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const session = await requirePermission('document:read');
  const params = await searchParams;
  const organizationId = await getOrganizationId();
  const query = documentListQuery.parse({ page: params.seite ?? '1', pageSize: '25', q: params.q, category: params.kategorie, visibility: params.sichtbarkeit, tag: params.tag, ablaufTage: params.ablaufTage, order: 'desc' });
  const [{ items, total }, employees, suppliers] = await Promise.all([listDocuments(session, organizationId, query), listEmployeeOptions(organizationId), listSupplierOptions(organizationId)]);
  const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
  const baseHref = `/admin/fuehrung/dokumente${toQueryString({ q: params.q, kategorie: params.kategorie, sichtbarkeit: params.sichtbarkeit, tag: params.tag, ablaufTage: params.ablaufTage })}`;
  const soon = new Date(Date.now() + 30 * 86_400_000);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dokumente"
        description="Verträge, Policen, Bewilligungen, Personalunterlagen — mit Fassungen, Fristen und Sichtbarkeit. Jeder Download wird protokolliert."
        actions={can(session.role, 'document:create') ? <DocumentUploadDialog mode="create" employees={employees} suppliers={suppliers} /> : null}
      >
        <FilterBar
          searchPlaceholder="Titel, Beschreibung oder Schlagwort …"
          filters={[
            { param: 'kategorie', label: 'Kategorie', options: optionsOf(DOCUMENT_CATEGORY_LABELS) },
            { param: 'sichtbarkeit', label: 'Sichtbarkeit', options: optionsOf(DOCUMENT_VISIBILITY_LABELS) },
            { param: 'ablaufTage', label: 'Ablauf', options: [{ value: '30', label: 'In 30 Tagen' }, { value: '90', label: 'In 90 Tagen' }] },
          ]}
        />
      </PageHeader>

      {items.length === 0 ? (
        <EmptyState icon={<FolderOpen aria-hidden />} title="Keine Dokumente" description="Legen Sie Verträge und Policen mit Ablaufdatum ab — der Nachtlauf erinnert rechtzeitig." />
      ) : (
        <div className="space-y-4">
          <DataList label="Dokumente">
            <DataListHeader columns={COLUMNS}>
              <span>Dokument</span>
              <span>Kategorie</span>
              <span>Sichtbarkeit</span>
              <span>Läuft ab</span>
            </DataListHeader>
            {items.map((d) => {
              const expiring = d.expiresOn && d.expiresOn <= soon;
              return (
                <DataRow key={d.id} columns={COLUMNS} href={`/admin/fuehrung/dokumente/${d.id}`}>
                  <DataCell strong truncate>
                    {d.title}
                    <span className="block text-xs font-normal text-muted-foreground">
                      {d.currentVersion ? `${d.currentVersion.file.filename} · ${formatBytes(d.currentVersion.file.sizeBytes)} · Fassung ${d.currentVersion.version}` : 'Noch keine Datei'}
                      {d.subjectEmployee ? ` · ${d.subjectEmployee.user.firstName} ${d.subjectEmployee.user.lastName}` : ''}
                      {d.supplier ? ` · ${d.supplier.name}` : ''}
                      {d.tags.length ? ` · ${d.tags.join(', ')}` : ''}
                    </span>
                  </DataCell>
                  <DataCell muted>{DOCUMENT_CATEGORY_LABELS[d.category]}</DataCell>
                  <DataCell>
                    <Badge size="sm" variant={d.visibility === 'EMPLOYEE_PRIVATE' ? 'warning' : d.visibility === 'MANAGEMENT' ? 'default' : 'neutral'}>{DOCUMENT_VISIBILITY_LABELS[d.visibility]}</Badge>
                  </DataCell>
                  <DataCell muted>
                    <span className={expiring ? 'font-medium text-warning' : ''}>{d.expiresOn ? formatDate(d.expiresOn) : '—'}</span>
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
