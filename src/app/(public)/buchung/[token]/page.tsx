import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CalendarCheck, Clock, MapPin, UserPlus } from 'lucide-react';

import { toNumber } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';
import { formatCurrency, formatDateLong, formatDuration, timeRangeLabel } from '@/lib/utils';
import { getBookingByToken } from '@/server/services/booking.service';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/primitives';

export const metadata: Metadata = {
  title: 'Ihre Buchung',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Buchungsverwaltung ohne Konto.
 *
 * Gastbuchungen sind bewusst möglich — ein Pflichtkonto vor der ersten
 * Buchung kostet messbar Abschlüsse. Die Verwaltung läuft über einen
 * unerratbaren Token aus der Bestätigungsmail. Wer regelmässig bucht, dem
 * bieten wir das Konto hier an, statt es vorher zu verlangen.
 */
export default async function GuestBookingPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const booking = await getBookingByToken(token).catch((error) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });

  const address = booking.address
    ? `${booking.address.street} ${booking.address.streetNo ?? ''}, ${booking.address.postalCode} ${booking.address.city}`.replace(
        /\s+/g,
        ' ',
      )
    : null;

  const hoursUntil = (booking.scheduledStart.getTime() - Date.now()) / 3_600_000;
  const canModify = ['PENDING', 'CONFIRMED'].includes(booking.status) && hoursUntil > 24;

  return (
    <div className="container max-w-2xl py-12 sm:py-16">
      <header className="mb-8 space-y-3">
        <p className="text-sm text-muted-foreground">Buchung {booking.number}</p>
        <h1 className="text-headline font-bold text-balance">
          {booking.items[0]?.service.name ?? 'Ihre Reinigung'}
        </h1>
        <StatusBadge status={booking.status} />
      </header>

      {booking.status === 'PENDING' ? (
        <Alert variant="info" title="Wir prüfen Ihren Termin" className="mb-8">
          In der Regel bestätigen wir innerhalb von zwei Stunden. Sie erhalten eine E-Mail, sobald
          der Termin fix ist.
        </Alert>
      ) : booking.status === 'CONFIRMED' ? (
        <Alert variant="success" title="Termin bestätigt" className="mb-8">
          Unser Team ist zum vereinbarten Zeitpunkt vor Ort. Bitte sorgen Sie dafür, dass wir ins
          Gebäude kommen.
        </Alert>
      ) : booking.status === 'CANCELLED' ? (
        <Alert variant="warning" title="Buchung storniert" className="mb-8">
          {booking.cancelReason ?? 'Diese Buchung wurde storniert.'}
        </Alert>
      ) : null}

      <dl className="protocol-list rounded-2xl border border-border bg-card px-6">
        <div className="protocol-row">
          <dt className="protocol-label">Datum</dt>
          <dd className="protocol-value">{formatDateLong(booking.scheduledStart)}</dd>
        </div>
        <div className="protocol-row">
          <dt className="protocol-label">Zeitfenster</dt>
          <dd className="protocol-value">
            <span className="inline-flex items-center gap-2">
              <Clock className="size-3.5 text-muted-foreground" aria-hidden />
              {timeRangeLabel(booking.scheduledStart, booking.scheduledEnd)} Uhr ·{' '}
              {formatDuration(booking.durationMin)}
            </span>
          </dd>
        </div>
        {address ? (
          <div className="protocol-row">
            <dt className="protocol-label">Adresse</dt>
            <dd className="protocol-value">
              <span className="inline-flex items-start gap-2">
                <MapPin className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                {address}
              </span>
            </dd>
          </div>
        ) : null}
        <div className="protocol-row">
          <dt className="protocol-label">Objekt</dt>
          <dd className="protocol-value">
            {booking.squareMeters ? `${booking.squareMeters} m²` : '—'}
            {booking.rooms ? ` · ${toNumber(booking.rooms)} Zimmer` : ''}
          </dd>
        </div>
        {booking.extras.length > 0 ? (
          <div className="protocol-row">
            <dt className="protocol-label">Zusatzleistungen</dt>
            <dd className="protocol-value">
              {booking.extras.map((extra) => `${extra.quantity}× ${extra.name}`).join(', ')}
            </dd>
          </div>
        ) : null}
        <div className="protocol-row">
          <dt className="protocol-label">Gesamtbetrag</dt>
          <dd className="protocol-value">
            <span className="font-display text-lg font-bold">
              {formatCurrency(toNumber(booking.grossTotal))}
            </span>
            <span className="ml-2 text-sm font-normal text-muted-foreground">inkl. MWST</span>
          </dd>
        </div>
        {booking.customerNote ? (
          <div className="protocol-row">
            <dt className="protocol-label">Ihre Anmerkung</dt>
            <dd className="protocol-value whitespace-pre-line">{booking.customerNote}</dd>
          </div>
        ) : null}
      </dl>

      {canModify ? (
        <Alert variant="info" className="mt-6">
          Termin verschieben oder stornieren? Rufen Sie uns an oder erstellen Sie ein Konto — dort
          erledigen Sie das selbst, bis 24 Stunden vor dem Termin.
        </Alert>
      ) : null}

      {/* Konto anbieten, nicht aufdrängen */}
      <section className="mt-10 rounded-2xl border border-border bg-surface p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/8 text-primary">
              <UserPlus className="size-5" aria-hidden />
            </span>
            <div className="space-y-1">
              <h2 className="font-display text-base font-semibold">Konto erstellen?</h2>
              <p className="prose-measure text-sm leading-relaxed text-muted-foreground">
                Damit verwalten Sie Termine selbst, sehen alle Rechnungen und buchen beim nächsten
                Mal mit zwei Klicks. Ihre bisherigen Buchungen werden automatisch verknüpft.
              </p>
            </div>
          </div>
          <Button asChild>
            <Link href="/auth/registrieren">Konto erstellen</Link>
          </Button>
        </div>
      </section>

      <div className="mt-8 flex flex-wrap gap-3">
        <Button asChild variant="outline">
          <Link href="/buchen">
            <CalendarCheck aria-hidden />
            Weiteren Termin buchen
          </Link>
        </Button>
        <Button asChild variant="ghost">
          <Link href="/kontakt">Frage stellen</Link>
        </Button>
      </div>
    </div>
  );
}
