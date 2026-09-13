import type { Metadata } from 'next';
import Link from 'next/link';
import { Plus, Presentation } from 'lucide-react';

import { requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { formatDateTime, toQueryString } from '@/lib/utils';
import { meetingListQuery } from '@/lib/validation/bi-knowledge';
import { getOrganizationId } from '@/server/services/organization.service';
import { listMeetings } from '@/server/services/meeting.service';
import { Button } from '@/components/ui/button';
import { FilterBar } from '@/components/app/filter-bar';
import { EmptyState, PageHeader, Pagination } from '@/components/app/page-parts';
import { DataCell, DataList, DataListHeader, DataRow } from '@/components/app/data-list';

export const metadata: Metadata = {
  title: 'Sitzungen',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const COLUMNS = 'minmax(0,1fr) 11rem 12rem 6rem';

export default async function MeetingsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const session = await requirePermission('meeting:read');
  const params = await searchParams;
  const organizationId = await getOrganizationId();
  const query = meetingListQuery.parse({ page: params.seite ?? '1', pageSize: '25', q: params.q, order: 'desc' });
  const { items, total } = await listMeetings(organizationId, query);
  const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
  const baseHref = `/admin/fuehrung/sitzungen${toQueryString({ q: params.q })}`;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sitzungen"
        description="Traktanden, Protokoll, Beschlüsse — und Pendenzen, die als Aufgaben weiterleben statt im Protokoll zu verschwinden."
        actions={
          can(session.role, 'meeting:create') ? (
            <Button asChild>
              <Link href="/admin/fuehrung/sitzungen/neu">
                <Plus aria-hidden />
                Sitzung
              </Link>
            </Button>
          ) : null
        }
      >
        <FilterBar searchPlaceholder="Titel, Beschluss oder Protokoll …" />
      </PageHeader>

      {items.length === 0 ? (
        <EmptyState icon={<Presentation aria-hidden />} title="Keine Sitzungen" description="Die Geschäftsleitungssitzung ist der richtige Anfang: Zahlen, Ziele, Beschlüsse, Pendenzen." action={can(session.role, 'meeting:create') ? { href: '/admin/fuehrung/sitzungen/neu', label: 'Erste Sitzung anlegen' } : undefined} />
      ) : (
        <div className="space-y-4">
          <DataList label="Sitzungen">
            <DataListHeader columns={COLUMNS}>
              <span>Sitzung</span>
              <span>Zeitpunkt</span>
              <span>Teilnehmende</span>
              <span>Pendenzen</span>
            </DataListHeader>
            {items.map((m) => (
              <DataRow key={m.id} columns={COLUMNS} href={`/admin/fuehrung/sitzungen/${m.id}`}>
                <DataCell strong truncate>
                  {m.title}
                  {m.decisions ? <span className="block truncate text-xs font-normal text-muted-foreground">{m.decisions.split('\n')[0]}</span> : null}
                </DataCell>
                <DataCell muted>{formatDateTime(m.heldAt)}</DataCell>
                <DataCell muted truncate>{m.participants.map((p) => `${p.user.firstName} ${p.user.lastName.charAt(0)}.`).join(', ') || '—'}</DataCell>
                <DataCell muted numeric>{m._count.tasks}</DataCell>
              </DataRow>
            ))}
          </DataList>
          <Pagination page={query.page} totalPages={totalPages} total={total} baseHref={baseHref} />
        </div>
      )}
    </div>
  );
}
