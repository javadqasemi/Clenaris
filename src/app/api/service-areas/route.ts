import { defineRoute } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { createServiceAreaSchema } from '@/lib/validation/operations-admin';
import { createServiceArea, listServiceAreas } from '@/server/services/operations-admin.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/service-areas — Postleitzahlen, Anfahrtszeiten und Pauschalen. */
export const GET = defineRoute({
  permissions: ['serviceArea:read'],
  rateLimit: 'apiRead',
  handler: async () => ok(await listServiceAreas(await getOrganizationId())),
});

/**
 * POST /api/service-areas — eine Postleitzahl aufnehmen.
 *
 * Die Anfahrtspauschale fliesst in jeden künftigen Preis; deshalb wird die
 * Änderung protokolliert und der Preis-Zwischenspeicher geleert.
 */
export const POST = defineRoute({
  permissions: ['serviceArea:update'],
  body: createServiceAreaSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) => {
    const area = await createServiceArea({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      input: body,
    });
    return created({ id: area.id, postalCode: area.postalCode });
  },
});
