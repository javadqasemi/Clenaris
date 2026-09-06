import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Camera, Clock, MapPin, Receipt } from 'lucide-react';

import { toNumber } from '@/lib/db';
import { requireCustomerId } from '@/lib/auth/session';
import { NotFoundError } from '@/lib/errors';
import { formatCurrency, formatDateLong, formatDuration, timeRangeLabel } from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import { getBookingDetail } from '@/server/services/booking.service';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PersonAvatar } from '@/components/ui/primitives';
import { DetailRow, DetailSection, PageHeader } from '@/components/app/page-parts';
import { CustomerBookingActions } from '@/features/account/booking-actions';

export const metadata: Metadata = {
  title: 'Termin',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function AccountBookingDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { customerId } = await requireCustomerId();

  const { id } = await params;
  const organizationId = await getOrganizationId();

  // `customerId` erzwingt die Eigentümerprüfung im Service.
  const booking = await getBookingDetail({ organizationId, bookingId: id, customerId }).catch(
    (error) => {
      if (error instanceof NotFoundError) notFound();
      throw error;
    },
  );

  const address = booking.address
    ? `${booking.address.street} ${booking.address.streetNo ?? ''}, ${booking.address.postalCode} ${booking.address.city}`.replace(
        /\s+/g,
        ' ',
      )
    : null;

  const crew = booking.jobs.flatMap((job) => job.assignments);
  const photos = booking.jobs.flatMap((job) => job.photos);
  const breakdown = booking.priceBreakdown as {
    lines?: { key: string; label: string; amount: number; kind: string }[];
  } | null;

  const hoursUntil = (booking.scheduledStart.getTime() - Date.now()) / 3_600_000;
  const canModify =
    ['PENDING', 'CONFIRMED'].includes(booking.status) && hoursUntil > 24;

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-3">
        <Link href="/konto/buchungen">
          <ArrowLeft aria-hidden />
          Meine Termine
        </Link>
      </Button>

      <PageHeader
        title={formatDateLong(booking.scheduledStart)}
        description={`${booking.items[0]?.name ?? 'Reinigung'} · Buchung ${booking.number}`}
        actions={
          <>
            <StatusBadge status={booking.status} className="self-center" />
            <CustomerBookingActions
              bookingId={booking.id}
              canModify={canModify}
              status={booking.status}
              scheduledStart={booking.scheduledStart.toISOString()}
            />
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
        <div className="space-y-6">
          <DetailSection title="Ihr Termin">
            <dl className="protocol-list">
              <DetailRow label="Datum">{formatDateLong(booking.scheduledStart)}</DetailRow>
              <DetailRow label="Zeitfenster">
                <span className="inline-flex items-center gap-2">
                  <Clock className="size-3.5 text-muted-foreground" aria-hidden />
                  {timeRangeLabel(booking.scheduledStart, booking.scheduledEnd)} Uhr ·{' '}
                  {formatDuration(booking.durationMin)}
                </span>
              </DetailRow>
              {address ? (
                <DetailRow label="Adresse">
                  <span className="inline-flex items-start gap-2">
                    <MapPin className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    {address}
                  </span>
                </DetailRow>
              ) : null}
              <DetailRow label="Objekt">
                {booking.squareMeters ? `${booking.squareMeters} m²` : '—'}
                {booking.rooms ? ` · ${toNumber(booking.rooms)} Zimmer` : ''}
              </DetailRow>
              {booking.customerNote ? (
                <DetailRow label="Ihre Anmerkung">
                  <span className="whitespace-pre-line">{booking.customerNote}</span>
                </DetailRow>
              ) : null}
            </dl>
          </DetailSection>

          {booking.extras.length > 0 ? (
            <DetailSection title="Zusatzleistungen">
              <dl className="protocol-list">
                {booking.extras.map((extra) => (
                  <DetailRow key={extra.id} label={extra.name}>
                    {extra.quantity} × {formatCurrency(toNumber(extra.unitPrice))}
                  </DetailRow>
                ))}
              </dl>
            </DetailSection>
          ) : null}

          {/* Fotos vom Einsatz */}
          {photos.length > 0 ? (
            <DetailSection title="Fotos vom Einsatz">
              <div className="space-y-5 py-4">
                {[
                  { label: 'Vorher', list: photos.filter((photo) => photo.type === 'BEFORE') },
                  { label: 'Nachher', list: photos.filter((photo) => photo.type === 'AFTER') },
                ]
                  .filter((group) => group.list.length > 0)
                  .map((group) => (
                    <div key={group.label} className="space-y-2">
                      <h3 className="text-sm font-medium text-muted-foreground">{group.label}</h3>
                      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                        {group.list.map((photo) => (
                          <li key={photo.id}>
                            <a
                              href={photo.url}
                              target="_blank"
                              rel="noreferrer"
                              className="block overflow-hidden rounded-xl border border-border transition-opacity hover:opacity-85"
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={photo.thumbnailUrl ?? photo.url}
                                alt={photo.caption ?? `${group.label}-Aufnahme`}
                                className="aspect-square w-full object-cover"
                                loading="lazy"
                              />
                            </a>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
              </div>
            </DetailSection>
          ) : booking.status === 'COMPLETED' ? (
            <DetailSection title="Fotos vom Einsatz">
              <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                <Camera className="size-4" aria-hidden />
                Für diesen Einsatz wurden keine Fotos hinterlegt.
              </p>
            </DetailSection>
          ) : null}
        </div>

        {/* Seitenspalte */}
        <div className="space-y-6">
          <DetailSection title="Preis">
            <dl className="protocol-list">
              {breakdown?.lines?.map((line) => (
                <div key={line.key} className="flex items-baseline justify-between gap-4 py-2.5">
                  <dt
                    className={
                      line.kind === 'discount'
                        ? 'text-sm text-success'
                        : 'text-sm text-muted-foreground'
                    }
                  >
                    {line.label}
                  </dt>
                  <dd className="text-sm tabular-nums">{formatCurrency(line.amount)}</dd>
                </div>
              ))}
              <div className="flex items-baseline justify-between gap-4 py-2.5">
                <dt className="text-sm text-muted-foreground">
                  MWST {toNumber(booking.vatRate).toFixed(1)} %
                </dt>
                <dd className="text-sm tabular-nums">
                  {formatCurrency(toNumber(booking.vatAmount))}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-4 py-3">
                <dt className="font-semibold">Gesamtbetrag</dt>
                <dd className="font-display text-lg font-bold tabular-nums">
                  {formatCurrency(toNumber(booking.grossTotal))}
                </dd>
              </div>
            </dl>
          </DetailSection>

          {crew.length > 0 ? (
            <DetailSection title="Ihr Team">
              <ul className="protocol-list">
                {crew.map((assignment) => (
                  <li key={assignment.id} className="flex items-center gap-3 py-3">
                    <PersonAvatar
                      firstName={assignment.employee.user.firstName}
                      lastName={assignment.employee.user.lastName}
                      src={assignment.employee.user.avatarUrl}
                      color={assignment.employee.color}
                      size="sm"
                    />
                    <span className="text-sm font-medium">
                      {assignment.employee.user.firstName} {assignment.employee.user.lastName}
                    </span>
                  </li>
                ))}
              </ul>
            </DetailSection>
          ) : null}

          {booking.invoices.length > 0 ? (
            <DetailSection title="Rechnung">
              <ul className="protocol-list">
                {booking.invoices.map((invoice) => (
                  <li key={invoice.id} className="flex items-center justify-between gap-3 py-3">
                    <Link
                      href={`/konto/rechnungen/${invoice.id}`}
                      className="inline-flex items-center gap-2 text-sm text-primary underline-offset-4 hover:underline"
                    >
                      <Receipt className="size-3.5" aria-hidden />
                      {invoice.number}
                    </Link>
                    <span className="text-sm tabular-nums">
                      {formatCurrency(toNumber(invoice.grossTotal))}
                    </span>
                  </li>
                ))}
              </ul>
            </DetailSection>
          ) : null}
        </div>
      </div>
    </div>
  );
}
