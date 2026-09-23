import { toErrorResponse } from '@/lib/api/response';
import { serverEnv } from '@/lib/env';
import { pruefeTwilioSignatur, twilioStatus } from '@/lib/kommunikation/zustellung';
import { logger } from '@/lib/logger';
import { absoluteUrl } from '@/lib/utils';
import { meldeSmsZustellung } from '@/server/services/kommunikation.service';

const log = logger('twilio');

export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * POST /api/webhooks/twilio — Zustellmeldungen für SMS (Status-Callback).
 *
 * Signatur `X-Twilio-Signature` über die **öffentliche** Adresse dieses
 * Endpunkts (`NEXT_PUBLIC_APP_URL` + Pfad) und die Formularfelder; geprüft mit
 * `TWILIO_AUTH_TOKEN`. Ohne Token kein Empfang (503). Die interne Adresse
 * hinter einem Proxy taugt nicht — Twilio signiert, was es aufgerufen hat.
 */
export async function POST(request: Request): Promise<Response> {
  const token = serverEnv().TWILIO_AUTH_TOKEN;
  if (!token) return new Response('Zustellmeldungen sind nicht eingerichtet.', { status: 503 });

  const form = new URLSearchParams(await request.text());
  const felder: Record<string, string> = {};
  for (const [k, v] of form) felder[k] = v;
  const gueltig = pruefeTwilioSignatur({
    authToken: token,
    url: absoluteUrl('/api/webhooks/twilio'),
    felder,
    signatur: request.headers.get('x-twilio-signature'),
  });
  if (!gueltig) {
    log.warn('Twilio-Webhook mit ungültiger Signatur abgewiesen');
    return new Response('Signatur ungültig', { status: 401 });
  }

  try {
    const status = twilioStatus(felder.MessageStatus ?? '');
    if (!felder.MessageSid || !status) return new Response('ok', { status: 200 });
    await meldeSmsZustellung({
      providerId: felder.MessageSid,
      status,
      zeitpunkt: new Date(),
      fehler: felder.ErrorCode ? `Twilio-Fehler ${felder.ErrorCode}` : null,
    });
    return new Response('ok', { status: 200 });
  } catch (fehler) {
    log.error('Twilio-Webhook fehlgeschlagen', { error: fehler });
    return toErrorResponse(fehler);
  }
}
