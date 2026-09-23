import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { getOrganizationId } from '@/server/services/organization.service';
import { calculateSiteVisit } from '@/server/services/site-visit.service';

export const runtime = 'nodejs';

/**
 * POST /api/site-visits/:id/calculate — jede Fläche durch dieselbe
 * Preisberechnung wie die Online-Buchung; das Ergebnis wird als Vorschau an
 * der Besichtigung festgehalten.
 */
export const POST = defineRoute({
  permissions: ['quote:update'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params }) => ok(await calculateSiteVisit({ organizationId: await getOrganizationId(), id: params.id })),
});
