import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { siteVisitCompleteSchema } from '@/lib/validation/verkauf';
import { getOrganizationId } from '@/server/services/organization.service';
import { completeSiteVisit } from '@/server/services/site-visit.service';

export const runtime = 'nodejs';

/** POST /api/site-visits/:id/complete — durchgeführt; mindestens eine Fläche (422). */
export const POST = defineRoute({
  permissions: ['quote:update'],
  params: idParam,
  body: siteVisitCompleteSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) =>
    ok(await completeSiteVisit({ organizationId: await getOrganizationId(), id: params.id, actorId: session.id, ip, findings: body.findings })),
});
