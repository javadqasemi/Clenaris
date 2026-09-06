import type { Metadata } from 'next';

import { prisma } from '@/lib/db';
import { formatDate } from '@/lib/utils';
import { pageMetadata } from '@/lib/cms/metadata';
import { getOrganizationId } from '@/server/services/organization.service';
import { Badge } from '@/components/ui/badge';
import { CallToAction, Section, StatStrip, Stars } from '@/components/marketing/sections';
import { ctasFor } from '@/server/services/cta.service';
import { EmptyState } from '@/components/app/page-parts';

/**
 * Titel, Beschreibung und Vorschaubild kommen aus der Redaktion
 * (`/admin/seo`); fehlt eine Angabe, gilt der Wert aus dem Register.
 */
export const generateMetadata = (): Promise<Metadata> => pageMetadata('/bewertungen');

export const revalidate = 1800;

const SERVICE_LABELS: Record<string, string> = {
  RESIDENTIAL_CLEANING: 'Unterhaltsreinigung',
  MOVE_OUT_CLEANING: 'Umzugsreinigung',
  OFFICE_CLEANING: 'Büroreinigung',
  WINDOW_CLEANING: 'Fensterreinigung',
  CONSTRUCTION_CLEANING: 'Baureinigung',
  BUILDING_MAINTENANCE: 'Hauswartung',
  SPECIAL: 'Spezialauftrag',
};

export default async function ReviewsPage() {
  const organizationId = await getOrganizationId();

  const [reviews, aggregate, distribution] = await Promise.all([
    prisma.review.findMany({
      where: { organizationId, status: 'PUBLISHED' },
      orderBy: [{ featured: 'desc' }, { createdAt: 'desc' }],
      take: 60,
    }),
    prisma.review.aggregate({
      where: { organizationId, status: 'PUBLISHED' },
      _avg: { rating: true },
      _count: true,
    }),
    prisma.review.groupBy({
      by: ['rating'],
      where: { organizationId, status: 'PUBLISHED' },
      _count: true,
    }),
  ]);

  const average = aggregate._avg.rating ?? 0;
  const total = aggregate._count;
  const fiveStar = distribution.find((row) => row.rating === 5)?._count ?? 0;
  const recommendRate = total > 0 ? Math.round(((fiveStar + (distribution.find((r) => r.rating === 4)?._count ?? 0)) / total) * 100) : 0;


  // Verwaltete Handlungsaufrufe für das Abschlussband dieser Seite. Sie
  // ersetzen die eingebauten Schaltflächen, sobald welche gepflegt sind.
  const bandCtas = await ctasFor(organizationId, 'SECTION_BANNER', '/bewertungen');

  return (
    <>
      <section className="relative overflow-hidden border-b border-border">
        <div className="aare-wash pointer-events-none absolute inset-0" aria-hidden />
        <div className="container relative py-16 sm:py-20">
          <div className="max-w-2xl space-y-5">
            <h1 className="text-display font-bold text-balance">Was unsere Kundschaft sagt</h1>
            <p className="text-lg leading-relaxed text-muted-foreground">
              Wir veröffentlichen alle Bewertungen — auch die kritischen. Bewerten kann nur, wer
              tatsächlich einen Einsatz bei uns gebucht hat.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Stars rating={average} />
              <span className="text-lg font-semibold tabular-nums">{average.toFixed(1)} / 5</span>
              <span className="text-muted-foreground">aus {total} Bewertungen</span>
            </div>
          </div>
        </div>
      </section>

      {total > 0 ? (
        <div className="container pt-12">
          <StatStrip
            stats={[
              { value: average.toFixed(1), label: 'Durchschnittliche Bewertung' },
              { value: String(total), label: 'Abgegebene Bewertungen' },
              { value: `${recommendRate} %`, label: 'Vier Sterne oder mehr' },
              { value: '24 Std.', label: 'Antwortzeit auf Kritik' },
            ]}
          />
        </div>
      ) : null}

      <Section>
        <div className="container">
          {reviews.length === 0 ? (
            <EmptyState
              title="Noch keine Bewertungen"
              description="Nach jedem Einsatz bitten wir um eine kurze Rückmeldung. Die ersten erscheinen hier, sobald sie freigegeben sind."
              action={{ href: '/buchen', label: 'Termin buchen' }}
            />
          ) : (
            <ul className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
              {reviews.map((review) => (
                <li key={review.id}>
                  <figure className="flex h-full flex-col gap-4 rounded-2xl border border-border bg-card p-6 shadow-soft">
                    <div className="flex items-start justify-between gap-3">
                      <Stars rating={review.rating} />
                      {review.serviceKind ? (
                        <Badge variant="neutral" size="sm">
                          {SERVICE_LABELS[review.serviceKind]}
                        </Badge>
                      ) : null}
                    </div>

                    <blockquote className="flex-1 space-y-2">
                      {review.title ? (
                        <p className="font-display font-semibold">{review.title}</p>
                      ) : null}
                      <p className="text-body leading-relaxed text-muted-foreground">
                        {review.body}
                      </p>
                    </blockquote>

                    {review.reply ? (
                      <div className="rounded-xl bg-muted/60 p-4">
                        <p className="mb-1 text-xs font-medium">Antwort von Clenaris</p>
                        <p className="text-sm leading-relaxed text-muted-foreground">
                          {review.reply}
                        </p>
                      </div>
                    ) : null}

                    <figcaption className="flex items-baseline justify-between gap-3 border-t border-border pt-4 text-sm">
                      <span className="font-medium">{review.authorName}</span>
                      <span className="text-muted-foreground">{formatDate(review.createdAt)}</span>
                    </figcaption>
                  </figure>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Section>

      <Section className="pb-28">
        <div className="container">
          <CallToAction
        ctas={bandCtas}
            title="Überzeugen Sie sich selbst"
            lead="Preis berechnen, Termin wählen, Ergebnis bewerten. Wir freuen uns auf Ihre Rückmeldung."
            primary={{ href: '/buchen', label: 'Termin buchen' }}
            secondary={{ href: '/galerie', label: 'Vorher / Nachher' }}
          />
        </div>
      </Section>

      {total > 0 ? (
        <script
          type="application/ld+json"
          // eslint-disable-next-line react/no-danger -- serverseitig erzeugter JSON-LD-Block
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              '@context': 'https://schema.org',
              '@type': 'LocalBusiness',
              name: 'Clenaris Reinigungen GmbH',
              aggregateRating: {
                '@type': 'AggregateRating',
                ratingValue: average.toFixed(1),
                reviewCount: total,
                bestRating: 5,
                worstRating: 1,
              },
              review: reviews.slice(0, 10).map((review) => ({
                '@type': 'Review',
                author: { '@type': 'Person', name: review.authorName },
                datePublished: review.createdAt.toISOString().slice(0, 10),
                reviewBody: review.body,
                reviewRating: {
                  '@type': 'Rating',
                  ratingValue: review.rating,
                  bestRating: 5,
                  worstRating: 1,
                },
              })),
            }),
          }}
        />
      ) : null}
    </>
  );
}
