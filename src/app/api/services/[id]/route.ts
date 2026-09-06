import { defineRoute, idParam } from '@/lib/api/handler';
import { noContent, ok } from '@/lib/api/response';
import { updateServiceSchema } from '@/lib/validation/catalog';
import { deleteService, getService, updateService } from '@/server/services/catalog.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/services/:id — eine Leistung samt Preisregeln und Zusatzzuordnung. */
export const GET = defineRoute({
  permissions: ['service:read'],
  params: idParam,
  rateLimit: 'apiRead',
  handler: async ({ params }) => ok(await getService(await getOrganizationId(), params.id)),
});

/**
 * PATCH /api/services/:id
 *
 * Teil-Update: gesendet wird nur, was sich geändert hat. Der Dienst prüft
 * Querbedingungen gegen den gespeicherten Stand, damit ein Wechsel des
 * Preismodells ohne passenden Ansatz nicht durchgeht.
 */
export const PATCH = defineRoute({
  permissions: ['service:update'],
  params: idParam,
  body: updateServiceSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) => {
    const service = await updateService({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      serviceId: params.id,
      input: body,
    });
    return ok({ id: service.id, slug: service.slug, active: service.active });
  },
});

/**
 * DELETE /api/services/:id
 *
 * Scheitert mit 422, sobald die Leistung in Buchungen, Offerten oder
 * Einsätzen vorkommt — die Antwort nennt die Zahl und verweist auf
 * „deaktivieren".
 */
export const DELETE = defineRoute({
  permissions: ['service:delete'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) => {
    await deleteService({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      serviceId: params.id,
    });
    return noContent();
  },
});
