import { cookies } from 'next/headers';

import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { SIGNATURE_COOKIE, signatureCookieOptions } from '@/lib/auth/signature-session';
import { ForbiddenError } from '@/lib/errors';
import { requestContext } from '@/lib/http/request-context';
import { respondQuoteSchema } from '@/lib/validation/operations';
import { getOrganizationId } from '@/server/services/organization.service';
import { respondToQuoteAsCustomer } from '@/server/services/quote.service';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/quotes/:id/respond
 *
 * Annahme oder Ablehnung aus dem angemeldeten Kundenbereich.
 *
 * **Warum es diese Route neben der öffentlichen gibt.** Wer angemeldet ist
 * und die Offerte besitzt, braucht keinen Capability-Link. Ihn dafür
 * auszustellen hiesse, ein Geheimnis zu erzeugen, das niemand braucht, und
 * es durch eine Adresszeile zu schicken.
 *
 * **Seit Gate 4C.** `REJECT` bleibt die direkte Entscheidung. `ACCEPT`
 * startet den Unterzeichnungsvorgang und setzt — nach Sitzung und
 * Eigentümerschaft — direkt das an den Teilnehmer gebundene Signatur-Cookie
 * (Pfad `/api/public/signatures`); die Antwort nennt die nicht geheime
 * Adresse `/signieren/s/<publicId>`. Kein Link per E-Mail an sich selbst,
 * kein roher Token im Körper. Das Protokoll hält den Zugangsweg
 * `AUTHENTICATED_CUSTOMER` fest — ohne Anspruch auf höhere
 * Identitätssicherheit als beim Link.
 */
export const POST = defineRoute({
  permissions: ['quote:respond_own'],
  params: idParam,
  body: respondQuoteSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, request }) => {
    if (!session.profileId) {
      throw new ForbiddenError('Dieses Konto ist keiner Kundschaft zugeordnet.');
    }

    const antwort = await respondToQuoteAsCustomer({
      quoteId: params.id,
      organizationId: await getOrganizationId(),
      customerId: session.profileId,
      userId: session.id,
      input: body,
      ctx: requestContext(request),
    });

    if (antwort.kind === 'DECLINED') {
      return ok({ status: antwort.status, rejectedAt: antwort.rejectedAt, requiresSignature: false }, { headers: { 'Cache-Control': 'no-store' } });
    }

    const store = await cookies();
    store.set(SIGNATURE_COOKIE, antwort.sessionToken!, signatureCookieOptions());
    return ok(
      { requiresSignature: true, signatureUrl: `/signieren/s/${antwort.publicId}`, signatureExpiresAt: antwort.expiresAt },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  },
});
