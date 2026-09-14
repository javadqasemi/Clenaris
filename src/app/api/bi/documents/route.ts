import { defineRoute } from '@/lib/api/handler';
import { buildPagination, created, paginated } from '@/lib/api/response';
import { createDocumentSchema, documentListQuery } from '@/lib/validation/bi-knowledge';
import { createDocument, listDocuments } from '@/server/services/document.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * GET /api/bi/documents — die Ablage im Rahmen der Sichtbarkeit.
 *
 * Mitarbeitende mit `document:read_own` sehen `STAFF`-Dokumente und ihre
 * eigene Personalakte; die Grenze steht in der `where`-Klausel des Dienstes.
 */
export const GET = defineRoute({
  permissions: ['document:read', 'document:read_own'],
  anyPermission: true,
  query: documentListQuery,
  rateLimit: 'apiRead',
  handler: async ({ query, session }) => {
    const { items, total } = await listDocuments(session, await getOrganizationId(), query);
    return paginated(items, buildPagination(query.page, query.pageSize, total));
  },
});

/** POST /api/bi/documents — Akte anlegen, wahlweise mit erster Fassung. */
export const POST = defineRoute({
  permissions: ['document:create'],
  body: createDocumentSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session }) => {
    const document = await createDocument(session, await getOrganizationId(), body);
    return created({ id: document.id, visibility: document.visibility });
  },
});
