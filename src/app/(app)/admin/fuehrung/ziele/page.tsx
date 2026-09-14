import type { Metadata } from 'next';
import Link from 'next/link';
import { Map as MapIcon, Plus, Target } from 'lucide-react';

import { requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { formatDate, toQueryString } from '@/lib/utils';
import { OBJECTIVE_HORIZON_LABELS, OBJECTIVE_LEVEL_LABELS, OBJECTIVE_STATUS_LABELS, optionsOf, PRIORITY_LABELS } from '@/lib/bi/labels';
import { objectiveListQuery } from '@/lib/validation/bi-objectives';
import { getOrganizationId } from '@/server/services/organization.service';
import { listObjectives } from '@/server/services/objective.service';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/primitives';
import { FilterBar } from '@/components/app/filter-bar';
import { EmptyState, PageHeader, Pagination } from '@/components/app/page-parts';
import { DataCell, DataList, DataListHeader, DataRow } from '@/components/app/data-list';
import { RoadmapKanban, statusBadge } from '@/features/fuehrung/roadmap';

export const metadata: Metadata = {
  title: 'Ziele und Strategie',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const COLUMNS = 'minmax(0,1fr) 7rem 7rem 9rem 6rem';

export default async function ObjectivesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const session = await requirePermission('objective:read');
  const params = await searchParams;
  const organizationId = await getOrganizationId();
  const query = objectiveListQuery.parse({
    page: params.seite ?? '1',
    pageSize: params.ansicht === 'kanban' ? '100' : '25',
    q: params.q,
    horizon: params.flughoehe,
    level: params.ebene,
    status: params.status,
    archiv: params.archiv === '1' ? '1' : '0',
  });
  const { items, total } = await listObjectives(session, organizationId, query);
  const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
  const baseHref = `/admin/fuehrung/ziele${toQueryString({ q: params.q, flughoehe: params.flughoehe, ebene: params.ebene, status: params.status, archiv: params.archiv, ansicht: params.ansicht })}`;
  const kanban = params.ansicht === 'kanban';

  return (
    <div className="space-y-6">
      <PageHeader
        title="Ziele und Strategie"
        description="Strategie, Quartalsziele mit Schlüsselergebnissen und Initiativen — ein Baum, drei Flughöhen. Fortschritt kommt aus den Schlüsselergebnissen, nicht aus Schätzungen."
        actions={
          <>
            <Button asChild variant="outline">
              <Link href="/admin/fuehrung/ziele/roadmap">
                <MapIcon aria-hidden />
                Roadmap
              </Link>
            </Button>
            {can(session.role, 'objective:create') ? (
              <Button asChild>
                <Link href="/admin/fuehrung/ziele/neu">
                  <Plus aria-hidden />
                  Ziel anlegen
                </Link>
              </Button>
            ) : null}
          </>
        }
      >
        <FilterBar
          searchPlaceholder="Titel oder Bereich …"
          filters={[
            { param: 'flughoehe', label: 'Flughöhe', options: optionsOf(OBJECTIVE_HORIZON_LABELS) },
            { param: 'ebene', label: 'Ebene', options: optionsOf(OBJECTIVE_LEVEL_LABELS) },
            { param: 'status', label: 'Status', options: optionsOf(OBJECTIVE_STATUS_LABELS) },
            { param: 'ansicht', label: 'Ansicht', options: [{ value: 'liste', label: 'Liste' }, { value: 'kanban', label: 'Kanban' }] },
            { param: 'archiv', label: 'Archiv', options: [{ value: '1', label: 'Mit archivierten' }] },
          ]}
        />
      </PageHeader>

      {items.length === 0 ? (
        <EmptyState icon={<Target aria-hidden />} title="Keine Ziele" description="Beginnen Sie mit einer Strategie und hängen Sie Quartalsziele daran — jedes mit ein bis drei messbaren Schlüsselergebnissen." action={can(session.role, 'objective:create') ? { href: '/admin/fuehrung/ziele/neu', label: 'Erstes Ziel anlegen' } : undefined} />
      ) : kanban ? (
        <RoadmapKanban items={items} />
      ) : (
        <div className="space-y-4">
          <DataList label="Ziele">
            <DataListHeader columns={COLUMNS}>
              <span>Ziel</span>
              <span>Flughöhe</span>
              <span>Status</span>
              <span>Zeitraum</span>
              <span className="text-right">Fortschritt</span>
            </DataListHeader>
            {items.map((o) => (
              <DataRow key={o.id} columns={COLUMNS} href={`/admin/fuehrung/ziele/${o.id}`}>
                <DataCell strong truncate>
                  {o.title}
                  <span className="block truncate text-xs font-normal text-muted-foreground">
                    {OBJECTIVE_LEVEL_LABELS[o.level]}
                    {o.department ? ` · ${o.department}` : ''}
                    {o.owner ? ` · ${o.owner.firstName} ${o.owner.lastName}` : ''}
                    {o.parent ? ` · unter „${o.parent.title}"` : ''}
                    {o.priority !== 'NORMAL' ? ` · ${PRIORITY_LABELS[o.priority]}` : ''}
                  </span>
                </DataCell>
                <DataCell>
                  <Badge size="sm" variant="outline">{OBJECTIVE_HORIZON_LABELS[o.horizon]}</Badge>
                </DataCell>
                <DataCell>{statusBadge(o.status)}</DataCell>
                <DataCell muted>{o.quarter ? `Q${o.quarter} ${o.fiscalYear}` : o.endsOn ? `bis ${formatDate(o.endsOn)}` : o.fiscalYear ? String(o.fiscalYear) : '—'}</DataCell>
                <DataCell numeric>
                  <span className="flex items-center justify-end gap-2">
                    <Progress value={o.progressPct} className="hidden w-16 sm:block" />
                    {o.progressPct} %
                  </span>
                </DataCell>
              </DataRow>
            ))}
          </DataList>
          <Pagination page={query.page} totalPages={totalPages} total={total} baseHref={baseHref} />
        </div>
      )}
    </div>
  );
}
