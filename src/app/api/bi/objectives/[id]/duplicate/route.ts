import { defineRoute, idParam } from '@/lib/api/handler';
import { created } from '@/lib/api/response';
import { duplicateObjective } from '@/server/services/objective.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** POST /api/bi/objectives/:id/duplicate — Kopie als Entwurf. */
export const POST = defineRoute({
  permissions: ['objective:create'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session }) => {
    const organizationId = await getOrganizationId();
    const copy = await duplicateObjective(session, organizationId, params.id);
    return created({ id: copy.id, title: copy.title });
  },
});
