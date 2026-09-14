import { defineRoute, idParam } from '@/lib/api/handler';
import { created } from '@/lib/api/response';
import { addDocumentVersionSchema } from '@/lib/validation/bi-knowledge';
import { addDocumentVersion } from '@/server/services/document.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** POST /api/bi/documents/:id/versions — neue Fassung; sie wird die geltende. */
export const POST = defineRoute({
  permissions: ['document:create'],
  params: idParam,
  body: addDocumentVersionSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const version = await addDocumentVersion(session, await getOrganizationId(), params.id, body);
    return created({ id: version.id, version: version.version });
  },
});
