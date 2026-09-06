import { z } from 'zod';

import { defineRoute, idParam } from '@/lib/api/handler';
import { noContent, ok } from '@/lib/api/response';
import { deleteMedia, updateMedia } from '@/server/services/media.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

const FILE_SCOPES = [
  'BOOKING',
  'QUOTE',
  'INVOICE',
  'JOB',
  'CUSTOMER',
  'EMPLOYEE',
  'PROPERTY',
  'BLOG',
  'GALLERY',
  'APPLICATION',
  'EXPENSE',
  'MESSAGE',
  'OTHER',
] as const;

/** PATCH /api/media/:id — Dateiname und Zuordnung ändern. */
export const PATCH = defineRoute({
  permissions: ['media:update'],
  params: idParam,
  body: z.object({
    filename: z.string().trim().min(1).max(255).optional(),
    scope: z.enum(FILE_SCOPES).optional(),
  }),
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
  query: z.object({
    trotzdem: z
      .enum(['0', '1'])
      .default('0')
      .transform((v) => v === '1'),
  }),
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
