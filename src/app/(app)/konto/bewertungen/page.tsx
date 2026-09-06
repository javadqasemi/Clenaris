import type { Metadata } from 'next';
import { Star } from 'lucide-react';

import { prisma } from '@/lib/db';
import { requireCustomerId } from '@/lib/auth/session';
import { cn, formatDate } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { EmptyState, PageHeader } from '@/components/app/page-parts';
import { ReviewForm } from '@/features/account/review-form';

export const metadata: Metadata = {
  title: 'Meine Bewertungen',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const STATUS_LABEL: Record<string, { label: string; variant: 'success' | 'warning' | 'neutral' }> = {
  PUBLISHED: { label: 'Veröffentlicht', variant: 'success' },
  PENDING: { label: 'In Prüfung', variant: 'warning' },
  REJECTED: { label: 'Nicht veröffentlicht', variant: 'neutral' },
};

function Stars({ rating }: { rating: number }) {
  return (
    <span className="flex gap-0.5" aria-label={`${rating} von 5 Sternen`}>
      {[1, 2, 3, 4, 5].map((value) => (
        <Star
          key={value}
          className={cn(
            'size-4',
            value <= rating ? 'fill-accent text-accent' : 'text-muted-foreground/30',
          )}
          aria-hidden
        />
      ))}
    </span>
  );
}

/**
 * Bewertungen der Kundschaft.
 *
 * Bewertbar ist nur, was abgeschlossen und noch nicht bewertet ist — die
 * Liste der offenen Termine wird deshalb serverseitig gebildet und nicht im
 * Dialog nachgeladen.
 */
export default async function AccountReviewsPage() {
  const { customerId } = await requireCustomerId();

  const [reviews, reviewable] = await Promise.all([
    prisma.review.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        rating: true,
        title: true,
        body: true,
        status: true,
        reply: true,
        repliedAt: true,
        createdAt: true,
        booking: { select: { number: true, scheduledStart: true } },
      },
    }),
    prisma.booking.findMany({
      where: {
        customerId,
        status: 'COMPLETED',
        deletedAt: null,
        reviews: { none: {} },
      },
      orderBy: { scheduledStart: 'desc' },
      take: 20,
      select: {
        id: true,
        number: true,
        scheduledStart: true,
        items: { orderBy: { position: 'asc' }, take: 1, select: { name: true } },
      },
    }),
  ]);

  const bookings = reviewable.map((booking) => ({
    id: booking.id,
    number: booking.number,
    scheduledStart: booking.scheduledStart.toISOString(),
    serviceName: booking.items[0]?.name ?? 'Reinigung',
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Meine Bewertungen"
        description="Ihre Rückmeldungen zu abgeschlossenen Einsätzen — und unsere Antworten darauf."
        actions={<ReviewForm bookings={bookings} />}
      />

      {bookings.length === 0 && reviews.length === 0 ? (
        <EmptyState
          icon={<Star aria-hidden />}
          title="Noch nichts zu bewerten"
          description="Sobald ein Termin abgeschlossen ist, können Sie ihn hier bewerten. Wir lesen jede Rückmeldung."
          action={{ href: '/buchen', label: 'Termin buchen' }}
        />
      ) : null}

      {reviews.length > 0 ? (
        <ul className="space-y-4">
          {reviews.map((review) => {
            const status = STATUS_LABEL[review.status] ?? STATUS_LABEL.PENDING;

            return (
              <li
                key={review.id}
                className="space-y-3 rounded-2xl border border-border bg-card p-5 shadow-soft"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <Stars rating={review.rating} />
                  <Badge variant={status.variant} size="sm">
                    {status.label}
                  </Badge>
                </div>

                {review.title ? (
                  <h2 className="font-display text-base font-semibold tracking-tight">
                    {review.title}
                  </h2>
                ) : null}

                <p className="prose-measure whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                  {review.body}
                </p>

                <p className="text-xs text-muted-foreground">
                  {formatDate(review.createdAt)}
                  {review.booking
                    ? ` · Termin ${review.booking.number} vom ${formatDate(review.booking.scheduledStart)}`
                    : ''}
                </p>

                {review.reply ? (
                  <div className="rounded-xl border-l-2 border-primary bg-primary/5 px-4 py-3">
                    <p className="text-xs font-medium text-primary">Antwort des Betriebs</p>
                    <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed">
                      {review.reply}
                    </p>
                    {review.repliedAt ? (
                      <p className="mt-1.5 text-xs text-muted-foreground">
                        {formatDate(review.repliedAt)}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {bookings.length > 0 && reviews.length === 0 ? (
        <EmptyState
          icon={<Star aria-hidden />}
          title={`${bookings.length} ${bookings.length === 1 ? 'Termin wartet' : 'Termine warten'} auf Ihre Rückmeldung`}
          description="Zwei Minuten genügen. Ihre Bewertung hilft uns, das Team gezielt zu schulen."
        />
      ) : null}
    </div>
  );
}
