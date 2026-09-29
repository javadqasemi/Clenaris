import type { Metadata } from 'next';

import { prisma } from '@/lib/db';
import { requirePagePermission } from '@/lib/auth/session';
import { SEITEN_URL } from '@/lib/seiten-url';
import { SEO_PAGES } from '@/lib/cms/registry';
import { getOrganizationId } from '@/server/services/organization.service';
import { Alert } from '@/components/ui/primitives';
import { PageHeader } from '@/components/app/page-parts';
import { SeoEditor, type SeoPageState } from '@/features/admin/seo-editor';
import { SeoStatusUebersicht } from '@/features/admin/seo-status';
import {
  beitragsSeo,
  gepflegteSeo,
  leistungsSeo,
  seoStatus,
  stellenSeo,
  type SeoStatusZeile,
} from '@/lib/seo/metadaten';
import { RECHTSTEXTE } from '@/lib/seo/rechtstexte';
import { strukturierteDatenTypen } from '@/lib/seo/structured-data';

export const metadata: Metadata = {
  title: 'Suchmaschinen',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Suchmaschinenangaben der öffentlichen Seiten.
 *
 * Nur die Übersichtsseiten sind hier pflegbar. Leistungs-, Blog- und
 * Stellenseiten ziehen Titel und Beschreibung aus dem jeweiligen Datensatz —
 * sonst müsste die Redaktion für jeden neuen Beitrag einen Eintrag anlegen und
 * würde es vergessen.
 */
export default async function SeoPage() {
  await requirePagePermission('seo:update');

  const organizationId = await getOrganizationId();

  const stored = await prisma.seoMeta.findMany({
    where: { organizationId, locale: 'DE' },
    select: {
      path: true,
      title: true,
      description: true,
      keywords: true,
      ogImageUrl: true,
      noIndex: true,
    },
  });

  const byPath = new Map(stored.map((row) => [row.path, row]));

  /*
   * SEO-Status (H3). Dieselben Quellen wie die Seiten selbst: `SeoMeta` über
   * dem Registertext (`gepflegteSeo`, auch in `getPageSeo`), die Rechtstexte
   * aus `lib/seo/rechtstexte.ts`, die Detailseiten aus ihrem Datensatz
   * (`leistungsSeo`, `beitragsSeo`, `stellenSeo`, auch in deren
   * `generateMetadata`). Nur veröffentlichte bzw. aktive Datensätze — die
   * anderen antworten 404 und haben keinen Suchmaschinenauftritt.
   */
  const [services, posts, postings, faqCount, reviewCount] = await Promise.all([
    prisma.service.findMany({
      where: { organizationId, active: true },
      orderBy: { position: 'asc' },
      select: { slug: true, name: true, seoTitle: true, seoDescription: true, shortDesc: true, keywords: true },
    }),
    prisma.blogPost.findMany({
      where: { organizationId, status: 'PUBLISHED', locale: 'DE' },
      orderBy: { publishedAt: 'desc' },
      select: {
        slug: true,
        title: true,
        excerpt: true,
        seoTitle: true,
        seoDescription: true,
        keywords: true,
        publishedAt: true,
      },
    }),
    prisma.jobPosting.findMany({
      where: { organizationId, status: 'PUBLISHED' },
      orderBy: { title: 'asc' },
      select: { slug: true, title: true, location: true, description: true },
    }),
    prisma.faq.count({ where: { organizationId, active: true, locale: 'DE' } }),
    prisma.review.count({ where: { organizationId, status: 'PUBLISHED' } }),
  ]);

  const mitInhalt: Record<string, boolean> = { '/faq': faqCount > 0, '/bewertungen': reviewCount > 0 };

  const statusZeilen: SeoStatusZeile[] = [
    ...SEO_PAGES.map((definition) => {
      const row = byPath.get(definition.path);
      const seo = gepflegteSeo(definition, row);
      return seoStatus(
        {
          pfad: definition.path,
          bezeichnung: definition.label,
          quelle: row ? ('Redaktion' as const) : ('Standardtext' as const),
          titel: seo.title,
          beschreibung: seo.description,
          schluesselwoerter: seo.keywords,
          ogBildUrl: seo.ogImageUrl,
          noIndex: seo.noIndex,
          strukturierteDaten: strukturierteDatenTypen(definition.path, mitInhalt[definition.path] ?? true),
        },
        SEITEN_URL,
      );
    }),
    ...RECHTSTEXTE.map((seite) =>
      seoStatus(
        {
          ...seite,
          quelle: 'Code' as const,
          strukturierteDaten: strukturierteDatenTypen(seite.pfad),
        },
        SEITEN_URL,
      ),
    ),
    ...services.map((service) => {
      const seo = leistungsSeo(service);
      return seoStatus(
        {
          ...seo,
          bezeichnung: `Leistung: ${service.name}`,
          quelle: 'Datensatz' as const,
          strukturierteDaten: strukturierteDatenTypen(seo.pfad),
        },
        SEITEN_URL,
      );
    }),
    ...posts.map((post) => {
      const seo = beitragsSeo(post);
      return seoStatus(
        {
          ...seo,
          bezeichnung: `Ratgeber: ${post.title}`,
          quelle: 'Datensatz' as const,
          strukturierteDaten: strukturierteDatenTypen(seo.pfad),
        },
        SEITEN_URL,
      );
    }),
    ...postings.map((posting) => {
      const seo = stellenSeo(posting);
      return seoStatus(
        {
          ...seo,
          bezeichnung: `Stelle: ${posting.title}`,
          quelle: 'Datensatz' as const,
          strukturierteDaten: strukturierteDatenTypen(seo.pfad),
        },
        SEITEN_URL,
      );
    }),
  ];

  const pages: SeoPageState[] = SEO_PAGES.map((definition) => {
    const row = byPath.get(definition.path);
    return {
      path: definition.path,
      label: definition.label,
      title: row?.title ?? '',
      description: row?.description ?? '',
      keywords: row?.keywords ?? [],
      ogImageUrl: row?.ogImageUrl ?? '',
      noIndex: row?.noIndex ?? false,
      defaultTitle: definition.title,
      defaultDescription: definition.description,
      curated: Boolean(row),
    };
  });

  const hidden = pages.filter((page) => page.noIndex);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Suchmaschinen"
        description="Titel, Beschreibung und Vorschaubild der öffentlichen Seiten. Leere Felder verwenden den Standardtext."
      />

      {hidden.length > 0 ? (
        <Alert variant="warning" title={`${hidden.length} Seite(n) aus dem Index genommen`}>
          {hidden.map((page) => page.label).join(', ')} erscheinen nicht in den Suchergebnissen.
          Das ist meist Absicht — prüfen Sie es trotzdem, wenn Anfragen ausbleiben.
        </Alert>
      ) : null}

      {/* Die Suchvorschau zeigt die kanonische Domain — dieselbe wie im HTML der Website. */}
      <SeoEditor pages={pages} siteUrl={SEITEN_URL} />

      {/* Nach dem Editor: Zuerst wird gepflegt, dann nachgesehen, was daraus wird. */}
      <SeoStatusUebersicht zeilen={statusZeilen} />
    </div>
  );
}
