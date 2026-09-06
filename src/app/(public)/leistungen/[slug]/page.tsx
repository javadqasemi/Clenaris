import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowRight, Check, X } from 'lucide-react';

import { prisma, toNumber } from '@/lib/db';
import { formatCurrency } from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import { ctasFor } from '@/server/services/cta.service';
import { Button } from '@/components/ui/button';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/controls';
import { BeforeAfter } from '@/components/marketing/before-after';
import {
  CallToAction,
  ReviewCard,
  Section,
  SectionIntro,
} from '@/components/marketing/sections';

export const revalidate = 3600;

/** Alle Leistungsseiten zur Build-Zeit erzeugen — sie ändern sich selten. */
export async function generateStaticParams() {
  const services = await prisma.service.findMany({
    where: { active: true },
    select: { slug: true },
  });
  return services.map((service) => ({ slug: service.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const organizationId = await getOrganizationId();

  const service = await prisma.service.findUnique({
    where: { organizationId_slug: { organizationId, slug } },
    select: { name: true, seoTitle: true, seoDescription: true, shortDesc: true, keywords: true },
  });

  if (!service) return { title: 'Leistung nicht gefunden' };

  return {
    title: service.seoTitle ?? service.name,
    description: service.seoDescription ?? service.shortDesc,
    keywords: service.keywords,
    alternates: { canonical: `/leistungen/${slug}` },
    openGraph: {
      title: service.seoTitle ?? service.name,
      description: service.seoDescription ?? service.shortDesc,
    },
  };
}

export default async function ServiceDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const organizationId = await getOrganizationId();

  const service = await prisma.service.findUnique({
    where: { organizationId_slug: { organizationId, slug } },
    include: {
      extras: { include: { extra: true } },
      category: true,
    },
  });

  if (!service || !service.active) notFound();

  const [reviews, gallery, faqs] = await Promise.all([
    prisma.review.findMany({
      where: { organizationId, status: 'PUBLISHED', serviceKind: service.kind },
      orderBy: { createdAt: 'desc' },
      take: 3,
    }),
    prisma.galleryItem.findFirst({
      where: { organizationId, published: true, serviceKind: service.kind },
      orderBy: { position: 'asc' },
    }),
    prisma.faq.findMany({
      where: { organizationId, active: true, locale: 'DE' },
      orderBy: { position: 'asc' },
      take: 6,
    }),
  ]);

  const priceLabel =
    service.pricingModel === 'PER_HOUR'
      ? `${formatCurrency(toNumber(service.hourlyRate))} pro Stunde`
      : service.pricingModel === 'PER_SQM'
        ? `ab ${formatCurrency(toNumber(service.minPrice))} pauschal`
        : service.pricingModel === 'PER_UNIT'
          ? `${formatCurrency(toNumber(service.hourlyRate))} pro Einheit`
          : service.pricingModel === 'FLAT'
            ? `${formatCurrency(toNumber(service.basePrice))} pauschal`
            : 'Individuelle Offerte';

  // Verwaltete Handlungsaufrufe für das Abschlussband dieser Seite. Sie
  // ersetzen die eingebauten Schaltflächen, sobald welche gepflegt sind.
  const bandCtas = await ctasFor(organizationId, 'SECTION_BANNER', `/leistungen/${service.slug}`);

  return (
    <>
      {/* Hero */}
      <section className="relative overflow-hidden border-b border-border">
        <div className="aare-wash pointer-events-none absolute inset-0" aria-hidden />

        <div className="container relative py-14 sm:py-20">
          <nav aria-label="Brotkrumen" className="mb-6 text-sm text-muted-foreground">
            <ol className="flex flex-wrap items-center gap-2">
              <li>
                <Link href="/" className="transition-colors hover:text-foreground">
                  Start
                </Link>
              </li>
              <li aria-hidden>/</li>
              <li>
                <Link href="/leistungen" className="transition-colors hover:text-foreground">
                  Leistungen
                </Link>
              </li>
              <li aria-hidden>/</li>
              <li className="text-foreground">{service.name}</li>
            </ol>
          </nav>

          <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-center">
            <div className="space-y-6">
              <h1 className="text-display font-bold text-balance">{service.name}</h1>
              <p className="prose-measure text-lg leading-relaxed text-muted-foreground">
                {service.description}
              </p>

              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <span className="font-display text-2xl font-bold tracking-tight">{priceLabel}</span>
                <span className="text-sm text-muted-foreground">zzgl. 8.1 % MWST</span>
              </div>

              <div className="flex flex-wrap gap-3">
                <Button asChild size="lg">
                  <Link href={`/buchen?leistung=${service.slug}`}>
                    Preis berechnen und buchen
                    <ArrowRight aria-hidden />
                  </Link>
                </Button>
                <Button asChild size="lg" variant="outline">
                  <Link href="/offerte">Offerte anfordern</Link>
                </Button>
              </div>
            </div>

            <BeforeAfter
              beforeSrc={gallery?.beforeUrl}
              afterSrc={gallery?.afterUrl}
              caption={gallery ? `${gallery.title} — Regler verschieben` : undefined}
            />
          </div>
        </div>
      </section>

      {/* Leistungsumfang als Protokoll */}
      <Section>
        <div className="container grid gap-12 lg:grid-cols-2">
          <div className="space-y-5">
            <h2 className="text-headline font-bold">Was inbegriffen ist</h2>
            <dl className="protocol-list border-t border-border">
              {service.includes.map((item) => (
                <div key={item} className="flex items-start gap-3 py-3.5">
                  <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
                  <dt className="text-body leading-relaxed">{item}</dt>
                </div>
              ))}
            </dl>
          </div>

          <div className="space-y-5">
            <h2 className="text-headline font-bold">Was nicht dazugehört</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Diese Arbeiten sind nicht im Preis enthalten. Auf Wunsch offerieren wir sie separat —
              sagen Sie einfach Bescheid.
            </p>
            <dl className="protocol-list border-t border-border">
              {service.excludes.map((item) => (
                <div key={item} className="flex items-start gap-3 py-3.5">
                  <X className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <dt className="text-body leading-relaxed text-muted-foreground">{item}</dt>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </Section>

      {/* Zusatzleistungen */}
      {service.extras.length > 0 ? (
        <Section className="bg-surface">
          <div className="container">
            <SectionIntro
              title="Zusatzleistungen"
              lead="Alles optional und einzeln buchbar. Die Preise sehen Sie im Buchungsassistenten sofort."
            />
            <dl className="protocol-list border-t border-border">
              {service.extras
                .filter((link) => link.extra.active)
                .map((link) => (
                  <div
                    key={link.extraId}
                    className="flex flex-wrap items-baseline justify-between gap-4 py-4"
                  >
                    <dt className="min-w-0 flex-1">
                      <span className="block font-medium">{link.extra.name}</span>
                      {link.extra.description ? (
                        <span className="block text-sm text-muted-foreground">
                          {link.extra.description}
                        </span>
                      ) : null}
                    </dt>
                    <dd className="font-medium tabular-nums">
                      {formatCurrency(toNumber(link.extra.price))}
                    </dd>
                  </div>
                ))}
            </dl>
          </div>
        </Section>
      ) : null}

      {/* Bewertungen */}
      {reviews.length > 0 ? (
        <Section>
          <div className="container">
            <SectionIntro
              title={`Erfahrungen mit ${service.name}`}
              lead="Rückmeldungen von Kundinnen und Kunden, die genau diese Leistung gebucht haben."
            />
            <div className="grid gap-6 md:grid-cols-3">
              {reviews.map((review) => (
                <ReviewCard
                  key={review.id}
                  authorName={review.authorName}
                  rating={review.rating}
                  title={review.title}
                  body={review.body}
                />
              ))}
            </div>
          </div>
        </Section>
      ) : null}

      {/* FAQ */}
      {faqs.length > 0 ? (
        <Section className="bg-surface">
          <div className="container grid gap-12 lg:grid-cols-[minmax(0,20rem)_1fr]">
            <h2 className="text-headline font-bold">Häufige Fragen</h2>
            <Accordion type="single" collapsible className="border-t border-border">
              {faqs.map((faq) => (
                <AccordionItem key={faq.id} value={faq.id}>
                  <AccordionTrigger>{faq.question}</AccordionTrigger>
                  <AccordionContent>{faq.answer}</AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </div>
        </Section>
      ) : null}

      <Section className="pb-28">
        <div className="container">
          <CallToAction
        ctas={bandCtas}
            title={`${service.name} jetzt buchen`}
            lead="Preis in einer Minute berechnen, freies Zeitfenster wählen, fertig."
            primary={{ href: `/buchen?leistung=${service.slug}`, label: 'Termin buchen' }}
            secondary={{ href: '/kontakt', label: 'Frage stellen' }}
          />
        </div>
      </Section>

      {/* Strukturierte Daten */}
      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger -- serverseitig erzeugter JSON-LD-Block
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'Service',
            name: service.name,
            description: service.shortDesc,
            provider: {
              '@type': 'LocalBusiness',
              name: 'Clenaris Reinigungen GmbH',
              address: {
                '@type': 'PostalAddress',
                addressLocality: 'Bern',
                addressRegion: 'BE',
                addressCountry: 'CH',
              },
            },
            areaServed: { '@type': 'State', name: 'Kanton Bern' },
            offers: {
              '@type': 'Offer',
              priceCurrency: 'CHF',
              price: toNumber(service.hourlyRate) || toNumber(service.minPrice),
              availability: 'https://schema.org/InStock',
            },
          }),
        }}
      />
    </>
  );
}
