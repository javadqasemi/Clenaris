import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { updateCategorySchema } from '@/lib/validation/catalog';
import { deleteCategory, updateCategory } from '@/server/services/catalog.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** PATCH /api/service-categories/:id */
export const PATCH = defineRoute({
  permissions: ['service:update'],
  params: idParam,
  body: updateCategorySchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) => {
    const category = await updateCategory({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      categoryId: params.id,
      input: body,
    });
    return ok({ id: category.id, slug: category.slug });
  },
});

/**
 * DELETE /api/service-categories/:id
 *
 * Löscht die Gruppe, nicht die Leistungen darin — deren Zuordnung wird auf
 * „ohne Kategorie" gesetzt. Die Antwort nennt die Zahl der betroffenen
 * Leistungen, damit die Oberfläche das ungefragt anzeigen kann.
 */
export const DELETE = defineRoute({
  permissions: ['service:delete'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) => {
    const result = await deleteCategory({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      categoryId: params.id,
    });
    return ok(result);
  },
});
