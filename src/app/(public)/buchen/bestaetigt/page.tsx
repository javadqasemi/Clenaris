import type { Metadata } from 'next';
import Link from 'next/link';
import {
  CalendarCheck,
  Clock,
  FileDown,
  Mail,
  MapPin,
  Phone,
  Settings2,
  ShieldCheck,
} from 'lucide-react';

import { toNumber } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';
import { formatCurrency, formatDateLong, formatDuration, timeRangeLabel } from '@/lib/utils';
import { getPublicCompanyInfo } from '@/server/services/organization.service';
import { getBookingByToken } from '@/server/services/booking.service';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PrintButton } from '@/features/booking/print-button';

export const metadata: Metadata = {
  title: 'Buchung eingegangen',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Abschlussseite des Buchungsassistenten.
 *
 * Der Assistent hängt neben der Nummer den Verwaltungs-Token an (`t`). Damit
 * zeigt die Seite die vollständige Bestätigung — dieselben Angaben wie im
 * PDF — und bietet Druck und Download direkt an, ohne dass die Kundschaft
 * zuerst die E-Mail suchen muss. Der Token steht ohnehin im Verwaltungslink
 * der E-Mail; die Seite gibt nichts preis, was die Mail nicht auch zeigt.
 *
 * Ohne Token (alte Lesezeichen, direkt aufgerufen) bleibt die knappe Fassung
 * mit Nummer und nächsten Schritten.
 */
export default async function BookingConfirmedPage({
  searchParams,
}: {
  searchParams: Promise<{ nr?: string; t?: string }>;
}) {
  const { nr, t } = await searchParams;
  const company = await getPublicCompanyInfo();

  const booking = t
    ? await getBookingByToken(t).catch((error) => {
        if (error instanceof NotFoundError) return null;
        throw error;
      })
    : null;

  const number = booking?.number ?? nr ?? null;
  const address = booking?.address
    ? `${booking.address.street} ${booking.address.streetNo ?? ''}, ${booking.address.postalCode} ${booking.address.city}`.replace(
        /\s+/g,
        ' ',
      )
    : null;
  const breakdown = (booking?.priceBreakdown ?? null) as {
    lines?: { key: string; label: string; amount: number; kind: string }[];
  } | null;
  const propertyLabel = booking
    ? [
        booking.squareMeters ? `${booking.squareMeters} m²` : null,
        booking.rooms ? `${toNumber(booking.rooms)} Zimmer` : null,
        booking.windows ? `${booking.windows} Fenster` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : '';

  const steps = [
    {
      title: 'Bestätigung per E-Mail',
      text: booking
        ? `Die Buchungsbestätigung ist als PDF an ${booking.customer.email} unterwegs — zusammen mit dem Link zum Verwalten des Termins.`
        : 'Sie erhalten eine E-Mail mit allen Angaben, der Bestätigung als PDF und einem Link zum Verwalten des Termins.',
    },
    {
      title: 'Wir prüfen den Termin',
      text: 'In der Regel bestätigen wir innerhalb von zwei Stunden. Dann ist der Termin fix.',
    },
    {
      title: 'Bezahlung nach dem Einsatz',
      text: 'Per QR-Rechnung mit 30 Tagen Frist oder online mit Karte und TWINT.',
    },
    {
      title: 'Änderungen bis 24 Stunden vorher',
      text: 'Kostenlos verschieben oder stornieren — über den Link in der E-Mail oder telefonisch.',
    },
  ];

  return (
    <div className="container max-w-5xl py-12 sm:py-16">
      {/* Kopf */}
      <header className="print-hidden mx-auto max-w-2xl space-y-4 text-center">
        <div className="mx-auto flex size-16 items-center justify-center rounded-2xl bg-success/12 text-success">
          <CalendarCheck className="size-8" aria-hidden />
        </div>
        <h1 className="text-headline font-bold text-balance">Wir haben Ihre Buchung erhalten</h1>
        <p className="text-lg leading-relaxed text-muted-foreground text-pretty">
          {number ? (
            <>
              Ihre Buchungsnummer lautet{' '}
              <span className="font-semibold tabular-nums text-foreground">{number}</span>.{' '}
            </>
          ) : null}
          Vielen Dank für Ihr Vertrauen — die Bestätigung kommt per E-Mail.
        </p>
      </header>

      <div className="mt-10 grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
        {/* Bestätigung — druckbar */}
        <section
          aria-labelledby="bestaetigung-titel"
          className="print-area rounded-2xl border border-border bg-card shadow-card"
        >
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border px-6 py-5">
            <div className="space-y-1">
              <p className="text-meta uppercase tracking-wide text-muted-foreground">
                {company.legalName ?? company.name}
              </p>
              <h2 id="bestaetigung-titel" className="font-display text-title font-semibold">
                Buchungsbestätigung
              </h2>
              {number ? (
                <p className="text-sm text-muted-foreground">
                  Nr. <span className="tabular-nums text-foreground">{number}</span>
                  {booking ? ` · eingegangen am ${formatDateLong(booking.createdAt)}` : ''}
                </p>
              ) : null}
            </div>
            {booking ? <StatusBadge status={booking.status} /> : null}
          </div>

          {booking ? (
            <>
              <dl className="protocol-list px-6">
                <div className="protocol-row">
                  <dt className="protocol-label">Leistung</dt>
                  <dd className="protocol-value">
                    {booking.items[0]?.service.name ?? booking.items[0]?.name ?? 'Reinigung'}
                  </dd>
                </div>
                <div className="protocol-row">
                  <dt className="protocol-label">Termin</dt>
                  <dd className="protocol-value">
                    {formatDateLong(booking.scheduledStart)}
                    <span className="mt-1 flex items-center gap-2 text-sm font-normal text-muted-foreground">
                      <Clock className="size-3.5" aria-hidden />
                      {timeRangeLabel(booking.scheduledStart, booking.scheduledEnd)} Uhr · ca.{' '}
                      {formatDuration(booking.durationMin)}
                      {booking.crewSize > 1 ? ` · ${booking.crewSize} Personen` : ''}
                    </span>
                  </dd>
                </div>
                {address ? (
                  <div className="protocol-row">
                    <dt className="protocol-label">Einsatzort</dt>
                    <dd className="protocol-value">
                      <span className="inline-flex items-start gap-2">
                        <MapPin
                          className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                          aria-hidden
                        />
                        {address}
                      </span>
                    </dd>
                  </div>
                ) : null}
                {propertyLabel ? (
                  <div className="protocol-row">
                    <dt className="protocol-label">Objekt</dt>
                    <dd className="protocol-value">{propertyLabel}</dd>
                  </div>
                ) : null}
                {booking.extras.length > 0 ? (
                  <div className="protocol-row">
                    <dt className="protocol-label">Zusatzleistungen</dt>
                    <dd className="protocol-value">
                      {booking.extras.map((extra) => `${extra.quantity}× ${extra.name}`).join(', ')}
                    </dd>
                  </div>
                ) : null}
                <div className="protocol-row">
                  <dt className="protocol-label">Kundschaft</dt>
                  <dd className="protocol-value">
                    {booking.customer.firstName} {booking.customer.lastName}
                    <span className="block text-sm font-normal text-muted-foreground">
                      {booking.customer.email}
                    </span>
                  </dd>
                </div>
                {booking.customerNote ? (
                  <div className="protocol-row">
                    <dt className="protocol-label">Ihre Anmerkung</dt>
                    <dd className="protocol-value whitespace-pre-line">{booking.customerNote}</dd>
                  </div>
                ) : null}
              </dl>

              {/* Preis */}
              <div className="border-t border-border px-6 py-5">
                <h3 className="text-meta uppercase tracking-wide text-muted-foreground">Preis</h3>
                <dl className="mt-2 text-sm">
                  {breakdown?.lines?.map((line) => (
                    <div
                      key={line.key}
                      className="flex items-baseline justify-between gap-4 py-1.5"
                    >
                      <dt
                        className={
                          line.kind === 'discount' ? 'text-success' : 'text-muted-foreground'
                        }
                      >
                        {line.label}
                      </dt>
                      <dd className="tabular-nums">{formatCurrency(line.amount)}</dd>
                    </div>
                  ))}
                  <div className="flex items-baseline justify-between gap-4 py-1.5">
                    <dt className="text-muted-foreground">
                      MWST {toNumber(booking.vatRate).toFixed(1)} %
                    </dt>
                    <dd className="tabular-nums">{formatCurrency(toNumber(booking.vatAmount))}</dd>
                  </div>
                  <div className="mt-2 flex items-baseline justify-between gap-4 border-t border-border pt-3">
                    <dt className="font-semibold text-foreground">Gesamtbetrag</dt>
                    <dd className="font-display text-2xl font-bold tabular-nums text-foreground">
                      {formatCurrency(toNumber(booking.grossTotal))}
                    </dd>
                  </div>
                </dl>
              </div>

              <p className="flex items-start gap-2.5 border-t border-border px-6 py-4 text-meta leading-relaxed text-muted-foreground">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                Der Termin gilt als reserviert und wird von uns geprüft. Bezahlt wird erst nach dem
                Einsatz. Bis 24 Stunden vor dem Termin stornieren Sie kostenlos.
              </p>
            </>
          ) : (
            <p className="px-6 py-6 text-sm leading-relaxed text-muted-foreground">
              Die Angaben zu dieser Buchung finden Sie in der Bestätigungs-E-Mail — mit dem PDF zum
              Ablegen und dem Link zum Verwalten des Termins.
            </p>
          )}

          {/* Druck und Download — nur am Bildschirm */}
          {booking ? (
            <div className="print-hidden flex flex-wrap gap-2 border-t border-border bg-surface px-6 py-4">
              <PrintButton variant="outline" size="sm" />
              <Button asChild variant="outline" size="sm">
                <a href={`/api/public/bookings/${booking.confirmationToken}/pdf`}>
                  <FileDown aria-hidden />
                  PDF herunterladen
                </a>
              </Button>
              <Button asChild variant="ghost" size="sm">
                <Link href={`/buchung/${booking.confirmationToken}`}>
                  <Settings2 aria-hidden />
                  Buchung verwalten
                </Link>
              </Button>
            </div>
          ) : null}
        </section>

        {/* So geht es weiter */}
        <aside className="print-hidden space-y-6">
          <div className="rounded-2xl border border-border bg-card p-6">
            <h2 className="font-display text-base font-semibold">So geht es weiter</h2>
            <ol className="mt-4 space-y-4">
              {steps.map((step, index) => (
                <li key={step.title} className="flex gap-3">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold tabular-nums text-primary">
                    {index + 1}
                  </span>
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">{step.title}</p>
                    <p className="text-meta leading-relaxed text-muted-foreground">{step.text}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>

          <div className="flex flex-col gap-3">
            <Button asChild size="lg">
              <Link href="/konto/buchungen">Zu meinen Buchungen</Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/">Zur Startseite</Link>
            </Button>
          </div>

          <div className="flex flex-col gap-3 border-t border-border pt-6 text-sm text-muted-foreground">
            <p className="text-meta">Fragen zum Termin?</p>
            {company.phone ? (
              <a
                href={`tel:${company.phone.replace(/\s/g, '')}`}
                className="inline-flex items-center gap-2 transition-colors hover:text-foreground"
              >
                <Phone className="size-4 text-primary" aria-hidden />
                {company.phone}
              </a>
            ) : null}
            <a
              href={`mailto:${company.email}`}
              className="inline-flex items-center gap-2 transition-colors hover:text-foreground"
            >
              <Mail className="size-4 text-primary" aria-hidden />
              {company.email}
            </a>
          </div>
        </aside>
      </div>
    </div>
  );
}
