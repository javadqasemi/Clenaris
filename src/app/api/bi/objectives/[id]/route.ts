import { defineRoute, idParam } from '@/lib/api/handler';
import { noContent, ok } from '@/lib/api/response';
import { updateObjectiveSchema } from '@/lib/validation/bi-objectives';
import { deleteObjective, getObjective, updateObjective } from '@/server/services/objective.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/bi/objectives/:id — mit Schlüsselergebnissen, Check-ins, Aufgaben, Unterzielen. */
export const GET = defineRoute({
  permissions: ['objective:read', 'objective:read_own'],
  anyPermission: true,
  params: idParam,
  rateLimit: 'apiRead',
  handler: async ({ params, session }) => {
    const organizationId = await getOrganizationId();
    return ok(await getObjective(session, organizationId, params.id));
  },
});

/** PATCH /api/bi/objectives/:id */
export const PATCH = defineRoute({
  permissions: ['objective:update'],
  params: idParam,
  body: updateObjectiveSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const organizationId = await getOrganizationId();
    const objective = await updateObjective(session, organizationId, params.id, body);
    return ok({ id: objective.id, status: objective.status, progressPct: objective.progressPct });
  },
});

/** DELETE /api/bi/objectives/:id — Papierkorb. */
export const DELETE = defineRoute({
  permissions: ['objective:delete'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session }) => {
    const organizationId = await getOrganizationId();
    await deleteObjective(session, organizationId, params.id);
    return noContent();
  },
});
