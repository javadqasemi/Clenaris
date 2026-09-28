import 'server-only';

import type { Metadata } from 'next';

import { SEITEN_URL } from '@/lib/seiten-url';
import { seitenMetadaten } from '@/lib/seo/metadaten';
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
 * Das Objekt selbst baut `seitenMetadaten()` (seit 2026-09-28): Klartext statt
 * Markup in Titel und Beschreibung, Canonical und `og:url` nur aus
 * `SEITEN_URL` und dem geprüften Pfad, das Vorschaubild nur als `https` oder
 * eigene Adresse, und `og:site_name`/`og:locale`, die vorher auf jeder
 * dieser Seiten fehlten, weil ein eigenes `openGraph` das des Layouts
 * ersetzt. Dieselbe Funktion rechnet die Übersicht in `/admin/seo`.
 *
 * Aufruf in der Seite:
 *
 *   export const generateMetadata = () => pageMetadata('/preise');
 */
export async function pageMetadata(path: string): Promise<Metadata> {
  const organizationId = await getOrganizationId();
  const seo = await getPageSeo(organizationId, path);

  return seitenMetadaten(
    {
      pfad: path,
      titel: seo.title,
      beschreibung: seo.description,
      schluesselwoerter: seo.keywords,
      ogBildUrl: seo.ogImageUrl,
      noIndex: seo.noIndex,
    },
    SEITEN_URL,
  );
}
