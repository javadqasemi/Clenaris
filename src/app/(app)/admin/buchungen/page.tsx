import type { Metadata } from 'next';
import Link from 'next/link';
import { CalendarPlus, ShoppingBag } from 'lucide-react';

import { toNumber } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { formatCurrency, formatDate, formatDuration, formatTime, toQueryString } from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import { listBookings } from '@/server/services/booking.service';
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
  title: 'Buchungen',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const STATUS_FILTER = [
  { value: 'PENDING', label: 'Zu bestätigen' },
  { value: 'CONFIRMED', label: 'Bestätigt' },
  { value: 'IN_PROGRESS', label: 'In Arbeit' },
  { value: 'COMPLETED', label: 'Abgeschlossen' },
  { value: 'CANCELLED', label: 'Storniert' },
];

export default async function AdminBookingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePermission('booking:read');

  const params = await searchParams;
  const organizationId = await getOrganizationId();

  const page = Math.max(1, Number(params.seite) || 1);
  const pageSize = 20;

  const { items, total } = await listBookings({
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
  const baseHref = `/admin/buchungen${toQueryString({
    q: params.q,
    status: params.status,
    sort: params.sort,
    order: params.order,
  })}`;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Buchungen"
        description="Alle Online- und telefonisch erfassten Aufträge. Bestätigte Buchungen erzeugen automatisch einen Einsatz für die Disposition."
        actions={
          <Button asChild>
            <Link href="/buchen">
              <CalendarPlus aria-hidden />
              Buchung erfassen
            </Link>
          </Button>
        }
      >
        <FilterBar
          searchPlaceholder="Nummer, Name oder E-Mail …"
          filters={[{ param: 'status', label: 'Status', options: STATUS_FILTER }]}
        />
      </PageHeader>

      {items.length === 0 ? (
        <EmptyState
          icon={<ShoppingBag aria-hidden />}
          title="Keine Buchungen gefunden"
          description={
            params.q || params.status
              ? 'Für die gewählten Filter gibt es keine Treffer. Setzen Sie die Filter zurück, um alle Buchungen zu sehen.'
              : 'Sobald über die Website gebucht wird, erscheinen die Aufträge hier. Sie können auch selbst eine Buchung erfassen.'
          }
          action={{ href: '/buchen', label: 'Buchung erfassen' }}
        />
      ) : (
        <ListCard
          footer={
            <Pagination page={page} totalPages={totalPages} total={total} baseHref={baseHref} />
          }
        >
          <TableScroll>
            <table className="data-table">
              <caption className="sr-only">
                Buchungsliste, über die Spaltenköpfe sortierbar. {total} Einträge.
              </caption>
              <thead>
                <tr>
                  <SortHeader field="number">Nummer</SortHeader>
                  <th scope="col">Kundschaft</th>
                  <th scope="col">Leistung</th>
                  <SortHeader field="scheduledStart" defaultOrder="desc">
                    Termin
                  </SortHeader>
                  <th scope="col">Dauer</th>
                  <SortHeader field="grossTotal" defaultOrder="desc" align="right">
                    Betrag
                  </SortHeader>
                  <SortHeader field="status">Status</SortHeader>
                </tr>
              </thead>
              <tbody>
                {items.map((booking) => (
                  <tr key={booking.id} className="cursor-pointer">
                    <td>
                      <Link
                        href={`/admin/buchungen/${booking.id}`}
                        className="font-medium tabular-nums text-primary underline-offset-4 hover:underline"
                      >
                        {booking.number}
                      </Link>
                    </td>
                    <td>
                      <span className="block font-medium">
                        {booking.customer.companyName ??
                          `${booking.customer.firstName} ${booking.customer.lastName}`}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {booking.address
                          ? `${booking.address.postalCode} ${booking.address.city}`
                          : booking.customer.email}
                      </span>
                    </td>
                    <td className="text-muted-foreground">{booking.items[0]?.name ?? '—'}</td>
                    <td>
                      <span className="block tabular-nums">{formatDate(booking.scheduledStart)}</span>
                      <span className="block text-xs tabular-nums text-muted-foreground">
                        {formatTime(booking.scheduledStart)} – {formatTime(booking.scheduledEnd)}
                      </span>
                    </td>
                    <td className="text-muted-foreground">{formatDuration(booking.durationMin)}</td>
                    <td className="num font-medium">
                      {formatCurrency(toNumber(booking.grossTotal))}
                    </td>
                    <td>
                      <StatusBadge status={booking.status} />
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
