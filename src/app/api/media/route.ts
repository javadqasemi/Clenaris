import { z } from 'zod';

import { defineRoute } from '@/lib/api/handler';
import { buildPagination, created, paginated } from '@/lib/api/response';
import { assetUrlSchema } from '@/lib/validation/common';
import { paginationQuery } from '@/lib/validation/queries';
import { listMedia, registerMedia } from '@/server/services/media.service';
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
 * Der eigentliche Upload läuft direkt zu Supabase (siehe
 * `/api/files/upload-url`). Dieser Endpunkt hält nur fest, was dort gelandet
 * ist — sonst gäbe es Dateien im Speicher, die in keiner Liste erscheinen.
 */
export const POST = defineRoute({
  permissions: ['media:upload'],
  body: z.object({
    bucket: z.string().trim().min(1).max(64).default('clenaris'),
    path: z.string().trim().min(1).max(500),
    // Nicht `.url()`: Ohne externen Speicher lautet die Adresse
    // `/api/files/blob/…`, und die Registrierung schlüge sonst mit 422 fehl.
    url: assetUrlSchema,
    filename: z.string().trim().min(1).max(255),
    mimeType: z.string().trim().min(1).max(120),
    sizeBytes: z.number().int().min(0).max(50 * 1024 * 1024),
    scope: z.enum(FILE_SCOPES).default('OTHER'),
    isPublic: z.boolean().default(true),
  }),
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) => {
    const file = await registerMedia({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      input: body,
    });
    return created({ id: file.id, url: file.url });
  },
});
