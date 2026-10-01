import type { Metadata } from 'next';

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowRight, Check, X } from 'lucide-react';

import { prisma, toNumber } from '@/lib/db';
import { formatCurrency } from '@/lib/utils';
import { SEITEN_URL } from '@/lib/seiten-url';
import { leistungsSeo, seitenMetadaten } from '@/lib/seo/metadaten';
import { brotkrumen, leistungsKnoten, leistungsPreis } from '@/lib/seo/structured-data';
import { vergleichsbildBeschreibung } from '@/lib/seo/vergleichsbild';
import { JsonLd } from '@/components/marketing/json-ld';
import { getOrganizationId, getServiceAreas } from '@/server/services/organization.service';
import { getContent } from '@/server/services/content.service';
import { createCms } from '@/lib/cms/editable';
import { isPreview } from '@/lib/cms/preview';
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
  // Mit Organisation: Ohne sie wurden die Wege *jeder* Organisation der
  // Datenbank vorgerendert — als 404, aber gebaut und im Zwischenspeicher.
  const organizationId = await getOrganizationId();
  const services = await prisma.service.findMany({
    where: { organizationId, active: true },
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
    select: {
      name: true,
      slug: true,
      active: true,
      seoTitle: true,
      seoDescription: true,
      shortDesc: true,
      keywords: true,
    },
  });

  // Eine deaktivierte Leistung antwortet 404 (siehe unten) — dann auch kein
  // Titel und keine kanonische Adresse, die sie als lebende Seite ausgäben.
  if (!service || !service.active) return { title: 'Leistung nicht gefunden', robots: { index: false } };

  // Der Pfad kommt aus dem Datensatz, nicht aus der Anfrage: `slug` ist hier
  // derselbe Wert, aber nur der gespeicherte ist geprüft.
  return seitenMetadaten(leistungsSeo(service), SEITEN_URL);
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

  const content = await getContent(organizationId);
  const cms = createCms(content, await isPreview());

  const [reviews, gallery, faqs, areas] = await Promise.all([
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
    getServiceAreas(),
  ]);

  /*
   * Ein Preis, zwei Verbraucher: die sichtbare Beschriftung und das `Offer`
   * im JSON-LD. Beide lesen `leistungsPreis()` — vorher wählte das JSON-LD
   * seinen Betrag selbst (`hourlyRate || minPrice`) und meldete bei einer
   * Pauschale einen anderen Preis, als die Seite zeigte. Ohne Betrag
   * (Offertleistung, oder Ansatz 0) steht „Individuelle Offerte" da, und es
   * gibt kein `Offer`.
   */
  const preis = leistungsPreis({
    pricingModel: service.pricingModel,
    hourlyRate: toNumber(service.hourlyRate),
    minPrice: toNumber(service.minPrice),
    basePrice: toNumber(service.basePrice),
  });
  const priceLabel = !preis
    ? 'Individuelle Offerte'
    : preis.art === 'STUNDE'
      ? `${formatCurrency(preis.betrag)} pro Stunde`
      : preis.art === 'AB_PAUSCHAL'
        ? `ab ${formatCurrency(preis.betrag)} pauschal`
        : preis.art === 'EINHEIT'
          ? `${formatCurrency(preis.betrag)} pro Einheit`
          : `${formatCurrency(preis.betrag)} pauschal`;

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
              // Alternativtext (2026-09-30): Der Eintrag ist nach der Art dieser
              // Leistung ausgewählt, also benennt der Name dieser Seite die
              // Leistung — genauer als die allgemeine Art.
              beschreibung={
                gallery
                  ? vergleichsbildBeschreibung({ titel: gallery.title, leistung: service.name, ort: gallery.location })
                  : undefined
              }
              beforeAttrs={cms.asset('galleryItem', gallery?.id, 'beforeUrl')}
              afterAttrs={cms.asset('galleryItem', gallery?.id, 'afterUrl')}
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
              title={cms.text('services.detail.extrasTitle')}
              lead={cms.text('services.detail.extrasLead')}
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
              lead={cms.text('services.detail.reviewsLead')}
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
            lead={cms.text('services.detail.ctaText')}
            primary={{ href: `/buchen?leistung=${service.slug}`, label: 'Termin buchen' }}
            secondary={{ href: '/kontakt', label: 'Frage stellen' }}
          />
        </div>
      </Section>

      {/*
        Strukturierte Daten: die Leistung mit Verweis auf die Firma aus dem
        Layout (`provider` per `@id` statt fest eingetragenem Namen und Ort),
        dem Einsatzgebiet und nur dem Preis, der oben sichtbar steht. Dazu die
        Brotkrumen, die die Seite oben zeigt.
      */}
      <JsonLd
        daten={leistungsKnoten({
          leistung: { name: service.name, slug: service.slug, beschreibung: service.description },
          preis,
          herkunft: SEITEN_URL,
          orte: areas,
        })}
      />
      <JsonLd
        daten={brotkrumen(
          [
            { name: 'Start', pfad: '/' },
            { name: 'Leistungen', pfad: '/leistungen' },
            { name: service.name, pfad: `/leistungen/${service.slug}` },
          ],
          SEITEN_URL,
        )}
      />
    </>
  );
}
