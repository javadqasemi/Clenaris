import type { Metadata } from 'next';
import Link from 'next/link';
import { Download, UserPlus, Users } from 'lucide-react';

import { toNumber } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { formatCurrency, formatDate, formatPhone, toQueryString } from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import { listCustomers } from '@/server/services/crm.service';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PersonAvatar } from '@/components/ui/primitives';
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
  title: 'Kunden',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function AdminCustomersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePermission('customer:read');

  const params = await searchParams;
  const organizationId = await getOrganizationId();

  const page = Math.max(1, Number(params.seite) || 1);
  const pageSize = 25;

  const { items, total } = await listCustomers({
    organizationId,
    page,
    pageSize,
    q: params.q,
    type: params.typ as never,
    sort: params.sort,
    order: params.order === 'asc' ? 'asc' : params.order === 'desc' ? 'desc' : undefined,
  });

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  // Die Sortierung gehört in den Blätter-Link: sonst kippt sie beim Umblättern
  // auf den Standard zurück, und Seite 2 zeigt eine andere Ordnung als Seite 1.
  const baseHref = `/admin/kunden${toQueryString({
    q: params.q,
    typ: params.typ,
    sort: params.sort,
    order: params.order,
  })}`;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Kunden"
        description="Stammdaten, Objekte, Umsatzhistorie und offene Posten — alles an einem Ort."
        actions={
          <>
            <Button asChild variant="outline">
              <a href="/api/exports/kunden" download>
                <Download aria-hidden />
                Excel
              </a>
            </Button>
            <Button asChild>
              <Link href="/admin/kunden/neu">
                <UserPlus aria-hidden />
                Kunde erfassen
              </Link>
            </Button>
          </>
        }
      >
        <FilterBar
          searchPlaceholder="Name, Firma, E-Mail oder Telefon …"
          filters={[
            {
              param: 'typ',
              label: 'Typ',
              options: [
                { value: 'PRIVATE', label: 'Privat' },
                { value: 'BUSINESS', label: 'Geschäft' },
              ],
            },
          ]}
        />
      </PageHeader>

      {items.length === 0 ? (
        <EmptyState
          icon={<Users aria-hidden />}
          title="Keine Kunden gefunden"
          description="Buchungen über die Website legen Kundendatensätze automatisch an. Sie können auch selbst einen erfassen."
          action={{ href: '/admin/kunden/neu', label: 'Kunde erfassen' }}
        />
      ) : (
        <ListCard
          footer={
            <Pagination page={page} totalPages={totalPages} total={total} baseHref={baseHref} />
          }
        >
          <TableScroll>
            <table className="data-table">
              <caption className="sr-only">Kundenliste. {total} Einträge.</caption>
              <thead>
                <tr>
                  <SortHeader field="lastName">Kundschaft</SortHeader>
                  <SortHeader field="number">Nummer</SortHeader>
                  <th scope="col">Kontakt</th>
                  <th scope="col">Ort</th>
                  <SortHeader field="totalBookings" defaultOrder="desc" align="right">
                    Buchungen
                  </SortHeader>
                  <SortHeader field="lifetimeValue" defaultOrder="desc" align="right">
                    Umsatz
                  </SortHeader>
                  <SortHeader field="lastBookingAt" defaultOrder="desc">
                    Zuletzt
                  </SortHeader>
                </tr>
              </thead>
              <tbody>
                {items.map((customer) => {
                  const address = customer.addresses[0];
                  return (
                    <tr key={customer.id}>
                      <td>
                        <Link
                          href={`/admin/kunden/${customer.id}`}
                          className="flex items-center gap-3"
                        >
                          <PersonAvatar
                            firstName={customer.firstName}
                            lastName={customer.lastName}
                            size="sm"
                          />
                          <span className="min-w-0">
                            <span className="block truncate font-medium text-primary underline-offset-4 hover:underline">
                              {customer.companyName ??
                                `${customer.firstName} ${customer.lastName}`}
                            </span>
                            <span className="flex flex-wrap items-center gap-1.5">
                              {customer.type === 'BUSINESS' ? (
                                <Badge variant="neutral" size="sm">
                                  Geschäft
                                </Badge>
                              ) : null}
                              {customer.tags.slice(0, 2).map((link) => (
                                <Badge
                                  key={link.tagId}
                                  size="sm"
                                  variant="outline"
                                  style={{ borderColor: `${link.tag.color}55`, color: link.tag.color }}
                                >
                                  {link.tag.name}
                                </Badge>
                              ))}
                            </span>
                          </span>
                        </Link>
                      </td>
                      <td className="tabular-nums text-muted-foreground">{customer.number}</td>
                      <td>
                        <span className="block truncate text-sm">{customer.email}</span>
                        {customer.phone ? (
                          <span className="block text-xs tabular-nums text-muted-foreground">
                            {formatPhone(customer.phone)}
                          </span>
                        ) : null}
                      </td>
                      <td className="text-muted-foreground">
                        {address ? `${address.postalCode} ${address.city}` : '—'}
                      </td>
                      <td className="num">{customer.totalBookings}</td>
                      <td className="num font-medium">
                        {formatCurrency(toNumber(customer.lifetimeValue))}
                      </td>
                      <td className="text-muted-foreground">
                        {customer.lastBookingAt ? formatDate(customer.lastBookingAt) : '—'}
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
