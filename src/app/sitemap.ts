import type { MetadataRoute } from 'next';

import { prisma } from '@/lib/db';
import { SEITEN_URL } from '@/lib/seiten-url';
import { absoluteSeitenUrl } from '@/lib/seo/metadaten';
import { getOrganizationId } from '@/server/services/organization.service';
import { logger } from '@/lib/logger';

const log = logger('sitemap');

/**
 * Sitemap.
 *
 * Enthält ausschliesslich öffentlich zugängliche Seiten. Kunden-, Portal- und
 * Administrationsbereiche fehlen bewusst — sie sind zusätzlich über
 * `robots.txt` und den `X-Robots-Tag`-Header der Middleware ausgeschlossen.
 *
 * `revalidate` hält die Sitemap aktuell, ohne bei jedem Crawler-Besuch die
 * Datenbank zu belasten.
 *
 * Zwei Korrekturen aus der SEO-Prüfung vom 2026-09-28:
 *
 *  • **Mit Organisation.** Die Abfragen nach Leistungen, Beiträgen und
 *    Stellen liefen ohne `organizationId` und hätten in einer Datenbank mit
 *    zwei Organisationen die Seiten der anderen aufgeführt — Adressen, die
 *    hier 404 antworten.
 *  • **Ohne `noindex`-Seiten.** Nimmt die Redaktion eine Seite in
 *    `/admin/seo` aus dem Index, stand sie trotzdem in der Sitemap: zwei
 *    widersprüchliche Signale, und die Search Console meldet genau diesen
 *    Widerspruch als Fehler („Eingereichte URL als noindex markiert").
 */
export const revalidate = 3600;

const STATISCHE_WEGE: { pfad: string; changeFrequency: 'weekly' | 'monthly' | 'yearly'; priority: number }[] = [
  { pfad: '/', changeFrequency: 'weekly', priority: 1 },
  { pfad: '/leistungen', changeFrequency: 'monthly', priority: 0.9 },
  { pfad: '/preise', changeFrequency: 'monthly', priority: 0.9 },
  { pfad: '/buchen', changeFrequency: 'monthly', priority: 0.9 },
  { pfad: '/offerte', changeFrequency: 'monthly', priority: 0.8 },
  { pfad: '/einsatzgebiet', changeFrequency: 'monthly', priority: 0.7 },
  { pfad: '/galerie', changeFrequency: 'weekly', priority: 0.7 },
  { pfad: '/bewertungen', changeFrequency: 'weekly', priority: 0.7 },
  { pfad: '/ueber-uns', changeFrequency: 'monthly', priority: 0.6 },
  { pfad: '/faq', changeFrequency: 'monthly', priority: 0.6 },
  { pfad: '/blog', changeFrequency: 'weekly', priority: 0.6 },
  { pfad: '/karriere', changeFrequency: 'weekly', priority: 0.5 },
  { pfad: '/kontakt', changeFrequency: 'yearly', priority: 0.5 },
  { pfad: '/legal/impressum', changeFrequency: 'yearly', priority: 0.2 },
  { pfad: '/legal/datenschutz', changeFrequency: 'yearly', priority: 0.2 },
  { pfad: '/legal/agb', changeFrequency: 'yearly', priority: 0.2 },
  { pfad: '/legal/cookies', changeFrequency: 'yearly', priority: 0.2 },
];

/** Adresse aus Herkunft und Pfad — dieselbe Funktion wie Canonical und JSON-LD. */
function url(pfad: string): string {
  return absoluteSeitenUrl(pfad, SEITEN_URL) ?? `${SEITEN_URL}${pfad}`;
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticRoutes: MetadataRoute.Sitemap = STATISCHE_WEGE.map((weg) => ({
    url: url(weg.pfad),
    changeFrequency: weg.changeFrequency,
    priority: weg.priority,
  }));

  try {
    const organizationId = await getOrganizationId();
    const [services, posts, postings, hidden] = await Promise.all([
      prisma.service.findMany({
        where: { organizationId, active: true },
        select: { slug: true, updatedAt: true },
      }),
      prisma.blogPost.findMany({
        where: { organizationId, status: 'PUBLISHED', locale: 'DE' },
        select: { slug: true, updatedAt: true },
      }),
      prisma.jobPosting.findMany({
        where: { organizationId, status: 'PUBLISHED' },
        select: { slug: true, updatedAt: true },
      }),
      prisma.seoMeta.findMany({
        where: { organizationId, locale: 'DE', noIndex: true },
        select: { path: true },
      }),
    ]);

    const ausgeblendet = new Set(hidden.map((row) => url(row.path)));

    return [
      ...staticRoutes,
      ...services.map((service) => ({
        url: url(`/leistungen/${service.slug}`),
        lastModified: service.updatedAt,
        changeFrequency: 'monthly' as const,
        priority: 0.8,
      })),
      ...posts.map((post) => ({
        url: url(`/blog/${post.slug}`),
        lastModified: post.updatedAt,
        changeFrequency: 'monthly' as const,
        priority: 0.5,
      })),
      ...postings.map((posting) => ({
        url: url(`/karriere/${posting.slug}`),
        lastModified: posting.updatedAt,
        changeFrequency: 'weekly' as const,
        priority: 0.4,
      })),
    ].filter((eintrag) => !ausgeblendet.has(eintrag.url));
  } catch (error) {
    // Ohne Datenbank liefern wir die statischen Routen — besser als gar keine Sitemap.
    log.error('Dynamische Routen konnten nicht geladen werden', { error });
    return staticRoutes;
  }
}
