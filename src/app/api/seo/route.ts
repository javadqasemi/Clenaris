import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { updateSeoSchema } from '@/lib/validation/cms';
import { getOrganizationId } from '@/server/services/organization.service';
import { updateSeoMeta } from '@/server/services/content.service';

export const runtime = 'nodejs';

/**
 * PATCH /api/seo — Suchmaschinenangaben einer Seite pflegen.
 *
 * Die Regeln (Leeren heisst zurücksetzen, `noIndex` gesondert protokolliert,
 * Seitencache leeren) stehen mit ihrer Begründung bei `updateSeoMeta` in
 * `content.service.ts` — neben `getPageSeo` und `invalidateSeo`, die dieselbe
 * Zeile lesen. Der Endpunkt übersetzt nur noch HTTP in diesen Aufruf.
 */
export const PATCH = defineRoute({
  permissions: ['seo:update'],
  body: updateSeoSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session }) => {
    const organizationId = await getOrganizationId();
    return ok(await updateSeoMeta({ organizationId, actorId: session.id, input: body }));
  },
});
