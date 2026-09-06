import { defineRoute, idParam } from '@/lib/api/handler';
import { noContent, ok } from '@/lib/api/response';
import { updateServiceAreaSchema } from '@/lib/validation/operations-admin';
import { deleteServiceArea, updateServiceArea } from '@/server/services/operations-admin.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** PATCH /api/service-areas/:id */
export const PATCH = defineRoute({
  permissions: ['serviceArea:update'],
  params: idParam,
  body: updateServiceAreaSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) => {
    const area = await updateServiceArea({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      areaId: params.id,
      input: body,
    });
    return ok({ id: area.id, postalCode: area.postalCode, active: area.active });
  },
});

/**
 * DELETE /api/service-areas/:id
 *
 * Nicht möglich, solange dort Einsätze geplant sind: die Preisberechnung für
 * eine Verschiebung schlüge fehl. Setzen Sie das Gebiet stattdessen inaktiv.
 */
export const DELETE = defineRoute({
  permissions: ['serviceArea:update'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) => {
    await deleteServiceArea({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      areaId: params.id,
    });
    return noContent();
  },
});
