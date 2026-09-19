import { definePublicRoute } from '@/lib/api/handler';
import { prisma } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';
import { renderQuotePdf } from '@/lib/pdf/render';
import { publicTokenParams } from '@/lib/validation/queries';
import { resolveWithLegacy, tokenRejectionError } from '@/server/services/access-token.service';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/public/quotes/:token/pdf
 *
 * Offerte als PDF über den öffentlichen Link.
 *
 * **Korrektur.** Hier stand `findUnique({ where: { publicToken } })` — die
 * cuid-Spalte als Sicherheitsmerkmal, und damit dieselbe Tür, die Gate 1 an
 * der Antwortroute geschlossen hatte. Aufgelöst wird jetzt über die zentrale
 * Tokeninfrastruktur; `QUOTE_VIEW` genügt, ein `QUOTE_RESPOND` wird über die
 * Hierarchie mit akzeptiert.
 *
 * Der Rückfall auf alte Links bleibt für das Ansehen erlaubt, solange
 * `LEGACY_PUBLIC_TOKENS` ausdrücklich eingeschaltet ist — ein PDF anzusehen
 * ändert nichts.
 */
export const GET = definePublicRoute({
  params: publicTokenParams,
  // Engeres Kontingent als `apiRead`: Bei einem Link ohne Anmeldung ist das
  // Limit die zweite Verteidigungslinie hinter der Entropie des Tokens.
  rateLimit: 'publicTokenRead',
  handler: async ({ params }) => {
    const aufgeloest = await resolveWithLegacy({
      raw: params.token,
      purpose: 'QUOTE_VIEW',
      legacyLookup: async (raw) =>
        prisma.quote.findUnique({
          where: { publicToken: raw },
          select: { id: true, organizationId: true },
        }),
    });
    if (!aufgeloest.ok) throw tokenRejectionError(aufgeloest.reason, 'Offerte');

    const quote = await prisma.quote.findFirst({
      where: { id: aufgeloest.resourceId, organizationId: aufgeloest.organizationId },
      select: { id: true, deletedAt: true },
    });
    if (!quote || quote.deletedAt) throw new NotFoundError('Offerte');

    const { buffer, filename } = await renderQuotePdf(quote.id);

    return new Response(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/pdf',
        // `inline`: Das PDF soll sich im Fenster öffnen lassen. Der Viewer
        // aus Gate 3 setzt genau hier an; ein erzwungener Download wäre
        // dafür der falsche Vorgabewert.
        'Content-Disposition': `inline; filename="${filename}"`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
      },
    });
  },
});
