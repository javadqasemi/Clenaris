import { defineRoute, idParam } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { siteVisitAreaSchema, siteVisitAreasSchema } from '@/lib/validation/verkauf';
import { getOrganizationId } from '@/server/services/organization.service';
import { addSiteVisitArea, setSiteVisitAreas } from '@/server/services/site-visit.service';

export const runtime = 'nodejs';

/**
 * PUT /api/site-visits/:id/areas — die aufgenommenen Flächen als Ganzes.
 * Leistungen aus dem aktiven Katalog der Organisation, Zusatzleistungen nur
 * die der Leistung. Kein Preisfeld.
 */
export const PUT = defineRoute({
  permissions: ['quote:update'],
  params: idParam,
  body: siteVisitAreasSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) =>
    ok(await setSiteVisitAreas({ organizationId: await getOrganizationId(), id: params.id, actorId: session.id, ip, areas: body.areas })),
});

/** POST /api/site-visits/:id/areas — eine Fläche anhängen; dieselben Prüfungen. */
export const POST = defineRoute({
  permissions: ['quote:update'],
  params: idParam,
  body: siteVisitAreaSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) =>
    created(await addSiteVisitArea({ organizationId: await getOrganizationId(), id: params.id, actorId: session.id, ip, area: body })),
});
