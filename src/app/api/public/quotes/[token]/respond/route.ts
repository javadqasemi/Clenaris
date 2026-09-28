import { definePublicRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { respondQuoteSchema } from '@/lib/validation/operations';
import { publicTokenParams } from '@/lib/validation/queries';
import { sha256Hex } from '@/lib/crypto';
import { requestContext } from '@/lib/http/request-context';
import { respondToQuote } from '@/server/services/quote.service';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/public/quotes/:token/respond
 *
 * Annahme oder Ablehnung über den öffentlichen Link — ohne Anmeldung.
 *
 * **Seit Gate 4C zwei Antworten.** `REJECT` entscheidet sofort und
 * endgültig. `ACCEPT` entscheidet **nicht**: Es legt den Unterzeichnungs-
 * vorgang an (unveränderlicher Snapshot der Offerte, Hash A) und antwortet
 * mit `requiresSignature: true` und der Adresse `/signieren#t=<Token>`.
 * Erst der Abschluss des Vorgangs — Zustimmung, Unterschrift, Prüfsummen,
 * Protokoll — setzt die Offerte auf ACCEPTED.
 *
 * Der rohe `SIGNATURE_ACCESS`-Token steht damit genau einmal in einer
 * JSON-Antwort und danach nur im Fragment der Adresse, das der Browser nie
 * mitschickt. Er wird nicht protokolliert und nicht gespeichert. Wer den
 * Vorgang bereits begonnen hat, bekommt hier einen weiteren Zugang zum
 * selben Vorgang („Unterzeichnung fortsetzen"), keinen zweiten Vorgang.
 *
 * Das Kontingent ist `publicTokenAction`, gezählt je Link (Hash, nie der
 * Token selbst): Eine Offerte beantwortet man einmal, nicht neunzigmal
 * pro Minute.
 */
export const POST = definePublicRoute({
  params: publicTokenParams,
  body: respondQuoteSchema,
  rateLimit: 'publicTokenAction',
  rateLimitKey: ({ request }) =>
    sha256Hex(request.nextUrl.pathname.split('/').at(-2) ?? 'unbekannt'),
  handler: async ({ params, body, request }) => {
    const antwort = await respondToQuote({ token: params.token, input: body, ctx: requestContext(request) });

    if (antwort.kind === 'DECLINED') {
      return ok({ status: antwort.status, rejectedAt: antwort.rejectedAt, requiresSignature: false }, { headers: { 'Cache-Control': 'no-store' } });
    }
    return ok(
      {
        requiresSignature: true,
        signatureUrl: `/signieren#t=${antwort.raw}`,
        signatureExpiresAt: antwort.expiresAt,
      },
      { headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } },
    );
  },
});
