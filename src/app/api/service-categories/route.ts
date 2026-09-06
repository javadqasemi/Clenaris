import { defineRoute } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { createCategorySchema } from '@/lib/validation/catalog';
import { createCategory, listCategories } from '@/server/services/catalog.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/service-categories — Gruppen des Leistungskatalogs. */
export const GET = defineRoute({
  permissions: ['service:read'],
  rateLimit: 'apiRead',
  handler: async () => ok(await listCategories(await getOrganizationId())),
});

/** POST /api/service-categories — neue Kategorie anlegen. */
export const POST = defineRoute({
  permissions: ['service:create'],
  body: createCategorySchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) => {
    const category = await createCategory({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      input: body,
    });
    return created({ id: category.id, slug: category.slug });
  },
});
