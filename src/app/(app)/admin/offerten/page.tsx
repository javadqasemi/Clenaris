import type { Metadata } from 'next';
import Link from 'next/link';
import { FileText, Plus } from 'lucide-react';

import { toNumber } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { formatCurrency, formatDate, toQueryString } from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import { listQuotes } from '@/server/services/quote.service';
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

export const metadata: Metadata = {
  title: 'Offerten',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const STATUS_FILTER = [
  { value: 'DRAFT', label: 'Entwurf' },
  { value: 'SENT', label: 'Versendet' },
  { value: 'VIEWED', label: 'Angesehen' },
  { value: 'ACCEPTED', label: 'Angenommen' },
  { value: 'REJECTED', label: 'Abgelehnt' },
  { value: 'EXPIRED', label: 'Abgelaufen' },
  { value: 'CONVERTED', label: 'Umgewandelt' },
];

export default async function AdminQuotesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePermission('quote:read');

  const params = await searchParams;
  const organizationId = await getOrganizationId();

  const page = Math.max(1, Number(params.seite) || 1);
  const pageSize = 25;

  const { items, total } = await listQuotes({
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
  const baseHref = `/admin/offerten${toQueryString({
    q: params.q,
    status: params.status,
    sort: params.sort,
    order: params.order,
  })}`;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Offerten"
        description="Kundschaft kann Offerten online ansehen und mit Unterschrift direkt annehmen — ohne Ausdrucken und Zurückschicken."
        actions={
          <Button asChild>
            <Link href="/admin/offerten/neu">
              <Plus aria-hidden />
              Offerte erstellen
            </Link>
          </Button>
        }
      >
        <FilterBar
          searchPlaceholder="Nummer, Betreff oder Kundschaft …"
          filters={[{ param: 'status', label: 'Status', options: STATUS_FILTER }]}
        />
      </PageHeader>

      {items.length === 0 ? (
        <EmptyState
          icon={<FileText aria-hidden />}
          title="Keine Offerten gefunden"
          description="Erstellen Sie eine Offerte — mit dem KI-Entwurf entsteht aus einer Kundenanfrage in Sekunden ein Vorschlag."
          action={{ href: '/admin/offerten/neu', label: 'Offerte erstellen' }}
        />
      ) : (
        <ListCard
          footer={
            <Pagination page={page} totalPages={totalPages} total={total} baseHref={baseHref} />
          }
        >
          <TableScroll>
            <table className="data-table">
              <caption className="sr-only">Offertenliste. {total} Einträge.</caption>
              <thead>
                <tr>
                  <SortHeader field="number">Nummer</SortHeader>
                  <SortHeader field="title">Betreff</SortHeader>
                  <th scope="col">Empfänger</th>
                  <SortHeader field="validUntil" defaultOrder="asc">
                    Gültig bis
                  </SortHeader>
                  <SortHeader field="grossTotal" defaultOrder="desc" align="right">
                    Betrag
                  </SortHeader>
                  <SortHeader field="status">Status</SortHeader>
                </tr>
              </thead>
              <tbody>
                {items.map((quote) => {
                  const recipient =
                    quote.customer?.companyName ??
                    (quote.customer
                      ? `${quote.customer.firstName} ${quote.customer.lastName}`
                      : quote.lead
                        ? `${quote.lead.firstName} ${quote.lead.lastName} (Lead)`
                        : '—');

                  const expiringSoon =
                    ['SENT', 'VIEWED'].includes(quote.status) &&
                    quote.validUntil.getTime() - Date.now() < 3 * 86_400_000;

                  return (
                    <tr key={quote.id}>
                      <td>
                        <Link
                          href={`/admin/offerten/${quote.id}`}
                          className="font-medium tabular-nums text-primary underline-offset-4 hover:underline"
                        >
                          {quote.number}
                        </Link>
                      </td>
                      <td className="max-w-[16rem] truncate">{quote.title}</td>
                      <td className="text-muted-foreground">{recipient}</td>
                      <td
                        className={
                          expiringSoon
                            ? 'tabular-nums font-medium text-warning'
                            : 'tabular-nums text-muted-foreground'
                        }
                      >
                        {formatDate(quote.validUntil)}
                      </td>
                      <td className="num font-medium">
                        {formatCurrency(toNumber(quote.grossTotal))}
                      </td>
                      <td>
                        <StatusBadge status={quote.status} />
                      </td>
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
