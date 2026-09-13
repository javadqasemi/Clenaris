import { defineRoute, idParam } from '@/lib/api/handler';
import { noContent, ok } from '@/lib/api/response';
import { updateControlSchema } from '@/lib/validation/bi-governance';
import { deleteControl, getControl, updateControl } from '@/server/services/governance.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/bi/controls/:id */
export const GET = defineRoute({
  permissions: ['control:read'],
  params: idParam,
  rateLimit: 'apiRead',
  handler: async ({ params }) => ok(await getControl(await getOrganizationId(), params.id)),
});

/** PATCH /api/bi/controls/:id */
export const PATCH = defineRoute({
  permissions: ['control:update'],
  params: idParam,
  body: updateControlSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const control = await updateControl(session, await getOrganizationId(), params.id, body);
    return ok({ id: control.id, status: control.status });
  },
});

/** DELETE /api/bi/controls/:id — Papierkorb. */
export const DELETE = defineRoute({
  permissions: ['control:delete'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session }) => {
    await deleteControl(session, await getOrganizationId(), params.id);
    return noContent();
  },
});
