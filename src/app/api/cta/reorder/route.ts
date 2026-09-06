import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { ctaReorderSchema } from '@/lib/validation/cta';
import { reorderCtas } from '@/server/services/cta.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/cta/reorder — Reihenfolge innerhalb eines Platzes setzen.
 *
 * Gesendet wird die Reihenfolge als Liste von IDs; die Positionen vergibt der
 * Server aus dem Index. So kann kein Zustand entstehen, in dem zwei Aufrufe
 * dieselbe Position tragen und die Anzeige vom Zufall abhängt.
 */
export const POST = defineRoute({
  permissions: ['cta:update'],
  body: ctaReorderSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) => {
    const result = await reorderCtas({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      input: body,
    });
    return ok(result);
  },
});
