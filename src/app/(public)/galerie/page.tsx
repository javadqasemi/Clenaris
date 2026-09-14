import type { Metadata } from 'next';

import { prisma } from '@/lib/db';
import { pageMetadata } from '@/lib/cms/metadata';
import { getOrganizationId } from '@/server/services/organization.service';
import { getContent } from '@/server/services/content.service';
import { createCms } from '@/lib/cms/editable';
import { isPreview } from '@/lib/cms/preview';
import { BeforeAfter } from '@/components/marketing/before-after';
import { Badge } from '@/components/ui/badge';
import { CallToAction, Section } from '@/components/marketing/sections';
import { EmptyState } from '@/components/app/page-parts';

/**
 * Titel, Beschreibung und Vorschaubild kommen aus der Redaktion
 * (`/admin/seo`); fehlt eine Angabe, gilt der Wert aus dem Register.
 */
export const generateMetadata = (): Promise<Metadata> => pageMetadata('/galerie');

export const revalidate = 3600;

const SERVICE_LABELS: Record<string, string> = {
  RESIDENTIAL_CLEANING: 'Unterhaltsreinigung',
  MOVE_OUT_CLEANING: 'Umzugsreinigung',
  OFFICE_CLEANING: 'Büroreinigung',
  WINDOW_CLEANING: 'Fensterreinigung',
  CONSTRUCTION_CLEANING: 'Baureinigung',
  BUILDING_MAINTENANCE: 'Hauswartung',
  SPECIAL: 'Spezialauftrag',
};

/**
 * Vorher-/Nachher-Galerie.
 *
 * Kein Raster aus Miniaturbildern: jedes Beispiel bekommt den vollen
 * Vergleichsregler. Ein Reinigungsergebnis wirkt nur, wenn man es selbst
 * aufdeckt — und genau diese Interaktion ist das Verkaufsargument.
 */
export default async function GalleryPage() {
  const organizationId = await getOrganizationId();
  const content = await getContent(organizationId);
  const cms = createCms(content, await isPreview());

  const items = await prisma.galleryItem.findMany({
    where: { organizationId, published: true },
    orderBy: [{ featured: 'desc' }, { position: 'asc' }],
  });

  return (
    <>
      <section className="relative overflow-hidden border-b border-border">
        <div className="aare-wash pointer-events-none absolute inset-0" aria-hidden />
        <div className="container relative py-16 sm:py-20">
          <div className="max-w-2xl space-y-5">
            <h1 className="text-display font-bold text-balance">Vorher und nachher</h1>
            <p className="text-lg leading-relaxed text-muted-foreground">
              Echte Einsätze, unbearbeitete Aufnahmen. Ziehen Sie den Regler durchs Bild — links der
              Zustand bei unserer Ankunft, rechts das Ergebnis.
            </p>
          </div>
        </div>
      </section>

      <Section>
        <div className="container">
          {items.length === 0 ? (
            <EmptyState
              title="Noch keine Beispiele veröffentlicht"
              description="Wir dokumentieren jeden Einsatz mit Vorher-/Nachher-Fotos. Sobald die ersten freigegeben sind, erscheinen sie hier."
              action={{ href: '/leistungen', label: 'Unsere Leistungen' }}
            />
          ) : (
            <div className="space-y-20">
              {items.map((item) => (
                <article key={item.id} className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-12">
                  <BeforeAfter
                    beforeSrc={item.beforeUrl}
                    afterSrc={item.afterUrl}
                    caption="Regler verschieben"
                    beforeAttrs={cms.asset('galleryItem', item.id, 'beforeUrl')}
                    afterAttrs={cms.asset('galleryItem', item.id, 'afterUrl')}
                  />

                  <div className="space-y-4 lg:pt-4">
                    {item.serviceKind ? (
                      <Badge variant="neutral">{SERVICE_LABELS[item.serviceKind]}</Badge>
                    ) : null}
                    <h2 className="text-title font-bold tracking-tight">{item.title}</h2>
                    {item.description ? (
                      <p className="leading-relaxed text-muted-foreground">{item.description}</p>
                    ) : null}
                    {item.location ? (
                      <p className="text-sm text-muted-foreground">{item.location}</p>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </Section>

      <Section className="pb-28">
        <div className="container">
          <CallToAction
            title={cms.text('gallery.cta.title')}
            lead={cms.text('gallery.cta.text')}
            primary={{ href: '/buchen', label: 'Termin buchen' }}
            secondary={{ href: '/bewertungen', label: 'Bewertungen lesen' }}
          />
        </div>
      </Section>
    </>
  );
}
