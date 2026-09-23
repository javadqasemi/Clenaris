import { defineRoute } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { materialCreateSchema, materialQuerySchema } from '@/lib/validation/betrieb';
import { createMaterial, listMaterials } from '@/server/services/inventory.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * GET /api/materials — Material mit Bestand (Summe der Bewegungen),
 * Lagerwert und Meldebestand. `nachbestellen=true` zeigt nur, was am oder
 * unter dem Meldebestand liegt.
 */
export const GET = defineRoute({
  permissions: ['inventory:read'],
  query: materialQuerySchema,
  rateLimit: 'apiRead',
  handler: async ({ query }) =>
    ok(
      await listMaterials({
        organizationId: await getOrganizationId(),
        nachbestellen: query.nachbestellen === 'true',
        inaktive: query.inaktive === 'true',
      }),
    ),
});

/** POST /api/materials — Material anlegen; die Artikelnummer ist je Organisation eindeutig (409). */
export const POST = defineRoute({
  permissions: ['inventory:manage'],
  body: materialCreateSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) =>
    created(await createMaterial({ organizationId: await getOrganizationId(), actorId: session.id, ip, input: body })),
});
