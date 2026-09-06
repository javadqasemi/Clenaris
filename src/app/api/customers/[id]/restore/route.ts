import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { restore } from '@/server/services/trash.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** POST /api/customers/:id/restore — aus dem Papierkorb zurückholen. */
export const POST = defineRoute({
  permissions: ['customer:delete'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) => {
    await restore(
      'customer',
      { organizationId: await getOrganizationId(), actorId: session.id, ip },
      params.id,
    );
    return ok({ id: params.id, restored: true });
  },
});
