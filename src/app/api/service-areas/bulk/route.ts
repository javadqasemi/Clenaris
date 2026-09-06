import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { bulkServiceAreaSchema } from '@/lib/validation/operations-admin';
import { bulkUpsertServiceAreas } from '@/server/services/operations-admin.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/service-areas/bulk — mehrere Postleitzahlen auf einmal.
 *
 * Ein Einsatzgebiet entsteht selten Zeile für Zeile; meist übernimmt man eine
 * Liste aus einer Karte. Ohne `overwrite` bleiben bestehende Einträge
 * unangetastet — das ist der Normalfall beim Nachtragen einer Region. Die
 * Antwort nennt, wie viele angelegt, überschrieben und übersprungen wurden.
 */
export const POST = defineRoute({
  permissions: ['serviceArea:update'],
  body: bulkServiceAreaSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) => {
    const result = await bulkUpsertServiceAreas({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      input: body,
    });
    return ok(result);
  },
});
