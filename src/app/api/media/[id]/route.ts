import { defineRoute, idParam } from '@/lib/api/handler';
import { noContent, ok } from '@/lib/api/response';
import { mediaUpdateSchema } from '@/lib/validation/files';
import { mediaDeleteQuery } from '@/lib/validation/queries';
import { deleteMedia, updateMedia } from '@/server/services/media.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** PATCH /api/media/:id — Dateiname und Zuordnung ändern. */
export const PATCH = defineRoute({
  permissions: ['media:update'],
  params: idParam,
  body: mediaUpdateSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) => {
    const file = await updateMedia({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      fileId: params.id,
      filename: body.filename,
      scope: body.scope,
    });
    return ok({ id: file.id, filename: file.filename, scope: file.scope });
  },
});

/**
 * DELETE /api/media/:id — endgültig löschen.
 *
 * Kein Papierkorb: die Datei liegt im Objektspeicher und kostet dort Geld.
 * Eine Zeile ohne Datei wäre kein Papierkorb, sondern ein toter Verweis.
 *
 * Hängt die Datei an einem Beleg, antwortet der Endpunkt mit 422 und nennt
 * woran. `?trotzdem=1` setzt sich darüber hinweg — bewusst als eigener
 * Schritt, damit niemand versehentlich ein Rechnungsdokument entfernt.
 */
export const DELETE = defineRoute({
  permissions: ['media:delete'],
  params: idParam,
  query: mediaDeleteQuery,
  rateLimit: 'apiWrite',
  handler: async ({ params, query, session, ip }) => {
    await deleteMedia({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      fileId: params.id,
      force: query.trotzdem,
    });
    return noContent();
  },
});
