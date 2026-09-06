import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, FileText, MapPin, Receipt, Truck, User } from 'lucide-react';

import { toNumber } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { NotFoundError } from '@/lib/errors';
import {
  formatCurrency,
  formatDateLong,
  formatDateTime,
  formatDuration,
  formatPhone,
  timeRangeLabel,
} from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import { getBookingDetail } from '@/server/services/booking.service';
import { navigationUrl } from '@/lib/maps/google';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PersonAvatar } from '@/components/ui/primitives';
import { DetailRow, DetailSection, PageHeader } from '@/components/app/page-parts';
import { BookingActions } from '@/features/admin/booking-actions';

export const metadata: Metadata = {
  title: 'Buchung',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function AdminBookingDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePermission('booking:read');

  const { id } = await params;
  const organizationId = await getOrganizationId();

  const booking = await getBookingDetail({ organizationId, bookingId: id }).catch((error) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });

  const address = booking.address
    ? `${booking.address.street} ${booking.address.streetNo ?? ''}, ${booking.address.postalCode} ${booking.address.city}`.replace(
        /\s+/g,
        ' ',
      )
    : null;

  const breakdown = booking.priceBreakdown as {
    lines?: { key: string; label: string; amount: number; kind: string }[];
  } | null;

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-3">
        <Link href="/admin/buchungen">
          <ArrowLeft aria-hidden />
          Alle Buchungen
        </Link>
      </Button>

      <PageHeader
        title={`Buchung ${booking.number}`}
        description={`Erfasst am ${formatDateTime(booking.createdAt)} über ${booking.source === 'WEBSITE' ? 'die Website' : 'das Büro'}.`}
        actions={
          <>
            <StatusBadge status={booking.status} className="self-center" />
            <BookingActions
              bookingId={booking.id}
              status={booking.status}
              scheduledStart={booking.scheduledStart.toISOString()}
              hasInvoice={booking.invoices.length > 0}
            />
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        <div className="space-y-6">
          <DetailSection title="Auftrag">
            <dl className="protocol-list">
              <DetailRow label="Leistung">
                {booking.items.map((item) => (
                  <span key={item.id} className="block">
                    {item.name} · {toNumber(item.quantity)} {item.unit}
                  </span>
                ))}
              </DetailRow>
              <DetailRow label="Termin">
                {formatDateLong(booking.scheduledStart)}
                <span className="block text-muted-foreground">
                  {timeRangeLabel(booking.scheduledStart, booking.scheduledEnd)} Uhr ·{' '}
                  {formatDuration(booking.durationMin)} · {booking.crewSize}{' '}
                  {booking.crewSize === 1 ? 'Person' : 'Personen'}
                </span>
              </DetailRow>
              <DetailRow label="Turnus">
                {booking.frequency === 'ONCE' ? 'Einmalig' : 'Wiederkehrend'}
                {booking.parentBookingId ? ' (Folgetermin einer Serie)' : ''}
              </DetailRow>
              <DetailRow label="Objekt">
                {booking.squareMeters ? `${booking.squareMeters} m²` : '—'}
                {booking.rooms ? ` · ${toNumber(booking.rooms)} Zimmer` : ''}
                {booking.windows ? ` · ${booking.windows} Fenster` : ''}
              </DetailRow>
              {address ? (
                <DetailRow label="Adresse">
                  <span className="flex flex-wrap items-center gap-2">
                    {address}
                    <a
                      href={navigationUrl(address)}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
                    >
                      <MapPin className="size-3.5" aria-hidden />
                      Navigation
                    </a>
                  </span>
                </DetailRow>
              ) : null}
              {booking.accessNote ? (
                <DetailRow label="Zugang">{booking.accessNote}</DetailRow>
              ) : null}
              {booking.customerNote ? (
                <DetailRow label="Anmerkung der Kundschaft">
                  <span className="whitespace-pre-line">{booking.customerNote}</span>
                </DetailRow>
              ) : null}
              {booking.internalNote ? (
                <DetailRow label="Interne Notiz">
                  <span className="whitespace-pre-line">{booking.internalNote}</span>
                </DetailRow>
              ) : null}
              {booking.cancelReason ? (
                <DetailRow label="Stornogrund">{booking.cancelReason}</DetailRow>
              ) : null}
            </dl>
          </DetailSection>

          {booking.extras.length > 0 ? (
            <DetailSection title="Zusatzleistungen">
              <dl className="protocol-list">
                {booking.extras.map((extra) => (
                  <DetailRow key={extra.id} label={extra.name}>
                    {extra.quantity} × {formatCurrency(toNumber(extra.unitPrice))} ={' '}
                    {formatCurrency(toNumber(extra.lineTotal))}
                  </DetailRow>
                ))}
              </dl>
            </DetailSection>
          ) : null}

          <DetailSection
            title="Einsätze"
            action={
              <Button asChild variant="ghost" size="sm">
                <Link href="/admin/kalender">Kalender öffnen</Link>
              </Button>
            }
          >
            {booking.jobs.length === 0 ? (
              <p className="py-6 text-sm text-muted-foreground">
                Noch kein Einsatz erzeugt. Bestätigen Sie die Buchung, damit sie in die Disposition
                gelangt.
              </p>
            ) : (
              <ul className="protocol-list">
                {booking.jobs.map((job) => (
                  <li key={job.id} className="flex flex-wrap items-center gap-4 py-4">
                    <Truck className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <Link
                      href={`/admin/einsaetze/${job.id}`}
                      className="font-medium tabular-nums text-primary underline-offset-4 hover:underline"
                    >
                      {job.number}
                    </Link>
                    <span className="text-sm text-muted-foreground">
                      {formatDateTime(job.scheduledStart)}
                    </span>
                    <div className="flex -space-x-2">
                      {job.assignments.map((assignment) => (
                        <PersonAvatar
                          key={assignment.id}
                          firstName={assignment.employee.user.firstName}
                          lastName={assignment.employee.user.lastName}
                          src={assignment.employee.user.avatarUrl}
                          color={assignment.employee.color}
                          size="sm"
                          className="ring-2 ring-card"
                        />
                      ))}
                    </div>
                    <StatusBadge status={job.status} className="ml-auto" />
                  </li>
                ))}
              </ul>
            )}
          </DetailSection>

          {booking.invoices.length > 0 ? (
            <DetailSection title="Rechnungen">
              <ul className="protocol-list">
                {booking.invoices.map((invoice) => (
                  <li key={invoice.id} className="flex flex-wrap items-center gap-4 py-4">
                    <Receipt className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <Link
                      href={`/admin/rechnungen/${invoice.id}`}
                      className="font-medium tabular-nums text-primary underline-offset-4 hover:underline"
                    >
                      {invoice.number}
                    </Link>
                    <span className="text-sm tabular-nums">
                      {formatCurrency(toNumber(invoice.grossTotal))}
                    </span>
                    {toNumber(invoice.balance) > 0 ? (
                      <span className="text-sm tabular-nums text-warning">
                        offen {formatCurrency(toNumber(invoice.balance))}
                      </span>
                    ) : null}
                    <StatusBadge status={invoice.status} className="ml-auto" />
                  </li>
                ))}
              </ul>
            </DetailSection>
          ) : null}
        </div>

        {/* Seitenspalte */}
        <div className="space-y-6">
          <DetailSection title="Kundschaft">
            <dl className="protocol-list">
              <DetailRow label="Name">
                <Link
                  href={`/admin/kunden/${booking.customer.id}`}
                  className="inline-flex items-center gap-2 text-primary underline-offset-4 hover:underline"
                >
                  <User className="size-3.5" aria-hidden />
                  {booking.customer.companyName ??
                    `${booking.customer.firstName} ${booking.customer.lastName}`}
                </Link>
              </DetailRow>
              <DetailRow label="Kundennummer">{booking.customer.number}</DetailRow>
              <DetailRow label="E-Mail">
                <a
                  href={`mailto:${booking.customer.email}`}
                  className="text-primary underline-offset-4 hover:underline"
                >
                  {booking.customer.email}
                </a>
              </DetailRow>
              {booking.customer.phone ? (
                <DetailRow label="Telefon">
                  <a
                    href={`tel:${booking.customer.phone}`}
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    {formatPhone(booking.customer.phone)}
                  </a>
                </DetailRow>
              ) : null}
            </dl>
          </DetailSection>

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
                <dt className="text-sm text-muted-foreground">Netto</dt>
                <dd className="text-sm tabular-nums">
                  {formatCurrency(toNumber(booking.netTotal))}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-4 py-2.5">
                <dt className="text-sm text-muted-foreground">
                  MWST {toNumber(booking.vatRate).toFixed(1)} %
                </dt>
                <dd className="text-sm tabular-nums">
                  {formatCurrency(toNumber(booking.vatAmount))}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-4 py-3">
                <dt className="font-semibold">Total</dt>
                <dd className="font-display text-lg font-bold tabular-nums">
                  {formatCurrency(toNumber(booking.grossTotal))}
                </dd>
              </div>
            </dl>
          </DetailSection>

          {booking.files.length > 0 ? (
            <DetailSection title="Dateien der Kundschaft">
              <ul className="protocol-list">
                {booking.files.map((file) => (
                  <li key={file.id} className="flex items-center gap-3 py-3">
                    <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <a
                      href={file.url}
                      target="_blank"
                      rel="noreferrer"
                      className="truncate text-sm text-primary underline-offset-4 hover:underline"
                    >
                      {file.filename}
                    </a>
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
