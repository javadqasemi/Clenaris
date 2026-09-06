import type { Metadata } from 'next';
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
import { getContent, contentText, contentList } from '@/server/services/content.service';
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
                <Badge variant="outline" className="gap-2 border-border bg-card/70 py-1 pl-1.5">
                  <span className="status-dot bg-success" aria-hidden />
                  Termine ab {nextAvailableLabel()} frei
                </Badge>
                <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                  <Stars rating={averageRating} />
                  {averageRating.toFixed(1)} aus {ratingAgg._count} Bewertungen
                </span>
              </div>

              <h1 className="text-display font-bold text-balance text-foreground">
                {contentText(content, 'home.hero.titleLine1')}
                <br />
                {contentText(content, 'home.hero.titleLine2')}
              </h1>

              <p className="prose-measure text-lg leading-relaxed text-muted-foreground">
                {contentText(content, 'home.hero.lead')}
              </p>

              <QuickEstimate
                services={services.map((service) => ({
                  slug: service.slug,
                  name: service.name,
                  kind: service.kind,
                  pricingModel: service.pricingModel,
                }))}
              />

              <ul className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
                {contentList(content, 'home.hero.bullets').map((item) => (
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
            { value: `${areaCount}`, label: 'Postleitzahlen im Einsatzgebiet' },
            { value: `${Math.max(completedJobs, 1)}`, label: 'Abgeschlossene Einsätze' },
            { value: averageRating.toFixed(1), label: 'Durchschnittliche Bewertung' },
            { value: '24 Std.', label: 'Antwort auf jede Offertanfrage' },
          ]}
        />
      </div>

      {/* ================== Leistungen ================== */}
      <Section>
        <div className="container">
          <SectionIntro
            title="Was wir für Sie tun"
            lead="Sechs Leistungen, klar abgegrenzt. Jede mit einem Preis, den Sie vorher kennen."
            action={{ href: '/leistungen', label: 'Alle Details' }}
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
            title="So läuft es ab"
            lead="Vier Schritte vom Klick bis zur sauberen Wohnung. Ohne Rückrufschlaufe, ohne Preisverhandlung."
          />
          <ProcessSteps
            steps={[
              {
                title: 'Preis berechnen',
                description:
                  'Leistung, Fläche und Termin eingeben. Der Preis erscheint sofort und ist verbindlich.',
              },
              {
                title: 'Termin wählen',
                description:
                  'Sie sehen nur Zeitfenster, in denen wir tatsächlich Kapazität haben. Keine Warteschlaufe.',
              },
              {
                title: 'Wir kommen',
                description:
                  'Ein festes Team, das Sie kennenlernen. Material und Reinigungsmittel bringen wir mit.',
              },
              {
                title: 'Bericht und Rechnung',
                description:
                  'Nach dem Einsatz erhalten Sie Fotos, die Checkliste und die QR-Rechnung mit 30 Tagen Frist.',
              },
            ]}
          />
        </div>
      </Section>

      {/* ================== Vertrauen ================== */}
      <Section>
        <div className="container space-y-14">
          <SectionIntro
            title="Warum Sie uns den Schlüssel geben können"
            lead="Reinigung heisst, Fremde in die eigenen Räume zu lassen. Das nehmen wir ernst."
            align="center"
          />

          <TrustRow
            items={[
              {
                icon: <Users aria-hidden />,
                title: 'Festangestelltes Team',
                description:
                  'Keine Subunternehmen, keine wechselnden Gesichter. Alle Mitarbeitenden sind bei uns angestellt und unfallversichert.',
              },
              {
                icon: <ShieldCheck aria-hidden />,
                title: 'Versichert bis CHF 5 Mio.',
                description:
                  'Betriebshaftpflicht für Sach- und Personenschäden. Schlüssel werden anonymisiert und protokolliert verwahrt.',
              },
              {
                icon: <ClipboardCheck aria-hidden />,
                title: 'Abgabegarantie',
                description:
                  'Beanstandet die Verwaltung etwas bei der Wohnungsübergabe, kommen wir innert 48 Stunden kostenlos zurück.',
              },
              {
                icon: <Clock3 aria-hidden />,
                title: 'Pünktlich oder Rabatt',
                description:
                  'Sind wir mehr als 30 Minuten zu spät, ziehen wir 20 % vom Rechnungsbetrag ab — ohne Nachfragen.',
              },
            ]}
          />
        </div>
      </Section>

      {/* ================== Bewertungen ================== */}
      {reviews.length > 0 ? (
        <Section className="bg-surface">
          <div className="container">
            <SectionIntro
              title="Was Kundinnen und Kunden sagen"
              lead="Bewertungen von Personen, die bei uns gebucht haben — ungefiltert."
              action={{ href: '/bewertungen', label: 'Alle Bewertungen' }}
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
              <h2 className="text-headline font-bold text-balance">Häufige Fragen</h2>
              <p className="text-lg leading-relaxed text-muted-foreground">
                Was Sie am häufigsten wissen möchten — kurz beantwortet.
              </p>
              <Button asChild variant="outline">
                <Link href="/faq">
                  Alle Fragen
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
            title={contentText(content, 'home.cta.title')}
            lead={contentText(content, 'home.cta.text')}
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
            __html: JSON.stringify({
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
