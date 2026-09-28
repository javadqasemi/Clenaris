import { defineRoute, idParam } from '@/lib/api/handler';
import { created } from '@/lib/api/response';
import { stockMovementCreateSchema } from '@/lib/validation/betrieb';
import { bookMovement } from '@/server/services/inventory.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/materials/:id/movements — Eingang, Entnahme, Rückgabe oder
 * Inventurkorrektur buchen.
 *
 * Nur anfügen: Bewegungen lassen sich nicht ändern oder löschen (die
 * Datenbank verweigert es). Ein negativer Bestand wird abgewiesen (422);
 * gleichzeitige Entnahmen werden über eine Zeilensperre nacheinander geprüft.
 */
export const POST = defineRoute({
  permissions: ['inventory:manage'],
  params: idParam,
  body: stockMovementCreateSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) =>
    created(await bookMovement({ organizationId: await getOrganizationId(), materialId: params.id, actorId: session.id, ip, input: body })),
});
