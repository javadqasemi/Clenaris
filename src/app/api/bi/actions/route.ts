import { defineRoute } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { actionListQuery, createActionSchema } from '@/lib/validation/bi-governance';
import { createAction, listActions } from '@/server/services/governance.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/bi/actions — Massnahmen, offen zuerst. */
export const GET = defineRoute({
  permissions: ['action:read'],
  query: actionListQuery,
  rateLimit: 'apiRead',
  handler: async ({ query }) => ok(await listActions(await getOrganizationId(), query)),
});

/** POST /api/bi/actions — Massnahme eröffnen; mit Zuständigkeit entsteht eine Aufgabe. */
export const POST = defineRoute({
  permissions: ['action:create'],
  body: createActionSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session }) => {
    const action = await createAction(session, await getOrganizationId(), body);
    return created({ id: action.id, taskId: action.taskId });
  },
});
