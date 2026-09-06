import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { updateNavItemSchema } from '@/lib/validation/navigation';
import { deleteNavItem, updateNavItem } from '@/server/services/navigation.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** PATCH /api/navigation/:id */
export const PATCH = defineRoute({
  permissions: ['navigation:update'],
  params: idParam,
  body: updateNavItemSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) => {
    const item = await updateNavItem({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      itemId: params.id,
      input: body,
    });
    return ok({ id: item.id, active: item.active });
  },
});

/**
 * DELETE /api/navigation/:id
 *
 * Unterpunkte gehen mit — ein Punkt im Aufklappbereich ohne seinen Aufklapper
 * wäre nirgends erreichbar. Die Antwort nennt unter `removedChildren`, wie
 * viele das betraf.
 */
export const DELETE = defineRoute({
  permissions: ['navigation:update'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) => {
    const result = await deleteNavItem({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      itemId: params.id,
    });
    return ok(result);
  },
});
