import { z } from 'zod';

import { defineRoute } from '@/lib/api/handler';
import { buildPagination, created, paginated } from '@/lib/api/response';
import { finalizeUploadSchema } from '@/lib/validation/files';
import { paginationQuery } from '@/lib/validation/queries';
import { finalizeUpload } from '@/server/services/file.service';
import { listMedia } from '@/server/services/media.service';
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

const listQuery = paginationQuery.extend({
  q: z.string().trim().max(120).optional(),
  scope: z.enum(FILE_SCOPES).optional(),
  nurBilder: z
    .enum(['0', '1'])
    .default('0')
    .transform((v) => v === '1'),
});

/** GET /api/media — Mediathek mit Blätterung. */
export const GET = defineRoute({
  permissions: ['media:read'],
  query: listQuery,
  rateLimit: 'apiRead',
  handler: async ({ query }) => {
    const { items, total, totalBytes } = await listMedia({
      organizationId: await getOrganizationId(),
      q: query.q,
      scope: query.scope,
      imagesOnly: query.nurBilder,
      page: query.page,
      pageSize: query.pageSize,
    });

    return paginated(items, {
      ...buildPagination(query.page, query.pageSize, total),
      // Der Gesamtverbrauch gehört in die Antwort: er ist die Zahl, wegen der
      // jemand die Mediathek überhaupt aufräumt.
      totalBytes,
    } as never);
  },
});

/**
 * POST /api/media — hochgeladene Datei registrieren.
 *
 * **Was dieser Endpunkt früher annahm.** Der Körper enthielt `path`, `url`,
 * `mimeType`, `sizeBytes`, `scope` und `isPublic` — alles vom Client, alles
 * ungeprüft übernommen, `isPublic` sogar mit `true` als Vorgabe. Damit liess
 * sich eine beliebige Adresse als vertrauenswürdige Datei der Organisation
 * eintragen, mit einem frei gewählten Typ und öffentlich lesbar. Ein Abgleich
 * mit dem, was tatsächlich im Speicher lag, fand nirgends statt.
 *
 * Übrig bleibt die Kennung des serverseitig ausgestellten Tickets. Pfad,
 * Typ, Grösse, Bereich und Sichtbarkeit schlägt der Abschluss selbst nach
 * bzw. leitet sie aus dem Upload-Profil ab — der Client kann keines davon
 * mehr behaupten.
 */
export const POST = defineRoute({
  permissions: ['media:upload'],
  body: finalizeUploadSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) => {
    const ergebnis = await finalizeUpload({
      ticketId: body.ticketId,
      organizationId: await getOrganizationId(),
      session,
      filename: body.filename,
      ip,
    });
    return created({ id: ergebnis.fileAssetId, url: ergebnis.url });
  },
});
