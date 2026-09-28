import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { siteVisitAreaParams } from '@/lib/validation/verkauf';
import { getOrganizationId } from '@/server/services/organization.service';
import { removeSiteVisitArea } from '@/server/services/site-visit.service';

export const runtime = 'nodejs';

/** DELETE /api/site-visits/:id/areas/:areaId — eine Fläche entfernen; nicht nach der Offerte. */
export const DELETE = defineRoute({
  permissions: ['quote:update'],
  params: siteVisitAreaParams,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) =>
    ok(await removeSiteVisitArea({ organizationId: await getOrganizationId(), id: params.id, areaId: params.areaId, actorId: session.id, ip })),
});
