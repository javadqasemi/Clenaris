import { defineRoute } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { createServiceSchema } from '@/lib/validation/catalog';
import { createService, listServices } from '@/server/services/catalog.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * GET /api/services — vollständiger Leistungskatalog, auch inaktive Einträge.
 *
 * Bewusst ohne Blätterung: der Katalog eines Reinigungsunternehmens umfasst
 * eine zweistellige Zahl von Einträgen, und die Verwaltungsoberfläche
 * sortiert sie um. Blättern hiesse, über Seitengrenzen zu sortieren.
 */
export const GET = defineRoute({
  permissions: ['service:read'],
  rateLimit: 'apiRead',
  handler: async () => ok(await listServices(await getOrganizationId())),
});

/** POST /api/services — neue Leistung anlegen. */
export const POST = defineRoute({
  permissions: ['service:create'],
  body: createServiceSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) => {
    const service = await createService({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      input: body,
    });
    return created({ id: service.id, slug: service.slug });
  },
});
