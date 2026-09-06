import { defineRoute, idParam } from '@/lib/api/handler';
import { noContent, ok } from '@/lib/api/response';
import { updateGalleryItemSchema } from '@/lib/validation/website';
import { deleteGalleryItem, updateGalleryItem } from '@/server/services/website.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** PATCH /api/gallery/:id — Teil-Update. */
export const PATCH = defineRoute({
  permissions: ['gallery:update'],
  params: idParam,
  body: updateGalleryItemSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) => {
    const row = await updateGalleryItem({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      itemId: params.id,
      input: body,
    });
    return ok({ id: row.id });
  },
});

/**
 * DELETE /api/gallery/:id
 *
 * Endgültig. Die Bilddateien selbst liegen in der Mediathek und bleiben bestehen.
 */
export const DELETE = defineRoute({
  permissions: ['gallery:delete'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) => {
    await deleteGalleryItem({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      itemId: params.id,
    });
    return noContent();
  },
});
