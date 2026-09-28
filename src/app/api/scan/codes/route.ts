import { defineRoute } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { can } from '@/lib/auth/rbac';
import { ForbiddenError } from '@/lib/errors';
import { internerInhalt } from '@/lib/scan/kennung';
import { scanCodeCreateSchema } from '@/lib/validation/scan';
import { getOrganizationId } from '@/server/services/organization.service';
import { codeErzeugen, ETIKETT_RECHT } from '@/server/services/scan.service';

export const runtime = 'nodejs';

/**
 * POST /api/scan/codes — den Etikettcode eines Datensatzes erzeugen oder den
 * bestehenden liefern (201 neu, 200 vorhanden).
 *
 * Die Schranke hier ist nur die grobe („darf irgendein Etikett pflegen");
 * welches Recht die *Art* verlangt, steht in `ETIKETT_RECHT` und wird im
 * Handler geprüft — Material verlangt `inventory:manage`, ein Objekt
 * `property:update`. Ein Datensatz einer fremden Organisation ist 404.
 */
export const POST = defineRoute({
  permissions: ['inventory:manage', 'equipment:manage', 'property:update', 'job:update'],
  anyPermission: true,
  body: scanCodeCreateSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) => {
    if (!can(session.role, ETIKETT_RECHT[body.entityType])) {
      throw new ForbiddenError('Für diese Art Datensatz dürfen Sie keine Etiketten erzeugen.');
    }
    const { code, neu } = await codeErzeugen({ organizationId: await getOrganizationId(), actorId: session.id, ip, art: body.entityType, id: body.entityId });
    const daten = { id: code.id, entityType: code.entityType, entityId: code.entityId, inhalt: internerInhalt(code.code), neu };
    return neu ? created(daten) : ok(daten);
  },
});
