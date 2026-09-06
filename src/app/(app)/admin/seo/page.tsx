import type { Metadata } from 'next';

import { prisma } from '@/lib/db';
import { requirePagePermission } from '@/lib/auth/session';
import { clientEnv } from '@/lib/env';
import { SEO_PAGES } from '@/lib/cms/registry';
import { getOrganizationId } from '@/server/services/organization.service';
import { Alert } from '@/components/ui/primitives';
import { PageHeader } from '@/components/app/page-parts';
import { SeoEditor, type SeoPageState } from '@/features/admin/seo-editor';

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

      <SeoEditor pages={pages} siteUrl={clientEnv.NEXT_PUBLIC_APP_URL} />
    </div>
  );
}
