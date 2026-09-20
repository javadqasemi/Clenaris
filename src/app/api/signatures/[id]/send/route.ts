import { defineRoute, idParam } from '@/lib/api/handler';
import { noContent } from '@/lib/api/response';
import { requestContext } from '@/lib/http/request-context';
import { getOrganizationId } from '@/server/services/organization.service';
import { sendSignatureRequest } from '@/server/services/signature.service';

export const runtime = 'nodejs';

/**
 * POST /api/signatures/:id/send — (erneut) versenden.
 *
 * Stellt je Person einen neuen Zugangstoken aus und widerruft den alten:
 * Nie zwei gültige Schlüssel zu demselben Vorgang in zwei Postfächern. Der
 * rohe Token existiert nur in der versendeten Nachricht — die Verwaltung
 * bekommt ihn nicht zu sehen und kann ihn nicht nachschlagen.
 */
export const POST = defineRoute({
  permissions: ['signature:create'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, request }) => {
    await sendSignatureRequest(session, await getOrganizationId(), params.id, requestContext(request));
    return noContent();
  },
});
