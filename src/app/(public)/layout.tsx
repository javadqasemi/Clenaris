import { prisma } from '@/lib/db';
import { jsonLd } from '@/lib/json-ld';
import {
  getOrganizationId,
  getPublicCompanyInfo,
  getServiceAreas,
} from '@/server/services/organization.service';
import { listPublicCtas } from '@/server/services/cta.service';
import { SiteHeader } from '@/components/marketing/site-header';
import { SiteFooter } from '@/components/marketing/site-footer';
import { AnalyticsScripts } from '@/components/marketing/analytics';
import { CookieBanner } from '@/components/marketing/cookie-banner';
import { ChatWidget } from '@/components/marketing/chat-widget';
import { CmsPreviewBridge } from '@/components/cms/preview-bridge';
import { isPreview } from '@/lib/cms/preview';

/**
 * Rahmen der öffentlichen Website.
 *
 * Architekturentscheide:
 *
 *  • Kopf- und Fusszeile brauchen Firmendaten, Leistungsliste und
 *    Einsatzgebiet. Diese Abfragen laufen hier *einmal* pro Rendering (mit
 *    Cache), statt in jeder Seite wiederholt zu werden.
 *
 *  • Die Sitzung wird hier bewusst **nicht** gelesen. Ein Cookie-Zugriff im
 *    Layout macht jede darunterliegende Seite dynamisch — dann wäre jeder
 *    Besuch der Startseite eine Datenbankabfrage, obwohl sich der Inhalt
 *    stündlich ändert. Der einzige sitzungsabhängige Teil ist der
 *    Kontoknopf, und der holt seinen Zustand selbst
 *    (`components/marketing/account-button.tsx`). So wird die gesamte
 *    Website statisch vorgerendert und nur bei Ablauf der Revalidierung neu
 *    gebaut.
 */
export default async function PublicLayout({ children }: { children: React.ReactNode }) {
  const organizationId = await getOrganizationId();

  /**
   * Die Aufrufe für Kopf-, Fusszeile und mobile Leiste werden hier
   * *ungefiltert* geladen und weitergereicht. Das Layout kennt den aktuellen
   * Pfad nicht — die Middleware läuft aus gutem Grund nicht auf öffentlichen
   * Seiten, und ein Layout bekommt ihn in Next.js nicht gereicht. Die Auswahl
   * fällt deshalb im Browser (`CtaSlot`), nach derselben Regel wie auf dem
   * Server. Es sind eine Handvoll Zeilen; das kostet nichts.
   */
  const preview = await isPreview();

  const [company, services, areas, ctas] = await Promise.all([
    getPublicCompanyInfo(),
    prisma.service.findMany({
      where: { organizationId, active: true },
      orderBy: { position: 'asc' },
      select: { slug: true, name: true, shortDesc: true, icon: true },
    }),
    getServiceAreas(),
    listPublicCtas(organizationId, ['HEADER', 'FOOTER', 'MOBILE_BAR']),
  ]);

  return (
    <>
      <SiteHeader
        services={services}
        phone={company.phone ?? ''}
        ctas={ctas.filter((cta) => cta.slot === 'HEADER')}
        mobileCtas={ctas.filter((cta) => cta.slot === 'MOBILE_BAR')}
      />

      <main id="inhalt" className="min-h-[60vh]">
        {children}
      </main>

      <SiteFooter
        company={company}
        services={services.map((s) => ({ slug: s.slug, name: s.name }))}
        areas={areas.map((a) => ({ postalCode: a.postalCode, city: a.city }))}
        ctas={ctas.filter((cta) => cta.slot === 'FOOTER')}
      />

      <CookieBanner />
      <ChatWidget />
      <AnalyticsScripts />

      {/*
        Nur im Vorschaumodus: macht die gepflegten Texte anklickbar und meldet
        die Auswahl an die Redaktionsmaske. Für Besucherinnen und Besucher wird
        hier nichts gerendert — kein Skript, kein Attribut.
      */}
      {preview ? <CmsPreviewBridge /> : null}

      {/* Strukturierte Daten für lokale Suchergebnisse. */}
      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger -- kontrollierter, serverseitig erzeugter JSON-LD-Block
        dangerouslySetInnerHTML={{
          __html: jsonLd({
            '@context': 'https://schema.org',
            '@type': 'HomeAndConstructionBusiness',
            '@id': `${process.env.NEXT_PUBLIC_APP_URL}#organisation`,
            name: company.name,
            legalName: company.legalName ?? undefined,
            description:
              'Reinigungsfirma im Kanton Bern für Unterhaltsreinigung, Umzugsreinigung mit Abgabegarantie, Büroreinigung, Fensterreinigung, Baureinigung und Hauswartung.',
            url: process.env.NEXT_PUBLIC_APP_URL,
            telephone: company.phone ?? undefined,
            email: company.email,
            priceRange: 'CHF 62–95 / Std.',
            address: {
              '@type': 'PostalAddress',
              streetAddress: company.address.street,
              postalCode: company.address.postalCode,
              addressLocality: company.address.city,
              addressRegion: company.address.canton,
              addressCountry: 'CH',
            },
            areaServed: areas.slice(0, 30).map((area) => ({
              '@type': 'City',
              name: area.city,
              postalCode: area.postalCode,
            })),
            openingHoursSpecification: company.openingHours
              .filter((hour) => !hour.closed && hour.opensAt && hour.closesAt)
              .map((hour) => ({
                '@type': 'OpeningHoursSpecification',
                dayOfWeek: [
                  'Sunday',
                  'Monday',
                  'Tuesday',
                  'Wednesday',
                  'Thursday',
                  'Friday',
                  'Saturday',
                ][hour.weekday],
                opens: hour.opensAt,
                closes: hour.closesAt,
              })),
            hasOfferCatalog: {
              '@type': 'OfferCatalog',
              name: 'Reinigungsdienstleistungen',
              itemListElement: services.map((service) => ({
                '@type': 'Offer',
                itemOffered: { '@type': 'Service', name: service.name, description: service.shortDesc },
              })),
            },
          }),
        }}
      />
    </>
  );
}
