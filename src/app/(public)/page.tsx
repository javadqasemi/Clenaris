import type { Metadata } from 'next';

import { jsonLd } from '@/lib/json-ld';
import Link from 'next/link';
import {
  ArrowRight,
  BadgeCheck,
  ClipboardCheck,
  Clock3,
  ShieldCheck,
  Users,
} from 'lucide-react';

import { prisma, toNumber } from '@/lib/db';
import { pageMetadata } from '@/lib/cms/metadata';
import { getOrganizationId } from '@/server/services/organization.service';
import { getContent } from '@/server/services/content.service';
import { createCms } from '@/lib/cms/editable';
import { isPreview } from '@/lib/cms/preview';
import { ctasFor } from '@/server/services/cta.service';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/controls';
import { BeforeAfter } from '@/components/marketing/before-after';
import { QuickEstimate } from '@/components/marketing/quick-estimate';
import {
  CallToAction,
  ProcessSteps,
  ReviewCard,
  Section,
  SectionIntro,
  ServiceRow,
  StatStrip,
  Stars,
  TrustRow,
} from '@/components/marketing/sections';

/**
 * Titel, Beschreibung und Vorschaubild kommen aus der Redaktion
 * (`/admin/seo`); fehlt eine Angabe, gilt der Wert aus dem Register.
 */
export const generateMetadata = (): Promise<Metadata> => pageMetadata('/');

// Die Startseite ändert sich selten — stündlich neu erzeugen genügt.
export const revalidate = 3600;

const SERVICE_LABELS: Record<string, string> = {
  RESIDENTIAL_CLEANING: 'Unterhaltsreinigung',
  MOVE_OUT_CLEANING: 'Umzugsreinigung',
  OFFICE_CLEANING: 'Büroreinigung',
  WINDOW_CLEANING: 'Fensterreinigung',
  CONSTRUCTION_CLEANING: 'Baureinigung',
  BUILDING_MAINTENANCE: 'Hauswartung',
  SPECIAL: 'Spezialauftrag',
};

export default async function HomePage() {
  const organizationId = await getOrganizationId();
  // Redaktionell gepflegte Texte; fehlt ein Baustein, gilt der Auslieferungstext.
  const content = await getContent(organizationId);
  // Im Vorschaumodus werden die Texte anklickbar — siehe `createCms`.
  const cms = createCms(content, await isPreview());

  const [services, reviews, ratingAgg, faqs, gallery, areaCount, completedJobs] =
    await Promise.all([
      prisma.service.findMany({
        where: { organizationId, active: true },
        orderBy: { position: 'asc' },
        select: {
          slug: true,
          name: true,
          shortDesc: true,
          kind: true,
          pricingModel: true,
          hourlyRate: true,
          pricePerSqm: true,
          minPrice: true,
          basePrice: true,
          bulletPoints: true,
        },
      }),
      prisma.review.findMany({
        where: { organizationId, status: 'PUBLISHED', featured: true },
        orderBy: { createdAt: 'desc' },
        take: 3,
      }),
      prisma.review.aggregate({
        where: { organizationId, status: 'PUBLISHED' },
        _avg: { rating: true },
        _count: true,
      }),
      prisma.faq.findMany({
        where: { organizationId, active: true, locale: 'DE' },
        orderBy: { position: 'asc' },
        take: 6,
      }),
      prisma.galleryItem.findFirst({
        where: { organizationId, published: true, featured: true },
        orderBy: { position: 'asc' },
      }),
      prisma.serviceArea.count({ where: { organizationId, active: true } }),
      prisma.job.count({ where: { organizationId, status: { in: ['COMPLETED', 'VERIFIED'] } } }),
    ]);

  const averageRating = ratingAgg._avg.rating ?? 5;

  const priceFor = (service: (typeof services)[number]) => {
    switch (service.pricingModel) {
      case 'PER_HOUR':
        return { value: toNumber(service.hourlyRate), unit: '/ Std.' };
      case 'PER_SQM':
        return { value: toNumber(service.minPrice), unit: 'pauschal' };
      case 'PER_UNIT':
        return { value: toNumber(service.hourlyRate), unit: '/ Fenster' };
      case 'FLAT':
        return { value: toNumber(service.basePrice), unit: 'pauschal' };
      default:
        return { value: null, unit: '' };
    }
  };

  // Verwaltete Handlungsaufrufe für das Abschlussband dieser Seite. Sie
  // ersetzen die eingebauten Schaltflächen, sobald welche gepflegt sind.
  const bandCtas = await ctasFor(organizationId, 'SECTION_BANNER', '/');

  return (
    <>
      {/* ================== Hero ================== */}
      <section className="relative overflow-hidden">
        <div className="grid-backdrop pointer-events-none absolute inset-0" aria-hidden />
        <div className="aare-wash pointer-events-none absolute inset-0" aria-hidden />

        <div className="container relative pb-16 pt-14 sm:pb-20 sm:pt-20">
          <div className="grid items-center gap-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
            <div className="space-y-8">
              <div className="flex flex-wrap items-center gap-3">
                <Badge
                  variant="outline"
                  className="gap-2 border-border bg-card/70 py-1 pl-1.5"
                  {...cms.attrs('home.hero.availability')}
                >
                  <span className="status-dot bg-success" aria-hidden />
                  {cms.raw('home.hero.availability').replace('{datum}', nextAvailableLabel())}
                </Badge>
                <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                  <Stars rating={averageRating} />
                  {averageRating.toFixed(1)} aus {ratingAgg._count} Bewertungen
                </span>
              </div>

              <h1 className="text-display font-bold text-balance text-foreground">
                {cms.text('home.hero.titleLine1')}
                <br />
                {cms.text('home.hero.titleLine2')}
              </h1>

              <p className="prose-measure text-lg leading-relaxed text-muted-foreground">
                {cms.text('home.hero.lead')}
              </p>

              <QuickEstimate
                services={services.map((service) => ({
                  slug: service.slug,
                  name: service.name,
                  kind: service.kind,
                  pricingModel: service.pricingModel,
                }))}
              />

              {/* Die Liste wird als Ganzes gepflegt — der Behälter trägt die Markierung. */}
              <ul
                className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground"
                {...cms.attrs('home.hero.bullets')}
              >
                {cms.list('home.hero.bullets').map((item) => (
                  <li key={item} className="flex items-center gap-2">
                    <BadgeCheck className="size-4 text-primary" aria-hidden />
                    {item}
                  </li>
                ))}
              </ul>
            </div>

            {/* Der Vorher-/Nachher-Vergleich ist das Herzstück: Reinigung
                beweist man mit dem Ergebnis, nicht mit Adjektiven. */}
            <BeforeAfter
              beforeSrc={gallery?.beforeUrl}
              afterSrc={gallery?.afterUrl}
              beforeAttrs={cms.asset('galleryItem', gallery?.id, 'beforeUrl')}
              afterAttrs={cms.asset('galleryItem', gallery?.id, 'afterUrl')}
              caption={
                gallery
                  ? `${gallery.title}${gallery.location ? ` · ${gallery.location}` : ''} — Regler verschieben`
                  : 'Regler verschieben, um das Ergebnis zu sehen'
              }
            />
          </div>
        </div>
      </section>

      {/* ================== Kennzahlen ================== */}
      <div className="container">
        <StatStrip
          stats={[
            { value: `${areaCount}`, label: cms.text('home.stats.areasLabel') },
            { value: `${Math.max(completedJobs, 1)}`, label: cms.text('home.stats.jobsLabel') },
            { value: averageRating.toFixed(1), label: cms.text('home.stats.ratingLabel') },
            {
              value: cms.text('home.stats.responseValue'),
              label: cms.text('home.stats.responseLabel'),
            },
          ]}
        />
      </div>

      {/* ================== Leistungen ================== */}
      <Section>
        <div className="container">
          <SectionIntro
            title={cms.text('home.services.title')}
            lead={cms.text('home.services.lead')}
            action={{ href: '/leistungen', label: cms.text('home.services.linkLabel') }}
          />

          <div className="border-b border-border">
            {services.map((service, index) => {
              const price = priceFor(service);
              return (
                <ServiceRow
                  key={service.slug}
                  slug={service.slug}
                  name={service.name}
                  shortDesc={service.shortDesc}
                  priceFrom={price.value}
                  priceUnit={price.unit}
                  index={index}
                />
              );
            })}
          </div>
        </div>
      </Section>

      {/* ================== Ablauf ================== */}
      <Section className="bg-surface">
        <div className="container">
          <SectionIntro
            title={cms.text('home.process.title')}
            lead={cms.text('home.process.lead')}
          />
          <ProcessSteps
            steps={[1, 2, 3, 4].map((step) => ({
              title: cms.text(`home.process.step${step}.title`),
              description: cms.text(`home.process.step${step}.text`),
            }))}
          />
        </div>
      </Section>

      {/* ================== Vertrauen ================== */}
      <Section>
        <div className="container space-y-14">
          <SectionIntro
            title={cms.text('home.trust.title')}
            lead={cms.text('home.trust.lead')}
            align="center"
          />

          {/*
            Die Sinnbilder bleiben im Code. Sie stehen für die Zusage, nicht für
            den Text — ein Schloss neben „Versichert" ist eine Gestaltungs-,
            keine Redaktionsentscheidung. Änderbar ist, was zugesagt wird.
          */}
          <TrustRow
            items={[<Users key="1" aria-hidden />, <ShieldCheck key="2" aria-hidden />, <ClipboardCheck key="3" aria-hidden />, <Clock3 key="4" aria-hidden />].map(
              (icon, index) => ({
                icon,
                title: cms.text(`home.trust.item${index + 1}.title`),
                description: cms.text(`home.trust.item${index + 1}.text`),
              }),
            )}
          />
        </div>
      </Section>

      {/* ================== Bewertungen ================== */}
      {reviews.length > 0 ? (
        <Section className="bg-surface">
          <div className="container">
            <SectionIntro
              title={cms.text('home.reviews.title')}
              lead={cms.text('home.reviews.lead')}
              action={{ href: '/bewertungen', label: cms.text('home.reviews.linkLabel') }}
            />
            <div className="grid gap-6 md:grid-cols-3">
              {reviews.map((review) => (
                <ReviewCard
                  key={review.id}
                  authorName={review.authorName}
                  rating={review.rating}
                  title={review.title}
                  body={review.body}
                  serviceLabel={review.serviceKind ? SERVICE_LABELS[review.serviceKind] : null}
                />
              ))}
            </div>
          </div>
        </Section>
      ) : null}

      {/* ================== FAQ ================== */}
      {faqs.length > 0 ? (
        <Section>
          <div className="container grid gap-12 lg:grid-cols-[minmax(0,22rem)_1fr]">
            <div className="space-y-5">
              <h2 className="text-headline font-bold text-balance">
                {cms.text('home.faq.title')}
              </h2>
              <p className="text-lg leading-relaxed text-muted-foreground">
                {cms.text('home.faq.lead')}
              </p>
              <Button asChild variant="outline">
                <Link href="/faq">
                  {cms.text('home.faq.linkLabel')}
                  <ArrowRight aria-hidden />
                </Link>
              </Button>
            </div>

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

      {/* ================== Abschluss ================== */}
      <Section className="pb-28">
        <div className="container">
          <CallToAction
            ctas={bandCtas}
            title={cms.text('home.cta.title')}
            lead={cms.text('home.cta.text')}
            primary={{ href: '/buchen', label: 'Jetzt buchen' }}
            secondary={{ href: '/offerte', label: 'Offerte anfordern' }}
          />
        </div>
      </Section>

      {/* Strukturierte Daten für FAQ-Rich-Results */}
      {faqs.length > 0 ? (
        <script
          type="application/ld+json"
          // eslint-disable-next-line react/no-danger -- serverseitig erzeugter, kontrollierter JSON-LD-Block
          dangerouslySetInnerHTML={{
            __html: jsonLd({
              '@context': 'https://schema.org',
              '@type': 'FAQPage',
              mainEntity: faqs.map((faq) => ({
                '@type': 'Question',
                name: faq.question,
                acceptedAnswer: { '@type': 'Answer', text: faq.answer },
              })),
            }),
          }}
        />
      ) : null}
    </>
  );
}

/** „übermorgen" / Wochentag — ehrlicher als eine erfundene Zahl. */
function nextAvailableLabel(): string {
  const date = new Date();
  date.setDate(date.getDate() + 3);
  return new Intl.DateTimeFormat('de-CH', {
    timeZone: 'Europe/Zurich',
    weekday: 'long',
    day: 'numeric',
    month: 'short',
  }).format(date);
}
