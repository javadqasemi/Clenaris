import { defineRoute, idParam } from '@/lib/api/handler';
import { created } from '@/lib/api/response';
import { siteVisitQuoteSchema } from '@/lib/validation/verkauf';
import { getOrganizationId } from '@/server/services/organization.service';
import { createQuoteFromSiteVisit } from '@/server/services/site-visit.service';

export const runtime = 'nodejs';

/**
 * POST /api/site-visits/:id/quote — aus der durchgeführten Besichtigung
 * einen Offertentwurf. Neu gerechnet, eine Position je Fläche, Preise aus
 * der Berechnung; höchstens eine Offerte je Besichtigung (422), „Preis auf
 * Anfrage" wird nicht geraten (422).
 */
export const POST = defineRoute({
  permissions: ['quote:create'],
  params: idParam,
  body: siteVisitQuoteSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) =>
    created(await createQuoteFromSiteVisit({ organizationId: await getOrganizationId(), id: params.id, actorId: session.id, ip, input: body })),
});
