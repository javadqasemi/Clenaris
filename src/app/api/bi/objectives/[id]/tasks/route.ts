import { defineRoute, idParam } from '@/lib/api/handler';
import { created } from '@/lib/api/response';
import { objectiveTaskSchema } from '@/lib/validation/bi-objectives';
import { createObjectiveTask } from '@/server/services/objective.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** POST /api/bi/objectives/:id/tasks — Massnahme als gewöhnliche Aufgabe. */
export const POST = defineRoute({
  permissions: ['objective:update'],
  params: idParam,
  body: objectiveTaskSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const organizationId = await getOrganizationId();
    const task = await createObjectiveTask(session, organizationId, params.id, body);
    return created({ id: task.id, title: task.title });
  },
});
