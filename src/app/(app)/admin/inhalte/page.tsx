import type { Metadata } from 'next';
import Link from 'next/link';
import { ExternalLink, FileText } from 'lucide-react';

import { prisma } from '@/lib/db';
import { requirePagePermission } from '@/lib/auth/session';
import { CONTENT_GROUPS, defaultContent } from '@/lib/cms/registry';
import {
  countCuratedContent,
  getContentStates,
  getPreviewContent,
} from '@/server/services/content.service';
import { getOrganizationId } from '@/server/services/organization.service';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/primitives';
import { PageHeader } from '@/components/app/page-parts';
import { ContentWorkspace, type PreviewPage } from '@/features/admin/content-workspace';

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
 *
 * Geladen wird der **Entwurfsstand** (`getPreviewContent`), nicht der
 * veröffentlichte: Der Arbeitsplatz soll dort weitermachen, wo jemand
 * aufgehört hat. Was die Website zeigt, steht in der Vorschau.
 *
 * **Warum die Seitenliste hier entsteht und nicht im Arbeitsplatz.** Seit die
 * Texte direkt in der Vorschau geschrieben werden, ist ein Baustein nur noch
 * dort erreichbar, wo er auf einer Seite steht. Zwei Bausteingruppen stehen
 * auf Detailseiten — Leistung und Ratgeberbeitrag —, und die brauchen einen
 * echten Datensatz in der Adresse. Welcher, weiss nur der Server.
 */
export default async function ContentPage() {
  await requirePagePermission('content:update');

  const organizationId = await getOrganizationId();
  const [current, stats, states, service, post] = await Promise.all([
    getPreviewContent(organizationId),
    countCuratedContent(organizationId),
    getContentStates(organizationId),
    prisma.service.findFirst({
      where: { organizationId, active: true },
      orderBy: { position: 'asc' },
      select: { slug: true, name: true },
    }),
    prisma.blogPost.findFirst({
      where: { organizationId, status: 'PUBLISHED', locale: 'DE' },
      orderBy: { publishedAt: 'desc' },
      select: { slug: true, title: true },
    }),
  ]);

  // Der jüngste Veröffentlichungszeitpunkt über alle Bausteine — er beantwortet
  // „seit wann sieht die Kundschaft den aktuellen Stand?".
  const lastPublishedAt = states
    .map((state) => state.publishedAt)
    .filter((date): date is Date => date !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  /**
   * Jede Seite, auf der ein Baustein aus dem Register steht — in der
   * Reihenfolge der Hauptnavigation. Detailseiten stehen direkt hinter ihrer
   * Übersicht und tragen den Namen des Beispiels, damit klar ist, dass die
   * Rahmentexte dort für *alle* Leistungen beziehungsweise Beiträge gelten.
   */
  const pages: PreviewPage[] = [
    { path: '/', label: 'Startseite' },
    { path: '/leistungen', label: 'Leistungen' },
    service ? { path: `/leistungen/${service.slug}`, label: `Leistung: ${service.name}` } : null,
    { path: '/preise', label: 'Preise' },
    { path: '/ueber-uns', label: 'Über uns' },
    { path: '/einsatzgebiet', label: 'Einsatzgebiet' },
    { path: '/galerie', label: 'Galerie' },
    { path: '/bewertungen', label: 'Bewertungen' },
    { path: '/faq', label: 'Häufige Fragen' },
    { path: '/karriere', label: 'Karriere' },
    { path: '/blog', label: 'Ratgeber' },
    post ? { path: `/blog/${post.slug}`, label: `Beitrag: ${post.title}` } : null,
    { path: '/kontakt', label: 'Kontakt' },
    { path: '/offerte', label: 'Offerte anfordern' },
    { path: '/buchen', label: 'Buchung' },
  ].filter((page): page is PreviewPage => page !== null);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Website-Texte"
        description="Alle Texte der öffentlichen Website — direkt in der Vorschau geschrieben. Jede Änderung wird als Entwurf gespeichert und erst mit dem Veröffentlichen sichtbar."
        actions={
          <Button asChild variant="outline">
            <Link href="/" target="_blank" rel="noreferrer">
              <ExternalLink aria-hidden />
              Veröffentlichte Website
            </Link>
          </Button>
        }
      />

      <Alert variant="info" title={`${stats.curated} von ${stats.total} Bausteinen angepasst`}>
        Nicht angepasste Bausteine zeigen den Auslieferungstext. Einen Text ganz zu löschen stellt
        diesen Text wieder her — Sie können also jederzeit zurück, ohne den ursprünglichen
        Wortlaut zu kennen.
      </Alert>

      <ContentWorkspace
        groups={CONTENT_GROUPS}
        pages={pages}
        initial={current}
        defaults={defaultContent()}
        draftCount={stats.drafts}
        lastPublishedAt={lastPublishedAt?.toISOString() ?? null}
      />

      <p className="flex items-start gap-2 text-meta leading-relaxed text-muted-foreground">
        <FileText className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        Leistungen, Preise, Bewertungen, Galerie, Blog und Stellen werden in ihren eigenen
        Bereichen gepflegt — dort gehören Bilder, Preise und Veröffentlichungsstände dazu.
      </p>
    </div>
  );
}
