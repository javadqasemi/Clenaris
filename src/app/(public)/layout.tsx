import { prisma } from '@/lib/db';
import { SEITEN_URL } from '@/lib/seiten-url';
import { websiteGraph } from '@/lib/seo/structured-data';
import { JsonLd } from '@/components/marketing/json-ld';
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
import { TrafficMessung } from '@/components/marketing/traffic-messung';
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
        Eigene Besuchsmessung, nur mit Einwilligung „Statistik". Nicht im
        Vorschaumodus: Dort klickt die Redaktion durch die Seiten, und jeder
        ihrer Klicks wäre ein erfundener Besuch.
      */}
      {preview ? null : <TrafficMessung />}

      {/*
        Nur im Vorschaumodus: macht die gepflegten Texte anklickbar und meldet
        die Auswahl an die Redaktionsmaske. Für Besucherinnen und Besucher wird
        hier nichts gerendert — kein Skript, kein Attribut.
      */}
      {preview ? <CmsPreviewBridge /> : null}

      {/*
        Strukturierte Daten für lokale Suchergebnisse: die Firma
        (`HousekeepingService`, zugleich Organisation) und die Website als
        ein Graph. Jede Angabe steht auch sichtbar in der Fusszeile; die
        Begründung für Typ und Auswahl in `lib/seo/structured-data.ts`.
        Vorher standen hier eine erfundene Preisspanne, eine feste
        Beschreibung und Postleitzahlen an `City` (ein Feld, das es dort
        nicht gibt).
      */}
      <JsonLd
        daten={websiteGraph({
          firma: company,
          herkunft: SEITEN_URL,
          orte: areas,
          leistungen: services.map((service) => ({ name: service.name, slug: service.slug })),
        })}
      />
    </>
  );
}
