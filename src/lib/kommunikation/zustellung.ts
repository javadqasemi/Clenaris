import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Zustellstatus von E-Mail und SMS (Wave 14, 2026-09-23) — reine Regeln,
 * ohne Datenbank, direkt prüfbar (`tests/api/kommunikation.test.ts`).
 *
 * ---------------------------------------------------------------------------
 *  Warum eine Rangfolge
 * ---------------------------------------------------------------------------
 *
 * Anbieter melden Ereignisse ohne garantierte Reihenfolge: „zugestellt" kann
 * vor „gesendet" eintreffen, und derselbe Webhook kann doppelt kommen. Wer
 * jede Meldung blind übernimmt, lässt eine zugestellte Nachricht wieder als
 * „gesendet" dastehen. Deshalb bewegt sich der Status nur vorwärts — mit
 * einer Ausnahme: Ein Abprall oder eine Spam-Meldung kommt oft **nach** der
 * Zustellung und muss sie überschreiben dürfen; sie ist die schlechtere, aber
 * die wahrere Nachricht.
 */

export type Zustellstatus =
  | 'queued'
  | 'simulated'
  | 'sent'
  | 'delivery_delayed'
  | 'delivered'
  | 'bounced'
  | 'complained'
  | 'undelivered'
  | 'failed';

const RANG: Record<Zustellstatus, number> = {
  queued: 0,
  simulated: 0,
  sent: 1,
  delivery_delayed: 2,
  delivered: 3,
  // Endzustände mit schlechter Nachricht — überschreiben alles davor.
  bounced: 9,
  complained: 9,
  undelivered: 9,
  failed: 9,
};

export const STATUS_BESCHRIFTUNG: Record<Zustellstatus, string> = {
  queued: 'Wartend',
  simulated: 'Simuliert (kein Anbieter)',
  sent: 'Übergeben',
  delivery_delayed: 'Verzögert',
  delivered: 'Zugestellt',
  bounced: 'Abgeprallt',
  complained: 'Als Spam gemeldet',
  undelivered: 'Nicht zugestellt',
  failed: 'Fehlgeschlagen',
};

export function istZustellstatus(s: string): s is Zustellstatus {
  return s in RANG;
}

/** Der neue Status — oder `null`, wenn die Meldung den gespeicherten Stand nicht verbessert. */
export function naechsterStatus(alt: string, neu: Zustellstatus): Zustellstatus | null {
  const altRang = istZustellstatus(alt) ? RANG[alt] : 0;
  if (RANG[neu] === 9) return alt === neu ? null : neu;
  if (altRang === 9) return null;
  return RANG[neu] > altRang ? neu : null;
}

// ---------------------------------------------------------------------------
//  Resend (Svix-Webhooks)
// ---------------------------------------------------------------------------

export type ResendEreignis = { status?: Zustellstatus; geoeffnet?: boolean; geklickt?: boolean };

/** Resend-Ereignistyp → Wirkung auf das Protokoll. Unbekannte Typen: keine. */
export function resendEreignis(typ: string): ResendEreignis {
  switch (typ) {
    case 'email.sent':
      return { status: 'sent' };
    case 'email.delivered':
      return { status: 'delivered' };
    case 'email.delivery_delayed':
      return { status: 'delivery_delayed' };
    case 'email.bounced':
      return { status: 'bounced' };
    case 'email.complained':
      return { status: 'complained' };
    case 'email.failed':
      return { status: 'failed' };
    case 'email.opened':
      return { geoeffnet: true };
    case 'email.clicked':
      return { geklickt: true };
    default:
      return {};
  }
}

/**
 * Svix-Signatur prüfen: `v1,<base64(HMAC-SHA256(secret, id.timestamp.body))>`,
 * Zeitstempel höchstens fünf Minuten alt (Wiederholungsschutz). Das Geheimnis
 * hat die Form `whsec_<base64>`. Mehrere Signaturen im Kopf (Schlüsselwechsel)
 * werden alle geprüft.
 */
export function pruefeSvixSignatur(params: {
  geheimnis: string;
  id: string | null;
  zeitstempel: string | null;
  signaturen: string | null;
  rohtext: string;
  jetzt?: number;
}): boolean {
  if (!params.id || !params.zeitstempel || !params.signaturen) return false;
  const sekunden = Number(params.zeitstempel);
  if (!Number.isFinite(sekunden)) return false;
  const jetzt = Math.floor((params.jetzt ?? Date.now()) / 1000);
  if (Math.abs(jetzt - sekunden) > 300) return false;
  const schluessel = Buffer.from(params.geheimnis.replace(/^whsec_/, ''), 'base64');
  const erwartet = createHmac('sha256', schluessel).update(`${params.id}.${params.zeitstempel}.${params.rohtext}`).digest();
  return params.signaturen
    .split(' ')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('v1,'))
    .some((s) => {
      const gegeben = Buffer.from(s.slice(3), 'base64');
      return gegeben.length === erwartet.length && timingSafeEqual(gegeben, erwartet);
    });
}

/** Für Prüfungen und lokale Werkzeuge: eine gültige Svix-Signatur erzeugen. */
export function svixSignatur(geheimnis: string, id: string, zeitstempel: string, rohtext: string): string {
  const schluessel = Buffer.from(geheimnis.replace(/^whsec_/, ''), 'base64');
  return `v1,${createHmac('sha256', schluessel).update(`${id}.${zeitstempel}.${rohtext}`).digest('base64')}`;
}

// ---------------------------------------------------------------------------
//  Twilio
// ---------------------------------------------------------------------------

/** Twilio-`MessageStatus` → Zustellstatus. Zwischenstände ohne Aussage: keiner. */
export function twilioStatus(status: string): Zustellstatus | undefined {
  switch (status) {
    case 'sent':
      return 'sent';
    case 'delivered':
      return 'delivered';
    case 'undelivered':
      return 'undelivered';
    case 'failed':
      return 'failed';
    default:
      return undefined;
  }
}

/**
 * Twilio-Signatur: `base64(HMAC-SHA1(authToken, url + sortierte key+value))`.
 * Die URL muss genau die sein, die bei Twilio hinterlegt ist — hinter einem
 * Proxy also die öffentliche, nicht die interne.
 */
export function pruefeTwilioSignatur(params: {
  authToken: string;
  url: string;
  felder: Record<string, string>;
  signatur: string | null;
}): boolean {
  if (!params.signatur) return false;
  const daten = params.url + Object.keys(params.felder).sort().map((k) => k + params.felder[k]).join('');
  const erwartet = createHmac('sha1', params.authToken).update(daten).digest();
  const gegeben = Buffer.from(params.signatur, 'base64');
  return gegeben.length === erwartet.length && timingSafeEqual(gegeben, erwartet);
}
