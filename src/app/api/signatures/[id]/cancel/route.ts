import { defineRoute, idParam } from '@/lib/api/handler';
import { noContent } from '@/lib/api/response';
import { requestContext } from '@/lib/http/request-context';
import { signatureCancelSchema } from '@/lib/validation/signatures';
import { getOrganizationId } from '@/server/services/organization.service';
import { cancelSignatureRequest } from '@/server/services/signature.service';

export const runtime = 'nodejs';

/**
 * POST /api/signatures/:id/cancel — einen offenen Vorgang abbrechen.
 *
 * Widerruft die Zugangstokens (damit jede bestehende Sitzung wertlos ist),
 * entwertet offene Codes, setzt CANCELLED. Ein abgeschlossener Vorgang
 * lässt sich nicht abbrechen — Beweise werden nicht vernichtet.
 */
export const POST = defineRoute({
  permissions: ['signature:cancel'],
  params: idParam,
  body: signatureCancelSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, request }) => {
    await cancelSignatureRequest(session, await getOrganizationId(), params.id, body.reason, requestContext(request));
    return noContent();
  },
});
