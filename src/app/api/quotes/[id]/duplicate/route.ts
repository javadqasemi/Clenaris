import { defineRoute, idParam } from '@/lib/api/handler';
import { created } from '@/lib/api/response';
import { duplicateQuote } from '@/server/services/quote.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/quotes/:id/duplicate
 *
 * Die Kopie startet als Entwurf mit neuer Nummer und 30 Tagen Gültigkeit.
 * Häufigster Anwendungsfall: dieselbe Leistung für ein anderes Objekt.
 */
export const POST = defineRoute({
  permissions: ['quote:create'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session }) => {
    const organizationId = await getOrganizationId();

    const quote = await duplicateQuote({
      organizationId,
      quoteId: params.id,
      actorId: session.id,
    });

    return created({ id: quote.id, number: quote.number });
  },
});
