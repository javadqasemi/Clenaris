import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { equipmentStatusSchema } from '@/lib/validation/betrieb';
import { setEquipmentStatus } from '@/server/services/equipment.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/equipment/:id/status — in Wartung geben, zurück in Betrieb,
 * ausmustern (mit Grund, endgültig).
 */
export const POST = defineRoute({
  permissions: ['equipment:manage'],
  params: idParam,
  body: equipmentStatusSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) =>
    ok(
      await setEquipmentStatus({
        organizationId: await getOrganizationId(),
        id: params.id,
        status: body.status,
        reason: body.reason,
        actorId: session.id,
        ip,
      }),
    ),
});
