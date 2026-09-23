import { defineRoute } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { siteVisitCreateSchema, siteVisitQuerySchema } from '@/lib/validation/verkauf';
import { getOrganizationId } from '@/server/services/organization.service';
import { createSiteVisit, listSiteVisits } from '@/server/services/site-visit.service';

export const runtime = 'nodejs';

/** GET /api/site-visits — Besichtigungen, optional je Status, Anfrage oder Kundschaft. */
export const GET = defineRoute({
  permissions: ['quote:read'],
  query: siteVisitQuerySchema,
  rateLimit: 'apiRead',
  handler: async ({ query }) =>
    ok(await listSiteVisits({ organizationId: await getOrganizationId(), status: query.status, leadId: query.leadId, customerId: query.customerId })),
});

/**
 * POST /api/site-visits — eine Besichtigung planen, zu einer Anfrage oder
 * einer Kundschaft. Anfrage, Kundschaft, Objekt und begutachtende Person
 * müssen der Organisation gehören (404/422).
 */
export const POST = defineRoute({
  permissions: ['quote:create'],
  body: siteVisitCreateSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) =>
    created(await createSiteVisit({ organizationId: await getOrganizationId(), actorId: session.id, ip, input: body })),
});
