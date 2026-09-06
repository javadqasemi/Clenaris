import type { Metadata } from 'next';
import Link from 'next/link';
import {
  ArrowRight,
  CalendarPlus,
  Clock,
  FileText,
  MapPin,
  Receipt,
  Sparkles,
} from 'lucide-react';

import { prisma, toNumber } from '@/lib/db';
import { requireCustomerId } from '@/lib/auth/session';
import { formatCurrency, formatDateLong, formatRelative, timeRangeLabel } from '@/lib/utils';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PersonAvatar } from '@/components/ui/primitives';
import { KpiTile } from '@/components/app/kpi-tile';
import { EmptyState, PageHeader } from '@/components/app/page-parts';

export const metadata: Metadata = {
  title: 'Übersicht',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function AccountHomePage() {
  const { session, customerId } = await requireCustomerId();

  const now = new Date();

  const [customer, nextBookings, openInvoices, openQuotes, lastJob] = await Promise.all([
    prisma.customer.findUniqueOrThrow({
      where: { id: customerId },
      select: { lifetimeValue: true, totalBookings: true, referralCode: true },
    }),
    prisma.booking.findMany({
      where: {
        customerId,
        deletedAt: null,
        status: { in: ['PENDING', 'CONFIRMED', 'IN_PROGRESS'] },
        scheduledStart: { gte: new Date(now.getTime() - 4 * 3_600_000) },
      },
      orderBy: { scheduledStart: 'asc' },
      take: 3,
      include: {
        items: { select: { name: true }, take: 1 },
        address: { select: { street: true, streetNo: true, postalCode: true, city: true } },
        jobs: {
          select: {
            id: true,
            status: true,
            assignments: {
              select: {
                employee: {
                  select: {
                    color: true,
                    user: { select: { firstName: true, lastName: true, avatarUrl: true } },
                  },
                },
              },
            },
          },
        },
      },
    }),
    prisma.invoice.findMany({
      where: {
        customerId,
        deletedAt: null,
        balance: { gt: 0 },
        status: { notIn: ['DRAFT', 'CANCELLED'] },
      },
      orderBy: { dueDate: 'asc' },
      take: 3,
    }),
    prisma.quote.findMany({
      where: { customerId, deletedAt: null, status: { in: ['SENT', 'VIEWED'] } },
      orderBy: { validUntil: 'asc' },
      take: 3,
    }),
    prisma.job.findFirst({
      where: { customerId, deletedAt: null, status: { in: ['COMPLETED', 'VERIFIED'] } },
      orderBy: { actualEnd: 'desc' },
      select: {
        id: true,
        number: true,
        title: true,
        actualEnd: true,
        booking: { select: { id: true, reviews: { select: { id: true } } } },
      },
    }),
  ]);

  const outstandingTotal = openInvoices.reduce((sum, invoice) => sum + toNumber(invoice.balance), 0);
  const canReview = lastJob && lastJob.booking && lastJob.booking.reviews.length === 0;

  return (
    <div className="space-y-8">
      <PageHeader
        title={`Guten Tag, ${session.firstName}`}
        description="Ihre Termine, Rechnungen und Offerten auf einen Blick."
        actions={
          <Button asChild size="lg">
            <Link href="/buchen">
              <CalendarPlus aria-hidden />
              Termin buchen
            </Link>
          </Button>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <KpiTile
          label="Nächster Termin"
          value={nextBookings[0] ? formatDateLong(nextBookings[0].scheduledStart) : '—'}
          hint={
            nextBookings[0]
              ? timeRangeLabel(nextBookings[0].scheduledStart, nextBookings[0].scheduledEnd) + ' Uhr'
              : 'Kein Termin geplant'
          }
          href="/konto/buchungen"
        />
        <KpiTile
          label="Offene Rechnungen"
          value={formatCurrency(outstandingTotal)}
          hint={`${openInvoices.length} ${openInvoices.length === 1 ? 'Rechnung' : 'Rechnungen'}`}
          href="/konto/rechnungen"
          accent={outstandingTotal > 0 ? 'warning' : undefined}
        />
        <KpiTile
          label="Reinigungen total"
          value={String(customer.totalBookings)}
          hint={`Umsatz ${formatCurrency(toNumber(customer.lifetimeValue))}`}
        />
      </div>

      {/* Nächste Termine */}
      <section className="space-y-4" aria-label="Nächste Termine">
        <div className="flex items-center justify-between gap-4">
          <h2 className="font-display text-lg font-semibold tracking-tight">Nächste Termine</h2>
          <Button asChild variant="ghost" size="sm">
            <Link href="/konto/buchungen">
              Alle
              <ArrowRight aria-hidden />
            </Link>
          </Button>
        </div>

        {nextBookings.length === 0 ? (
          <EmptyState
            icon={<CalendarPlus aria-hidden />}
            title="Kein Termin geplant"
            description="Buchen Sie in zwei Minuten Ihren nächsten Reinigungstermin — den Preis sehen Sie vorher."
            action={{ href: '/buchen', label: 'Termin buchen' }}
          />
        ) : (
          <ul className="space-y-3">
            {nextBookings.map((booking) => {
              const crew = booking.jobs.flatMap((job) => job.assignments);
              return (
                <li key={booking.id}>
                  <Link
                    href={`/konto/buchungen/${booking.id}`}
                    className="block rounded-2xl border border-border bg-card p-5 shadow-soft transition-[border-color,box-shadow] duration-300 ease-spring hover:border-primary/30 hover:shadow-card"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 space-y-1">
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

                      <div className="flex flex-col items-end gap-3">
                        <StatusBadge status={booking.status} />
                        <span className="font-semibold tabular-nums">
                          {formatCurrency(toNumber(booking.grossTotal))}
                        </span>
                      </div>
                    </div>

                    {crew.length > 0 ? (
                      <div className="mt-4 flex items-center gap-2 border-t border-border pt-4">
                        <span className="text-sm text-muted-foreground">Ihr Team:</span>
                        <div className="flex -space-x-2">
                          {crew.map((assignment, index) => (
                            <PersonAvatar
                              key={index}
                              firstName={assignment.employee.user.firstName}
                              lastName={assignment.employee.user.lastName}
                              src={assignment.employee.user.avatarUrl}
                              color={assignment.employee.color}
                              size="sm"
                              className="ring-2 ring-card"
                            />
                          ))}
                        </div>
                        <span className="text-sm text-muted-foreground">
                          {crew
                            .map((assignment) => assignment.employee.user.firstName)
                            .join(', ')}
                        </span>
                      </div>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Offene Offerten */}
      {openQuotes.length > 0 ? (
        <section className="space-y-4" aria-label="Offerten">
          <h2 className="font-display text-lg font-semibold tracking-tight">
            Offerten warten auf Ihre Antwort
          </h2>
          <ul className="space-y-3">
            {openQuotes.map((quote) => (
              <li key={quote.id}>
                <Link
                  href={`/offerte/${quote.publicToken}`}
                  className="flex flex-wrap items-center gap-4 rounded-2xl border border-primary/25 bg-primary/[0.04] p-5 transition-colors hover:bg-primary/[0.08]"
                >
                  <FileText className="size-5 shrink-0 text-primary" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{quote.title}</p>
                    <p className="text-sm text-muted-foreground">
                      {quote.number} · gültig bis {formatDateLong(quote.validUntil)}
                    </p>
                  </div>
                  <span className="font-semibold tabular-nums">
                    {formatCurrency(toNumber(quote.grossTotal))}
                  </span>
                  <ArrowRight className="size-4 shrink-0 text-primary" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Offene Rechnungen */}
      {openInvoices.length > 0 ? (
        <section className="space-y-4" aria-label="Offene Rechnungen">
          <div className="flex items-center justify-between gap-4">
            <h2 className="font-display text-lg font-semibold tracking-tight">Offene Rechnungen</h2>
            <Button asChild variant="ghost" size="sm">
              <Link href="/konto/rechnungen">
                Alle
                <ArrowRight aria-hidden />
              </Link>
            </Button>
          </div>

          <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
            {openInvoices.map((invoice) => (
              <li key={invoice.id}>
                {/* `ml-auto` richtete den Betrag früher nur zufällig aus —
                    sobald eine Zeile umbrach, sass er woanders. Jetzt eine
                    feste Spur. */}
                <Link
                  href={`/konto/rechnungen/${invoice.id}`}
                  className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1 p-4 transition-colors hover:bg-muted/50 sm:grid-cols-[auto_7rem_minmax(0,1fr)_7rem_7rem] sm:gap-4"
                >
                  <Receipt className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="font-medium tabular-nums">{invoice.number}</span>
                  <span className="col-span-2 text-meta text-muted-foreground sm:col-span-1">
                    fällig {formatDateLong(invoice.dueDate)}
                  </span>
                  <span className="font-semibold tabular-nums sm:text-right">
                    {formatCurrency(toNumber(invoice.balance))}
                  </span>
                  <span className="min-w-0">
                    <StatusBadge status={invoice.status} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Bewertung erbitten */}
      {canReview ? (
        <section className="rounded-2xl border border-border bg-surface p-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <Sparkles className="mt-0.5 size-5 shrink-0 text-accent" aria-hidden />
              <div>
                <h2 className="font-display text-base font-semibold">
                  Wie war Ihre letzte Reinigung?
                </h2>
                <p className="text-sm text-muted-foreground">
                  {lastJob.title}
                  {lastJob.actualEnd ? ` · ${formatRelative(lastJob.actualEnd)}` : ''}
                </p>
              </div>
            </div>
            <Button asChild>
              <Link href={`/konto/bewertungen/neu?buchung=${lastJob.booking!.id}`}>
                Bewertung abgeben
              </Link>
            </Button>
          </div>
        </section>
      ) : null}

      {/* Empfehlungscode */}
      {customer.referralCode ? (
        <section className="rounded-2xl border border-dashed border-border p-6 text-center">
          <h2 className="font-display text-base font-semibold">Weiterempfehlen und sparen</h2>
          <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-muted-foreground">
            Geben Sie diesen Code weiter. Wer damit zum ersten Mal bucht, erhält CHF 25 Rabatt — und
            Sie ebenfalls.
          </p>
          <p className="mt-4 inline-block rounded-xl border border-border bg-card px-5 py-2.5 font-display text-xl font-bold tracking-[0.2em]">
            {customer.referralCode}
          </p>
        </section>
      ) : null}
    </div>
  );
}
