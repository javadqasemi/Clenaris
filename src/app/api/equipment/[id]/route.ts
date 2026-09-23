import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { equipmentUpdateSchema } from '@/lib/validation/betrieb';
import { getEquipment, updateEquipment } from '@/server/services/equipment.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/equipment/:id — mit Zuteilung und Wartungsbelegen. */
export const GET = defineRoute({
  permissions: ['equipment:read'],
  params: idParam,
  rateLimit: 'apiRead',
  handler: async ({ params }) => ok(await getEquipment(await getOrganizationId(), params.id)),
});

/** PATCH /api/equipment/:id — Stammdaten und Wartungsplanung; nicht nach der Ausmusterung. */
export const PATCH = defineRoute({
  permissions: ['equipment:manage'],
  params: idParam,
  body: equipmentUpdateSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) =>
    ok(await updateEquipment({ organizationId: await getOrganizationId(), id: params.id, actorId: session.id, ip, input: body })),
});
