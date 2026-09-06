import { defineRoute, idParam } from '@/lib/api/handler';
import { noContent, ok } from '@/lib/api/response';
import { updateExtraSchema } from '@/lib/validation/catalog';
import { deleteExtra, updateExtra } from '@/server/services/catalog.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * PATCH /api/service-extras/:id
 *
 * `serviceIds` ist der gewünschte *Endzustand* der Zuordnung, kein Zuwachs.
 * Wird das Feld weggelassen, bleibt die Zuordnung unangetastet.
 */
export const PATCH = defineRoute({
  permissions: ['service:update'],
  params: idParam,
  body: updateExtraSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) => {
    const extra = await updateExtra({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      extraId: params.id,
      input: body,
    });
    return ok({ id: extra.id, slug: extra.slug, active: extra.active });
  },
});

/** DELETE /api/service-extras/:id — nur, solange keine Buchung sie enthält. */
export const DELETE = defineRoute({
  permissions: ['service:delete'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) => {
    await deleteExtra({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      extraId: params.id,
    });
    return noContent();
  },
});
