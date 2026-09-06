import type { Metadata } from 'next';
import Link from 'next/link';
import { ExternalLink, FileText } from 'lucide-react';

import { requirePagePermission } from '@/lib/auth/session';
import { CONTENT_GROUPS, defaultContent } from '@/lib/cms/registry';
import { getContent, countCuratedContent } from '@/server/services/content.service';
import { getOrganizationId } from '@/server/services/organization.service';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/primitives';
import { PageHeader } from '@/components/app/page-parts';
import { ContentEditor } from '@/features/admin/content-editor';

export const metadata: Metadata = {
  title: 'Website-Texte',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Redaktion der Website-Texte.
 *
 * Die Seite kennt keine Felder — sie reicht das Register durch. Wächst der
 * Katalog der pflegbaren Bausteine, wächst diese Seite mit, ohne dass hier
 * etwas zu ändern wäre.
 */
export default async function ContentPage() {
  await requirePagePermission('content:update');

  const organizationId = await getOrganizationId();
  const [current, stats] = await Promise.all([
    getContent(organizationId),
    countCuratedContent(organizationId),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Website-Texte"
        description="Alle Texte der öffentlichen Website. Änderungen sind nach dem Speichern sofort sichtbar."
        actions={
          <Button asChild variant="outline">
            <Link href="/" target="_blank" rel="noreferrer">
              <ExternalLink aria-hidden />
              Website ansehen
            </Link>
          </Button>
        }
      />

      <Alert variant="info" title={`${stats.curated} von ${stats.total} Bausteinen angepasst`}>
        Nicht angepasste Bausteine zeigen den Auslieferungstext. Ein Feld zu leeren stellt diesen
        Text wieder her — Sie können also jederzeit zurück, ohne den ursprünglichen Wortlaut zu
        kennen.
      </Alert>

      <ContentEditor
        groups={CONTENT_GROUPS}
        initial={current}
        defaults={defaultContent()}
      />

      <p className="flex items-start gap-2 text-meta leading-relaxed text-muted-foreground">
        <FileText className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        Leistungen, Preise, Bewertungen, Galerie, Blog und Stellen werden in ihren eigenen
        Bereichen gepflegt — dort gehören Bilder, Preise und Veröffentlichungsstände dazu.
      </p>
    </div>
  );
}
