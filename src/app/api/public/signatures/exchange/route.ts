import { cookies } from 'next/headers';

import { definePublicRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { SIGNATURE_COOKIE, signatureCookieOptions } from '@/lib/auth/signature-session';
import { requestContext } from '@/lib/http/request-context';
import { signatureExchangeSchema } from '@/lib/validation/signatures';
import { exchangeSignatureToken } from '@/server/services/signature.service';

export const runtime = 'nodejs';

/**
 * POST /api/public/signatures/exchange — roher Token gegen Sitzung.
 *
 * **Der einzige Aufruf, der den rohen Token trägt** — im Körper, nie im
 * Pfad, nie in der Abfrage. Ein Pfad stünde in jedem Zugriffsprotokoll
 * zwischen Browser und Anwendung; ein POST-Körper nicht. Die Seite
 * `/signieren` liest den Token aus dem URL-Fragment (das kein Browser
 * mitschickt), löscht ihn sofort aus der Adresszeile und ruft hierher.
 *
 * Nichts davon wird protokolliert: Das Ereignis `LINK_EXCHANGED` nennt die
 * Token-Kennung, nie den Wert. Antwort: die nicht geheime Adresse des
 * Vorgangs; die Sitzung liegt im Cookie, beschränkt auf die Signatur-API.
 */
export const POST = definePublicRoute({
  body: signatureExchangeSchema,
  rateLimit: 'signatureExchange',
  handler: async ({ body, request }) => {
    const ergebnis = await exchangeSignatureToken(body.token, requestContext(request));

    const store = await cookies();
    store.set(SIGNATURE_COOKIE, ergebnis.sessionToken, signatureCookieOptions());

    return ok(
      { publicId: ergebnis.publicId, scope: ergebnis.scope, expiresAt: ergebnis.expiresAt },
      { headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } },
    );
  },
});
