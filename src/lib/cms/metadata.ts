import 'server-only';

import type { Metadata } from 'next';

import { getOrganizationId } from '@/server/services/organization.service';
import { getPageSeo } from '@/server/services/content.service';

/**
 * Erzeugt die Metadaten einer öffentlichen Seite aus den gepflegten Angaben.
 *
 * Architekturentscheid: Die Seiten deklarieren nicht mehr selbst `metadata`,
 * sondern rufen `generateMetadata` mit ihrem Pfad auf. Sonst gäbe es zwei
 * Wahrheiten — die redaktionell gepflegte und die im Code stehende — und die
 * Redaktion würde speichern, ohne dass sich am Suchergebnis etwas ändert.
 *
 * Der Rückfall auf das Register bleibt: fehlt eine gepflegte Angabe oder ist
 * die Datenbank nicht erreichbar, gilt der Auslieferungstext. Eine Seite ohne
 * Titel wäre in den Suchergebnissen unbrauchbar.
 *
 * Aufruf in der Seite:
 *
 *   export const generateMetadata = () => pageMetadata('/preise');
 */
export async function pageMetadata(path: string): Promise<Metadata> {
  const organizationId = await getOrganizationId();
  const seo = await getPageSeo(organizationId, path);

  return {
    title: seo.title,
    description: seo.description,
    ...(seo.keywords.length > 0 ? { keywords: seo.keywords } : {}),
    alternates: { canonical: path },
    openGraph: {
      title: seo.title,
      description: seo.description,
      url: path,
      ...(seo.ogImageUrl ? { images: [{ url: seo.ogImageUrl }] } : {}),
    },
    twitter: {
      card: 'summary_large_image',
      title: seo.title,
      description: seo.description,
      ...(seo.ogImageUrl ? { images: [seo.ogImageUrl] } : {}),
    },
    // `noIndex` wirkt hier *und* über den Robots-Header; die Redaktion soll
    // sich nicht darauf verlassen müssen, dass beides gepflegt ist.
    robots: seo.noIndex
      ? { index: false, follow: true }
      : {
          index: true,
          follow: true,
          googleBot: { index: true, follow: true, 'max-image-preview': 'large', 'max-snippet': -1 },
        },
  };
}
