import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { getOrganizationId } from '@/server/services/organization.service';
import { getSignatureRequestAdmin } from '@/server/services/signature.service';

export const runtime = 'nodejs';

/**
 * GET /api/signatures/:id — ein Vorgang mit Teilnehmenden und Protokoll.
 *
 * Keine Tokens, keine Codes, keine Cookies in der Antwort: Das Protokoll
 * enthält Kennungen und Hashes, nie Geheimnisse.
 */
export const GET = defineRoute({
  permissions: ['signature:read'],
  params: idParam,
  rateLimit: 'apiRead',
  handler: async ({ params, session }) => {
    const request = await getSignatureRequestAdmin(session, await getOrganizationId(), params.id);
    return ok(request, { headers: { 'Cache-Control': 'private, no-store' } });
  },
});
