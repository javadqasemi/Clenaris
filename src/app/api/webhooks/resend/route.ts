import { toErrorResponse } from '@/lib/api/response';
import { serverEnv } from '@/lib/env';
import { pruefeSvixSignatur, resendEreignis } from '@/lib/kommunikation/zustellung';
import { logger } from '@/lib/logger';
import { meldeEmailZustellung } from '@/server/services/kommunikation.service';

const log = logger('resend');

export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * POST /api/webhooks/resend — Zustellmeldungen für E-Mails (Wave 14).
 *
 *  1. **Ohne Geheimnis kein Empfang (503).** Eine ungeprüfte Meldung könnte
 *     jede Nachricht als zugestellt oder abgeprallt markieren.
 *  2. **Signatur gegen den Rohtext** (Svix: `svix-id`, `svix-timestamp`,
 *     `svix-signature`), Zeitstempel höchstens fünf Minuten alt — eine
 *     aufgezeichnete Meldung lässt sich nicht später wieder einspielen.
 *  3. **Unbekannte Kennung: 200.** Die Nachricht stammt vielleicht aus einer
 *     anderen Umgebung; eine Wiederholung durch den Anbieter änderte daran
 *     nichts.
 *  4. **Fehler beim Verarbeiten: 500**, damit der Anbieter erneut zustellt.
 */
export async function POST(request: Request): Promise<Response> {
  const geheimnis = serverEnv().RESEND_WEBHOOK_SECRET;
  if (!geheimnis) return new Response('Zustellmeldungen sind nicht eingerichtet.', { status: 503 });

  const rohtext = await request.text();
  const gueltig = pruefeSvixSignatur({
    geheimnis,
    id: request.headers.get('svix-id'),
    zeitstempel: request.headers.get('svix-timestamp'),
    signaturen: request.headers.get('svix-signature'),
    rohtext,
  });
  if (!gueltig) {
    log.warn('Resend-Webhook mit ungültiger Signatur abgewiesen');
    return new Response('Signatur ungültig', { status: 401 });
  }

  try {
    const meldung = JSON.parse(rohtext) as { type?: string; created_at?: string; data?: { email_id?: string; bounce?: { message?: string } } };
    const providerId = meldung.data?.email_id;
    if (!meldung.type || !providerId) return new Response('ok', { status: 200 });
    const zeitpunkt = meldung.created_at ? new Date(meldung.created_at) : new Date();
    const ergebnis = await meldeEmailZustellung({
      providerId,
      ereignis: resendEreignis(meldung.type),
      zeitpunkt: Number.isNaN(zeitpunkt.getTime()) ? new Date() : zeitpunkt,
      fehler: meldung.data?.bounce?.message ?? null,
    });
    return Response.json({ gefunden: ergebnis.gefunden, geaendert: ergebnis.geaendert });
  } catch (fehler) {
    log.error('Resend-Webhook fehlgeschlagen', { error: fehler });
    return toErrorResponse(fehler);
  }
}
