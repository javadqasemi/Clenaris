import type { MetadataRoute } from 'next';

import { prisma } from '@/lib/db';
import { clientEnv } from '@/lib/env';
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
 */
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = clientEnv.NEXT_PUBLIC_APP_URL.replace(/\/$/, '');

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: base, changeFrequency: 'weekly', priority: 1 },
    { url: `${base}/leistungen`, changeFrequency: 'monthly', priority: 0.9 },
    { url: `${base}/preise`, changeFrequency: 'monthly', priority: 0.9 },
    { url: `${base}/buchen`, changeFrequency: 'monthly', priority: 0.9 },
    { url: `${base}/offerte`, changeFrequency: 'monthly', priority: 0.8 },
    { url: `${base}/einsatzgebiet`, changeFrequency: 'monthly', priority: 0.7 },
    { url: `${base}/galerie`, changeFrequency: 'weekly', priority: 0.7 },
    { url: `${base}/bewertungen`, changeFrequency: 'weekly', priority: 0.7 },
    { url: `${base}/ueber-uns`, changeFrequency: 'monthly', priority: 0.6 },
    { url: `${base}/faq`, changeFrequency: 'monthly', priority: 0.6 },
    { url: `${base}/blog`, changeFrequency: 'weekly', priority: 0.6 },
    { url: `${base}/karriere`, changeFrequency: 'weekly', priority: 0.5 },
    { url: `${base}/kontakt`, changeFrequency: 'yearly', priority: 0.5 },
    { url: `${base}/legal/impressum`, changeFrequency: 'yearly', priority: 0.2 },
    { url: `${base}/legal/datenschutz`, changeFrequency: 'yearly', priority: 0.2 },
    { url: `${base}/legal/agb`, changeFrequency: 'yearly', priority: 0.2 },
    { url: `${base}/legal/cookies`, changeFrequency: 'yearly', priority: 0.2 },
  ];

  try {
    const [services, posts, postings] = await Promise.all([
      prisma.service.findMany({
        where: { active: true },
        select: { slug: true, updatedAt: true },
      }),
      prisma.blogPost.findMany({
        where: { status: 'PUBLISHED', locale: 'DE' },
        select: { slug: true, updatedAt: true },
      }),
      prisma.jobPosting.findMany({
        where: { status: 'PUBLISHED' },
        select: { slug: true, updatedAt: true },
      }),
    ]);

    return [
      ...staticRoutes,
      ...services.map((service) => ({
        url: `${base}/leistungen/${service.slug}`,
        lastModified: service.updatedAt,
        changeFrequency: 'monthly' as const,
        priority: 0.8,
      })),
      ...posts.map((post) => ({
        url: `${base}/blog/${post.slug}`,
        lastModified: post.updatedAt,
        changeFrequency: 'monthly' as const,
        priority: 0.5,
      })),
      ...postings.map((posting) => ({
        url: `${base}/karriere/${posting.slug}`,
        lastModified: posting.updatedAt,
        changeFrequency: 'weekly' as const,
        priority: 0.4,
      })),
    ];
  } catch (error) {
    // Ohne Datenbank liefern wir die statischen Routen — besser als gar keine Sitemap.
    log.error('Dynamische Routen konnten nicht geladen werden', { error });
    return staticRoutes;
  }
}
