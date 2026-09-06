import type { Metadata } from 'next';
import Link from 'next/link';
import { LayoutGrid, List, Plus } from 'lucide-react';

import { toNumber } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { formatCurrency, formatDate, formatRelative, toQueryString } from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import { getLeadPipeline, listLeads } from '@/server/services/crm.service';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FilterBar } from '@/components/app/filter-bar';
import { SortHeader } from '@/components/app/sort-header';
import {
  EmptyState,
  ListCard,
  PageHeader,
  Pagination,
  TableScroll,
} from '@/components/app/page-parts';
import { LeadPipeline } from '@/features/admin/lead-pipeline';

export const metadata: Metadata = {
  title: 'Leads',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function AdminLeadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePermission('lead:read');

  const params = await searchParams;
  const organizationId = await getOrganizationId();
  const view = params.ansicht === 'liste' ? 'liste' : 'pipeline';

  return (
    <div className="space-y-6">
      <PageHeader
        title="Leads"
        description="Jede Anfrage über die Website landet hier. Die KI bewertet Abschlusswahrscheinlichkeit und Auftragswert, damit Sie zuerst das Wichtige anrufen."
        actions={
          <>
            <div className="inline-flex items-center gap-0.5 rounded-xl bg-muted p-1">
              <Button
                asChild
                variant={view === 'pipeline' ? 'outline' : 'ghost'}
                size="sm"
                className={view === 'pipeline' ? 'bg-card shadow-soft' : ''}
              >
                <Link href="/admin/leads?ansicht=pipeline">
                  <LayoutGrid aria-hidden />
                  Pipeline
                </Link>
              </Button>
              <Button
                asChild
                variant={view === 'liste' ? 'outline' : 'ghost'}
                size="sm"
                className={view === 'liste' ? 'bg-card shadow-soft' : ''}
              >
                <Link href="/admin/leads?ansicht=liste">
                  <List aria-hidden />
                  Liste
                </Link>
              </Button>
            </div>

            <Button asChild>
              <Link href="/admin/leads/neu">
                <Plus aria-hidden />
                Lead erfassen
              </Link>
            </Button>
          </>
        }
      />

      {view === 'pipeline' ? (
        <PipelineView organizationId={organizationId} />
      ) : (
        <ListView organizationId={organizationId} params={params} />
      )}
    </div>
  );
}

async function PipelineView({ organizationId }: { organizationId: string }) {
  const pipeline = await getLeadPipeline(organizationId);

  const hasLeads = pipeline.some((column) => column.leads.length > 0);
  if (!hasLeads) {
    return (
      <EmptyState
        title="Noch keine offenen Leads"
        description="Anfragen über das Kontakt- und Offertformular erscheinen automatisch in der ersten Spalte."
        action={{ href: '/admin/leads/neu', label: 'Lead erfassen' }}
      />
    );
  }

  return (
    <LeadPipeline
      columns={pipeline.map((column) => ({
        stage: {
          id: column.stage.id,
          name: column.stage.name,
          key: column.stage.key,
          color: column.stage.color,
          isWon: column.stage.isWon,
          isLost: column.stage.isLost,
        },
        count: column.count,
        value: column.value,
        leads: column.leads.map((lead) => ({
          id: lead.id,
          number: lead.number,
          firstName: lead.firstName,
          lastName: lead.lastName,
          company: lead.company,
          email: lead.email,
          phone: lead.phone,
          city: lead.city,
          serviceKind: lead.serviceKind,
          estimatedValue: lead.estimatedValue ? toNumber(lead.estimatedValue) : null,
          score: lead.score,
          status: lead.status,
          stageId: lead.stageId,
          createdAt: lead.createdAt.toISOString(),
          ownerName: lead.owner
            ? `${lead.owner.user.firstName} ${lead.owner.user.lastName}`
            : null,
          tags: lead.tags.map((link) => ({
            id: link.tag.id,
            name: link.tag.name,
            color: link.tag.color,
          })),
        })),
      }))}
    />
  );
}

async function ListView({
  organizationId,
  params,
}: {
  organizationId: string;
  params: Record<string, string | undefined>;
}) {
  const page = Math.max(1, Number(params.seite) || 1);
  const pageSize = 25;

  const { items, total } = await listLeads({
    organizationId,
    page,
    pageSize,
    q: params.q,
    status: params.status as never,
    sort: params.sort,
    order: params.order === 'asc' ? 'asc' : params.order === 'desc' ? 'desc' : undefined,
  });

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  // Die Sortierung gehört in den Blätter-Link: sonst kippt sie beim Umblättern
  // auf den Standard zurück, und Seite 2 zeigt eine andere Ordnung als Seite 1.
  const baseHref = `/admin/leads${toQueryString({
    ansicht: 'liste',
    q: params.q,
    status: params.status,
    sort: params.sort,
    order: params.order,
  })}`;

  return (
    <div className="space-y-6">
      <FilterBar
        searchPlaceholder="Name, Firma oder E-Mail …"
        filters={[
          {
            param: 'status',
            label: 'Status',
            options: [
              { value: 'NEW', label: 'Neu' },
              { value: 'CONTACTED', label: 'Kontaktiert' },
              { value: 'QUALIFIED', label: 'Qualifiziert' },
              { value: 'PROPOSAL', label: 'Offerte' },
              { value: 'WON', label: 'Gewonnen' },
              { value: 'LOST', label: 'Verloren' },
            ],
          },
        ]}
      />

      {items.length === 0 ? (
        <EmptyState
          title="Keine Leads gefunden"
          description="Setzen Sie die Filter zurück oder erfassen Sie einen Lead manuell."
          action={{ href: '/admin/leads/neu', label: 'Lead erfassen' }}
        />
      ) : (
        <ListCard
          footer={
            <Pagination page={page} totalPages={totalPages} total={total} baseHref={baseHref} />
          }
        >
          <TableScroll>
            <table className="data-table">
              <caption className="sr-only">Leadliste. {total} Einträge.</caption>
              <thead>
                <tr>
                  <SortHeader field="lastName">Lead</SortHeader>
                  <th scope="col">Kontakt</th>
                  <th scope="col">Ort</th>
                  <SortHeader field="score" defaultOrder="desc" align="right">
                    Bewertung
                  </SortHeader>
                  <SortHeader field="estimatedValue" defaultOrder="desc" align="right">
                    Wert
                  </SortHeader>
                  <SortHeader field="createdAt" defaultOrder="desc">
                    Eingang
                  </SortHeader>
                  <SortHeader field="status">Status</SortHeader>
                </tr>
              </thead>
              <tbody>
                {items.map((lead) => (
                  <tr key={lead.id}>
                    <td>
                      <Link
                        href={`/admin/leads/${lead.id}`}
                        className="font-medium text-primary underline-offset-4 hover:underline"
                      >
                        {lead.company ?? `${lead.firstName} ${lead.lastName}`}
                      </Link>
                      <span className="block text-xs tabular-nums text-muted-foreground">
                        {lead.number}
                      </span>
                    </td>
                    <td>
                      <span className="block truncate text-sm">{lead.email}</span>
                      {lead.phone ? (
                        <span className="block text-xs text-muted-foreground">{lead.phone}</span>
                      ) : null}
                    </td>
                    <td className="text-muted-foreground">
                      {lead.city ?? lead.postalCode ?? '—'}
                    </td>
                    <td className="num">{lead.score > 0 ? lead.score : '—'}</td>
                    <td className="num">
                      {lead.estimatedValue
                        ? formatCurrency(toNumber(lead.estimatedValue))
                        : '—'}
                    </td>
                    <td className="text-muted-foreground">
                      <span className="block">{formatDate(lead.createdAt)}</span>
                      <span className="block text-xs">{formatRelative(lead.createdAt)}</span>
                    </td>
                    <td>
                      <StatusBadge status={lead.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </ListCard>
      )}
    </div>
  );
}
