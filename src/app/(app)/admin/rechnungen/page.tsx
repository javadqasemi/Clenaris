import type { Metadata } from 'next';
import Link from 'next/link';
import { Download, Plus, Receipt } from 'lucide-react';

import { toNumber } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { formatCurrency, formatDate, toQueryString } from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import { listInvoices } from '@/server/services/invoice.service';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { KpiTile } from '@/components/app/kpi-tile';
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
  title: 'Rechnungen',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const STATUS_FILTER = [
  { value: 'DRAFT', label: 'Entwurf' },
  { value: 'ISSUED', label: 'Ausgestellt' },
  { value: 'SENT', label: 'Versendet' },
  { value: 'PARTIALLY_PAID', label: 'Teilbezahlt' },
  { value: 'PAID', label: 'Bezahlt' },
  { value: 'OVERDUE', label: 'Überfällig' },
  { value: 'CANCELLED', label: 'Storniert' },
];

export default async function AdminInvoicesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePermission('invoice:read');

  const params = await searchParams;
  const organizationId = await getOrganizationId();

  const page = Math.max(1, Number(params.seite) || 1);
  const pageSize = 25;

  const { items, total, totals } = await listInvoices({
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
  const baseHref = `/admin/rechnungen${toQueryString({
    q: params.q,
    status: params.status,
    sort: params.sort,
    order: params.order,
  })}`;

  const year = new Date().getFullYear();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Rechnungen"
        description="Ausgestellte Rechnungen sind unveränderlich. Korrekturen laufen über eine Gutschrift — so bleibt die Buchhaltung revisionssicher."
        actions={
          <>
            <Button asChild variant="outline">
              <a href={`/api/exports/rechnungen?from=${year}-01-01&to=${year}-12-31`} download>
                <Download aria-hidden />
                Excel
              </a>
            </Button>
            <Button asChild>
              <Link href="/admin/rechnungen/neu">
                <Plus aria-hidden />
                Rechnung erstellen
              </Link>
            </Button>
          </>
        }
      >
        <FilterBar
          searchPlaceholder="Nummer oder Empfänger …"
          filters={[{ param: 'status', label: 'Status', options: STATUS_FILTER }]}
        />
      </PageHeader>

      <div className="grid gap-4 sm:grid-cols-3">
        <KpiTile label="Rechnungsbetrag (Auswahl)" value={formatCurrency(totals.gross)} />
        <KpiTile
          label="Offener Betrag"
          value={formatCurrency(totals.outstanding)}
          accent={totals.outstanding > 0 ? 'warning' : undefined}
        />
        <KpiTile
          label="Zahlungsquote"
          value={
            totals.gross > 0
              ? `${Math.round(((totals.gross - totals.outstanding) / totals.gross) * 100)} %`
              : '—'
          }
        />
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon={<Receipt aria-hidden />}
          title="Keine Rechnungen gefunden"
          description="Rechnungen entstehen aus abgeschlossenen Einsätzen oder aus angenommenen Offerten."
          action={{ href: '/admin/einsaetze?status=COMPLETED', label: 'Abgeschlossene Einsätze' }}
        />
      ) : (
        <ListCard
          footer={
            <Pagination page={page} totalPages={totalPages} total={total} baseHref={baseHref} />
          }
        >
          <TableScroll>
            <table className="data-table">
              <caption className="sr-only">Rechnungsliste. {total} Einträge.</caption>
              <thead>
                <tr>
                  <SortHeader field="number">Nummer</SortHeader>
                  <SortHeader field="billToName">Empfänger</SortHeader>
                  <SortHeader field="issueDate" defaultOrder="desc">
                    Datum
                  </SortHeader>
                  <SortHeader field="dueDate" defaultOrder="asc">
                    Fällig
                  </SortHeader>
                  <SortHeader field="grossTotal" defaultOrder="desc" align="right">
                    Betrag
                  </SortHeader>
                  <SortHeader field="balance" defaultOrder="desc" align="right">
                    Offen
                  </SortHeader>
                  <SortHeader field="status">Status</SortHeader>
                </tr>
              </thead>
              <tbody>
                {items.map((invoice) => {
                  const balance = toNumber(invoice.balance);
                  const overdue = invoice.status === 'OVERDUE';

                  return (
                    <tr key={invoice.id}>
                      <td>
                        <Link
                          href={`/admin/rechnungen/${invoice.id}`}
                          className="font-medium tabular-nums text-primary underline-offset-4 hover:underline"
                        >
                          {invoice.number}
                        </Link>
                        {invoice.reminderLevel > 0 ? (
                          <span className="block text-xs text-destructive">
                            Mahnstufe {invoice.reminderLevel}
                          </span>
                        ) : null}
                      </td>
                      <td>
                        <span className="block truncate font-medium">
                          {invoice.billToCompany ?? invoice.billToName}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {invoice.billToZip} {invoice.billToCity}
                        </span>
                      </td>
                      <td className="tabular-nums text-muted-foreground">
                        {formatDate(invoice.issueDate)}
                      </td>
                      <td
                        className={
                          overdue ? 'tabular-nums font-medium text-destructive' : 'tabular-nums text-muted-foreground'
                        }
                      >
                        {formatDate(invoice.dueDate)}
                      </td>
                      <td className="num font-medium">
                        {formatCurrency(toNumber(invoice.grossTotal))}
                      </td>
                      <td className={balance > 0 ? 'num text-warning' : 'num text-muted-foreground'}>
                        {balance > 0 ? formatCurrency(balance) : '—'}
                      </td>
                      <td>
                        <StatusBadge status={invoice.status} />
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
