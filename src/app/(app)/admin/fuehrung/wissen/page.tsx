import type { Metadata } from 'next';
import { BookOpen } from 'lucide-react';

import { requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { formatDate, toQueryString } from '@/lib/utils';
import { ARTICLE_STATUS_LABELS, optionsOf } from '@/lib/bi/labels';
import { articleListQuery } from '@/lib/validation/bi-knowledge';
import { getOrganizationId } from '@/server/services/organization.service';
import { listArticles } from '@/server/services/knowledge.service';
import { Badge } from '@/components/ui/badge';
import { FilterBar } from '@/components/app/filter-bar';
import { EmptyState, PageHeader, Pagination } from '@/components/app/page-parts';
import { DataCell, DataList, DataListHeader, DataRow } from '@/components/app/data-list';
import { FormDialog } from '@/features/fuehrung/resource-form';
import { articleFields } from '@/features/fuehrung/knowledge-fields';

export const metadata: Metadata = {
  title: 'Wissen',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const COLUMNS = 'minmax(0,1fr) 9rem 8rem 8rem';

export default async function KnowledgePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const session = await requirePermission('knowledge:read');
  const params = await searchParams;
  const organizationId = await getOrganizationId();
  const query = articleListQuery.parse({ page: params.seite ?? '1', pageSize: '25', q: params.q, category: params.kategorie, status: params.status, tag: params.tag, order: 'asc' });
  const { items, total } = await listArticles(session, organizationId, query);
  const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
  const baseHref = `/admin/fuehrung/wissen${toQueryString({ q: params.q, kategorie: params.kategorie, status: params.status, tag: params.tag })}`;
  const categories = [...new Set(items.map((a) => a.category))];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Wissen"
        description="Abläufe, Schulungsunterlagen, Richtlinien und Antworten auf die Fragen, die im Team immer wieder kommen. Nach innen gerichtet, nie öffentlich."
        actions={
          can(session.role, 'knowledge:create') ? (
            <FormDialog title="Artikel verfassen" triggerLabel="Artikel" endpoint="/api/bi/knowledge" successMessage="Artikel angelegt." redirectTo="/admin/fuehrung/wissen/{slug}" size="xl" fields={articleFields()} values={{ category: 'Allgemein', status: 'DRAFT', visibility: 'STAFF' }} />
          ) : null
        }
      >
        <FilterBar
          searchPlaceholder="Titel oder Inhalt …"
          filters={[
            { param: 'kategorie', label: 'Kategorie', options: categories.map((c) => ({ value: c, label: c })) },
            { param: 'status', label: 'Status', options: optionsOf(ARTICLE_STATUS_LABELS) },
          ]}
        />
      </PageHeader>

      {items.length === 0 ? (
        <EmptyState icon={<BookOpen aria-hidden />} title="Keine Artikel" description="Beginnen Sie mit dem, was neue Mitarbeitende in der ersten Woche fragen: Schlüssel, Fahrzeuge, Reinigungsmittel, Zeiterfassung." />
      ) : (
        <div className="space-y-4">
          <DataList label="Wissensartikel">
            <DataListHeader columns={COLUMNS}>
              <span>Artikel</span>
              <span>Kategorie</span>
              <span>Status</span>
              <span>Geändert</span>
            </DataListHeader>
            {items.map((a) => (
              <DataRow key={a.id} columns={COLUMNS} href={`/admin/fuehrung/wissen/${a.slug}`}>
                <DataCell strong truncate>
                  {a.title}
                  <span className="block truncate text-xs font-normal text-muted-foreground">{a.summary ?? a.body.slice(0, 120)}</span>
                </DataCell>
                <DataCell muted>{a.category}</DataCell>
                <DataCell>
                  <Badge size="sm" variant={a.status === 'PUBLISHED' ? 'success' : a.status === 'ARCHIVED' ? 'outline' : 'neutral'}>{ARTICLE_STATUS_LABELS[a.status]}</Badge>
                </DataCell>
                <DataCell muted>{formatDate(a.updatedAt)}</DataCell>
              </DataRow>
            ))}
          </DataList>
          <Pagination page={query.page} totalPages={totalPages} total={total} baseHref={baseHref} />
        </div>
      )}
    </div>
  );
}
