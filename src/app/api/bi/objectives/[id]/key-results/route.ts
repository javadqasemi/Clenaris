import { defineRoute, idParam } from '@/lib/api/handler';
import { created } from '@/lib/api/response';
import { createKeyResultSchema } from '@/lib/validation/bi-objectives';
import { createKeyResult } from '@/server/services/objective.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** POST /api/bi/objectives/:id/key-results */
export const POST = defineRoute({
  permissions: ['objective:update'],
  params: idParam,
  body: createKeyResultSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const organizationId = await getOrganizationId();
    const keyResult = await createKeyResult(session, organizationId, params.id, body);
    return created({ id: keyResult.id, progressPct: keyResult.progressPct });
  },
});
