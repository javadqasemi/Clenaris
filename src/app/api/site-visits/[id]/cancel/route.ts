import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { siteVisitCancelSchema } from '@/lib/validation/verkauf';
import { getOrganizationId } from '@/server/services/organization.service';
import { cancelSiteVisit } from '@/server/services/site-visit.service';

export const runtime = 'nodejs';

/** POST /api/site-visits/:id/cancel — absagen, mit Grund; nicht nach der Offerte. */
export const POST = defineRoute({
  permissions: ['quote:update'],
  params: idParam,
  body: siteVisitCancelSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) =>
    ok(await cancelSiteVisit({ organizationId: await getOrganizationId(), id: params.id, actorId: session.id, ip, reason: body.reason })),
});
