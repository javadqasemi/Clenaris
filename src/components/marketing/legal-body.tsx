import { Markdown } from '@/components/markdown';
import { getLegalDocument } from '@/server/services/navigation.service';
import { getOrganizationId } from '@/server/services/organization.service';

/**
 * Rechtstext aus der Datenbank — mit der eingebauten Fassung als Rückfall.
 *
 * Warum ein Rückfall und nicht einfach eine leere Seite: eine
 * Datenschutzerklärung, die nichts enthält, ist schlimmer als eine, die noch
 * die Auslieferungsfassung zeigt. Sie ist rechtlich gefordert, und ihr Fehlen
 * fällt niemandem auf, bis es jemandem auffällt.
 *
 * Sobald die Redaktion einen Text erfasst, ersetzt er den eingebauten
 * vollständig. Fassungsnummer und Inkrafttreten stehen dann unter dem Text —
 * sie sind der Bezugspunkt, wenn jemand fragt, welcher Fassung er zugestimmt
 * hat.
 */
export async function LegalBody({
  slug,
  children,
}: {
  slug: string;
  /** Die eingebaute Fassung. Wird gezeigt, solange nichts erfasst ist. */
  children: React.ReactNode;
}) {
  const organizationId = await getOrganizationId();
  const document = await getLegalDocument(organizationId, slug);

  if (!document || document.body.trim() === '') return <>{children}</>;

  return (
    <>
      <h1 className="text-headline font-bold">{document.title}</h1>
      <Markdown content={document.body} />
      <p className="mt-10 border-t border-border pt-4 text-meta text-muted-foreground">
        Fassung {document.version} · in Kraft seit{' '}
        {document.effectiveFrom.toLocaleDateString('de-CH', {
          day: '2-digit',
          month: 'long',
          year: 'numeric',
          timeZone: 'Europe/Zurich',
        })}
      </p>
    </>
  );
}
