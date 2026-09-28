import { defineRoute, idParam } from '@/lib/api/handler';
import { noContent, ok } from '@/lib/api/response';
import { updateCtaSchema } from '@/lib/validation/cta';
import { ctaDeleteQuery } from '@/lib/validation/queries';
import { deleteCta, getCta, purgeCta, updateCta } from '@/server/services/cta.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/cta/:id */
export const GET = defineRoute({
  permissions: ['cta:read'],
  params: idParam,
  rateLimit: 'apiRead',
  handler: async ({ params }) => ok(await getCta(await getOrganizationId(), params.id)),
});

/** PATCH /api/cta/:id — Teil-Update. */
export const PATCH = defineRoute({
  permissions: ['cta:update'],
  params: idParam,
  body: updateCtaSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) => {
    const cta = await updateCta({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      ctaId: params.id,
      input: body,
    });
    return ok({ id: cta.id, key: cta.key, active: cta.active });
  },
});

/**
 * DELETE /api/cta/:id
 *
 * Standard ist der Papierkorb: ein Handlungsaufruf besteht aus Text, Farbe,
 * Symbol, Ziel, Seitenliste und Zeitplan — versehentlich gelöscht wäre das
 * alles neu zu tippen. `?endgueltig=1` entfernt ihn wirklich, aber nur, wenn
 * er bereits im Papierkorb liegt.
 */
export const DELETE = defineRoute({
  permissions: ['cta:delete'],
  params: idParam,
  query: ctaDeleteQuery,
  rateLimit: 'apiWrite',
  handler: async ({ params, query, session, ip }) => {
    const context = {
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      ctaId: params.id,
    };

    if (query.endgueltig) await purgeCta(context);
    else await deleteCta(context);

    return noContent();
  },
});
