import { defineRoute, idParam } from '@/lib/api/handler';
import { noContent, ok } from '@/lib/api/response';
import { updateKeyResultSchema } from '@/lib/validation/bi-objectives';
import { deleteKeyResult, updateKeyResult } from '@/server/services/objective.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** PATCH /api/bi/key-results/:id */
export const PATCH = defineRoute({
  permissions: ['objective:update'],
  params: idParam,
  body: updateKeyResultSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const organizationId = await getOrganizationId();
    const keyResult = await updateKeyResult(session, organizationId, params.id, body);
    return ok({ id: keyResult.id, progressPct: keyResult.progressPct });
  },
});

/** DELETE /api/bi/key-results/:id */
export const DELETE = defineRoute({
  permissions: ['objective:update'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session }) => {
    const organizationId = await getOrganizationId();
    await deleteKeyResult(session, organizationId, params.id);
    return noContent();
  },
});
