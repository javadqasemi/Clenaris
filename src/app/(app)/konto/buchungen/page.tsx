import type { Metadata } from 'next';
import Link from 'next/link';
import { CalendarPlus, Clock, MapPin } from 'lucide-react';

import { toNumber } from '@/lib/db';
import { requireCustomerId } from '@/lib/auth/session';
import { formatCurrency, formatDateLong, timeRangeLabel } from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import { listBookings } from '@/server/services/booking.service';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTriggerUnderline } from '@/components/ui/controls';
import { EmptyState, PageHeader } from '@/components/app/page-parts';

export const metadata: Metadata = {
  title: 'Meine Termine',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function AccountBookingsPage() {
  const { customerId } = await requireCustomerId();
  const organizationId = await getOrganizationId();

  const now = new Date();

  const [upcoming, past] = await Promise.all([
    listBookings({
      organizationId,
      customerId,
      page: 1,
      pageSize: 50,
      from: new Date(now.getTime() - 4 * 3_600_000),
      order: 'asc',
      sort: 'scheduledStart',
    }),
    listBookings({
      organizationId,
      customerId,
      page: 1,
      pageSize: 50,
      to: now,
      order: 'desc',
      sort: 'scheduledStart',
    }),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Meine Termine"
        description="Termine verschieben oder stornieren können Sie bis 24 Stunden vorher selbst."
        actions={
          <Button asChild>
            <Link href="/buchen">
              <CalendarPlus aria-hidden />
              Neuer Termin
            </Link>
          </Button>
        }
      />

      <Tabs defaultValue="kommend">
        <TabsList variant="underline">
          <TabsTriggerUnderline value="kommend">
            Kommend ({upcoming.items.length})
          </TabsTriggerUnderline>
          <TabsTriggerUnderline value="vergangen">
            Vergangen ({past.items.length})
          </TabsTriggerUnderline>
        </TabsList>

        <TabsContent value="kommend">
          {upcoming.items.length === 0 ? (
            <EmptyState
              icon={<CalendarPlus aria-hidden />}
              title="Kein Termin geplant"
              description="Buchen Sie Ihren nächsten Reinigungstermin — Preis und freie Zeitfenster sehen Sie sofort."
              action={{ href: '/buchen', label: 'Termin buchen' }}
            />
          ) : (
            <BookingList bookings={upcoming.items} />
          )}
        </TabsContent>

        <TabsContent value="vergangen">
          {past.items.length === 0 ? (
            <EmptyState
              title="Noch keine vergangenen Termine"
              description="Hier finden Sie später Ihre Einsatzberichte mit Vorher-/Nachher-Fotos."
            />
          ) : (
            <BookingList bookings={past.items} />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

type BookingListItem = Awaited<ReturnType<typeof listBookings>>['items'][number];

function BookingList({ bookings }: { bookings: BookingListItem[] }) {
  return (
    <ul className="space-y-3">
      {bookings.map((booking) => (
        <li key={booking.id}>
          <Link
            href={`/konto/buchungen/${booking.id}`}
            className="block rounded-2xl border border-border bg-card p-5 shadow-soft transition-[border-color,box-shadow] duration-300 ease-spring hover:border-primary/30 hover:shadow-card"
          >
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0 space-y-1.5">
                <p className="font-display text-lg font-semibold tracking-tight">
                  {formatDateLong(booking.scheduledStart)}
                </p>
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Clock className="size-3.5 shrink-0" aria-hidden />
                  {timeRangeLabel(booking.scheduledStart, booking.scheduledEnd)} Uhr
                </p>
                <p className="font-medium">{booking.items[0]?.name ?? 'Reinigung'}</p>
                {booking.address ? (
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <MapPin className="size-3.5 shrink-0" aria-hidden />
                    {booking.address.street} {booking.address.streetNo},{' '}
                    {booking.address.postalCode} {booking.address.city}
                  </p>
                ) : null}
              </div>

              <div className="flex flex-col items-end gap-2">
                <StatusBadge status={booking.status} />
                <span className="font-semibold tabular-nums">
                  {formatCurrency(toNumber(booking.grossTotal))}
                </span>
                <span className="text-xs tabular-nums text-muted-foreground">{booking.number}</span>
              </div>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
