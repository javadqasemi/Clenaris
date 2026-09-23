import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { siteVisitUpdateSchema } from '@/lib/validation/verkauf';
import { getOrganizationId } from '@/server/services/organization.service';
import { getSiteVisit, updateSiteVisit } from '@/server/services/site-visit.service';

export const runtime = 'nodejs';

/** GET /api/site-visits/:id — mit Flächen, Leistungen und der letzten Berechnung. */
export const GET = defineRoute({
  permissions: ['quote:read'],
  params: idParam,
  rateLimit: 'apiRead',
  handler: async ({ params }) => ok(await getSiteVisit(await getOrganizationId(), params.id)),
});

/**
 * PATCH /api/site-visits/:id — Termin, Begutachtung, Adresse, Befund. Nicht
 * mehr, sobald eine Offerte daraus entstanden ist (422). Eine Änderung
 * verwirft die gespeicherte Berechnung.
 */
export const PATCH = defineRoute({
  permissions: ['quote:update'],
  params: idParam,
  body: siteVisitUpdateSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) =>
    ok(await updateSiteVisit({ organizationId: await getOrganizationId(), id: params.id, actorId: session.id, ip, input: body })),
});
