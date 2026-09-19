import { definePublicRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { respondQuoteSchema } from '@/lib/validation/operations';
import { publicTokenParams } from '@/lib/validation/queries';
import { sha256Hex } from '@/lib/crypto';
import { respondToQuote } from '@/server/services/quote.service';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/public/quotes/:token/respond
 *
 * Annahme oder Ablehnung über den öffentlichen Link — ohne Anmeldung.
 *
 * **Korrektur einer früheren Zusage an dieser Stelle.** Hier stand: „Der
 * Token ist das Berechtigungsmerkmal: er ist unerratbar (cuid)". Das war
 * falsch. cuid v1 ist eine kollisionsarme Kennung aus Zeitstempel, Zähler,
 * Maschinenkennung und einem kurzen Zufallsblock — kein Geheimnis. Nachgemessen
 * teilten sich die Tokens der Testdatenbank einen festen Präfix.
 *
 * Aufgelöst wird der Link jetzt über `access-token.service.ts`: 32
 * Zufallsbytes, in der Datenbank nur der SHA-256-Hash, mit Ablauf, Widerruf
 * sowie Zweck- und Ressourcenbindung. Alte cuid-Links funktionieren während
 * des Übergangs weiter und lassen sich mit `LEGACY_PUBLIC_TOKENS=aus`
 * abschalten.
 *
 * Das Kontingent ist `publicTokenAction` statt `apiWrite`: Eine Offerte
 * beantwortet man einmal, nicht neunzigmal pro Minute. Die Einmaligkeit
 * selbst kommt aus dem atomaren Statusübergang im Dienst, nicht aus dem
 * Token — der Link darf die beantwortete Offerte weiter zeigen.
 */
export const POST = definePublicRoute({
  params: publicTokenParams,
  body: respondQuoteSchema,
  rateLimit: 'publicTokenAction',
  /**
   * Gezählt wird je Link, nicht je Absender.
   *
   * Die Kosten einer Annahme — PDF neu rendern, zwei Nachrichten
   * verschicken — hängen an der Offerte, nicht an der IP. Wer eine einzelne
   * Offerte hämmern will, wechselt ohnehin die Adresse; wer hinter einem
   * Firmenausgang sitzt, soll dafür nicht büssen.
   *
   * Gezählt wird der Hash und nicht der Token selbst: Der Schlüssel landet
   * in Redis, und dort hat ein Geheimnis im Klartext nichts verloren.
   */
  rateLimitKey: ({ request }) =>
    sha256Hex(request.nextUrl.pathname.split('/').at(-2) ?? 'unbekannt'),
  handler: async ({ params, body, ip }) => {
    const quote = await respondToQuote({ token: params.token, input: body, ip });

    return ok({
      status: quote.status,
      acceptedAt: quote.acceptedAt,
      rejectedAt: quote.rejectedAt,
    });
  },
});
