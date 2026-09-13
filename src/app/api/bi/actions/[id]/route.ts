import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { updateActionSchema } from '@/lib/validation/bi-governance';
import { updateAction } from '@/server/services/governance.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** PATCH /api/bi/actions/:id — abschliessen, Wirksamkeit bestätigen. */
export const PATCH = defineRoute({
  permissions: ['action:update'],
  params: idParam,
  body: updateActionSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const action = await updateAction(session, await getOrganizationId(), params.id, body);
    return ok({ id: action.id, completedAt: action.completedAt, effectivenessCheckedAt: action.effectivenessCheckedAt });
  },
});
