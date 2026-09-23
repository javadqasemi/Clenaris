import { defineRoute, idParam } from '@/lib/api/handler';
import { created } from '@/lib/api/response';
import { equipmentMaintenanceSchema } from '@/lib/validation/betrieb';
import { recordMaintenance } from '@/server/services/equipment.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/equipment/:id/maintenance — eine durchgeführte Wartung
 * festhalten. Der Beleg ist unveränderlich; die nächste Fälligkeit rechnet
 * sich aus Wartungstag und Intervall. Eine Wartung in der Zukunft ist eine
 * Planung (422).
 */
export const POST = defineRoute({
  permissions: ['equipment:manage'],
  params: idParam,
  body: equipmentMaintenanceSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) =>
    created(await recordMaintenance({ organizationId: await getOrganizationId(), id: params.id, actorId: session.id, ip, input: body })),
});
