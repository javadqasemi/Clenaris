import { defineRoute, idParam } from '@/lib/api/handler';
import { noContent, ok } from '@/lib/api/response';
import { updateDocumentSchema } from '@/lib/validation/bi-knowledge';
import { deleteDocument, getDocument, updateDocument } from '@/server/services/document.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/bi/documents/:id — Akte mit allen Fassungen. */
export const GET = defineRoute({
  permissions: ['document:read', 'document:read_own'],
  anyPermission: true,
  params: idParam,
  rateLimit: 'apiRead',
  handler: async ({ params, session }) => ok(await getDocument(session, await getOrganizationId(), params.id)),
});

/** PATCH /api/bi/documents/:id — Angaben, Fristen, Sichtbarkeit. */
export const PATCH = defineRoute({
  permissions: ['document:update'],
  params: idParam,
  body: updateDocumentSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const document = await updateDocument(session, await getOrganizationId(), params.id, body);
    return ok({ id: document.id, visibility: document.visibility });
  },
});

/** DELETE /api/bi/documents/:id — Papierkorb. */
export const DELETE = defineRoute({
  permissions: ['document:delete'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session }) => {
    await deleteDocument(session, await getOrganizationId(), params.id);
    return noContent();
  },
});
