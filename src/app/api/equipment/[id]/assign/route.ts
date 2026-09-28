import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { equipmentAssignSchema } from '@/lib/validation/betrieb';
import { assignEquipment } from '@/server/services/equipment.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/equipment/:id/assign — einer aktiven Person zuteilen oder mit
 * `employeeId: null` zurücknehmen. Nicht in Wartung, nicht ausgemustert.
 */
export const POST = defineRoute({
  permissions: ['equipment:manage'],
  params: idParam,
  body: equipmentAssignSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) =>
    ok(
      await assignEquipment({
        organizationId: await getOrganizationId(),
        id: params.id,
        employeeId: body.employeeId,
        actorId: session.id,
        ip,
      }),
    ),
});
