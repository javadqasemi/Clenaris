import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { materialUpdateSchema } from '@/lib/validation/betrieb';
import { getMaterial, updateMaterial } from '@/server/services/inventory.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/materials/:id — mit Bestand und den letzten Bewegungen. */
export const GET = defineRoute({
  permissions: ['inventory:read'],
  params: idParam,
  rateLimit: 'apiRead',
  handler: async ({ params }) => ok(await getMaterial(await getOrganizationId(), params.id)),
});

/**
 * PATCH /api/materials/:id — Stammdaten und Aktivität. Kein Bestandsfeld:
 * Bestand ändert sich nur über Bewegungen. Gelöscht wird Material nicht,
 * solange Bewegungen darauf zeigen — es wird inaktiv gesetzt.
 */
export const PATCH = defineRoute({
  permissions: ['inventory:manage'],
  params: idParam,
  body: materialUpdateSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) =>
    ok(await updateMaterial({ organizationId: await getOrganizationId(), id: params.id, actorId: session.id, ip, input: body })),
});
