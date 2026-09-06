import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { navReorderSchema } from '@/lib/validation/navigation';
import { reorderNavItems } from '@/server/services/navigation.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/navigation/reorder — Reihenfolge innerhalb eines Orts setzen.
 *
 * Sortiert wird je Ort und je Aufklappbereich getrennt: die Positionen zweier
 * verschiedener Menüs haben nichts miteinander zu tun.
 */
export const POST = defineRoute({
  permissions: ['navigation:update'],
  body: navReorderSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) => {
    const result = await reorderNavItems({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      input: body,
    });
    return ok(result);
  },
});
