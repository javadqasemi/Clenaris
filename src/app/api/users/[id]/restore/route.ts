import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { restoreUser } from '@/server/services/user.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/users/:id/restore — Konto aus dem Papierkorb holen.
 *
 * Kommt **gesperrt** zurück. Wer wiederherstellt, soll den Zugang bewusst in
 * einem zweiten Schritt freigeben — nicht, dass sich jemand im selben Moment
 * wieder anmelden kann.
 */
export const POST = defineRoute({
  permissions: ['user:delete'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) => {
    const user = await restoreUser({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      userId: params.id,
    });
    return ok({ id: user.id, status: user.status });
  },
});
