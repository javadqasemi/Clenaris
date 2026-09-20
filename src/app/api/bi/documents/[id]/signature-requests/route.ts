import { defineRoute, idParam } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { requestContext } from '@/lib/http/request-context';
import { createDocumentSignatureRequestSchema } from '@/lib/validation/signatures';
import { getOrganizationId } from '@/server/services/organization.service';
import {
  createDocumentSignatureRequest,
  listSignatureRequestsForDocument,
} from '@/server/services/signature.service';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/bi/documents/:id/signature-requests — Vorgänge zu diesem Dokument.
 *
 * Sichtbar nur, wer das Dokument sehen darf und `signature:read` hält.
 */
export const GET = defineRoute({
  permissions: ['signature:read'],
  params: idParam,
  rateLimit: 'apiRead',
  handler: async ({ params, session }) => {
    const items = await listSignatureRequestsForDocument(session, await getOrganizationId(), params.id);
    return ok(items, { headers: { 'Cache-Control': 'private, no-store' } });
  },
});

/**
 * POST /api/bi/documents/:id/signature-requests — eine Fassung zur
 * Unterzeichnung versenden.
 *
 * `signature:create` zusätzlich zum Leserecht am Dokument: Wer Dokumente
 * sehen darf, darf sie nicht deshalb auch verschicken. Der Vorgang bindet
 * die gewählte Fassung und deren Prüfsumme; eine spätere Fassung ändert
 * daran nichts.
 */
export const POST = defineRoute({
  permissions: ['signature:create'],
  params: idParam,
  body: createDocumentSignatureRequestSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, request }) => {
    const ergebnis = await createDocumentSignatureRequest(
      session,
      await getOrganizationId(),
      params.id,
      body,
      requestContext(request),
    );
    return created(ergebnis);
  },
});
