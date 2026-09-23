import { defineRoute } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { equipmentCreateSchema, equipmentQuerySchema } from '@/lib/validation/betrieb';
import { createEquipment, listEquipment } from '@/server/services/equipment.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * GET /api/equipment — Geräte mit Zuteilung und Wartungsfälligkeit.
 * Ausgemusterte nur mit `status=RETIRED`; `wartungFaellig=true` zeigt, was
 * in den nächsten 14 Tagen oder schon überfällig ist.
 */
export const GET = defineRoute({
  permissions: ['equipment:read'],
  query: equipmentQuerySchema,
  rateLimit: 'apiRead',
  handler: async ({ query }) =>
    ok(
      await listEquipment({
        organizationId: await getOrganizationId(),
        status: query.status,
        wartungFaellig: query.wartungFaellig === 'true',
      }),
    ),
});

/** POST /api/equipment — ein Gerät erfassen; die Inventarnummer vergibt der Server. */
export const POST = defineRoute({
  permissions: ['equipment:manage'],
  body: equipmentCreateSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) =>
    created(await createEquipment({ organizationId: await getOrganizationId(), actorId: session.id, ip, input: body })),
});
