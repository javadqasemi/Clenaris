import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Zeitbasierte Einmalkennwörter (TOTP) nach RFC 6238.
 *
 * **Warum selbst gerechnet und keine Bibliothek.** Der Algorithmus sind rund
 * vierzig Zeilen über `crypto.createHmac` und hat sich seit 2011 nicht
 * geändert. Eine Abhängigkeit dafür wäre Code im Anmeldepfad, den niemand hier
 * gelesen hat — bei einem Sicherheitsbauteil ist das der schlechtere Handel.
 * Der Umfang ist überschaubar genug, um ihn zu prüfen, und der Standard ist
 * öffentlich.
 *
 * Kompatibel mit Google Authenticator, Microsoft Authenticator, 1Password,
 * Bitwarden und Aegis: SHA-1, sechs Stellen, dreissig Sekunden Schritt. Diese
 * Werte sind nicht willkürlich — sie sind das, was die Programme ohne
 * Zusatzangaben annehmen. Wer SHA-256 wählt, sperrt die Hälfte der Nutzenden
 * aus, ohne dass jemand versteht warum.
 */

const DIGITS = 6;
const STEP_SECONDS = 30;

/**
 * Wie viele Schritte vor und nach dem aktuellen akzeptiert werden.
 *
 * Einer in jede Richtung: das deckt eine Uhrenabweichung von einer halben
 * Minute ab und den Fall, dass jemand den Code kurz vor dem Wechsel abliest
 * und kurz danach abschickt. Mehr würde das Zeitfenster für einen
 * abgefangenen Code unnötig verlängern.
 */
const WINDOW = 1;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Base32 nach RFC 4648, ohne Auffüllzeichen.
 *
 * Authenticator-Programme erwarten das Geheimnis in dieser Form — sie ist
 * ohne Gross-/Kleinschreibung eindeutig und lässt sich abtippen, wenn die
 * Kamera streikt.
 */
export function toBase32(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];

  return output;
}

export function fromBase32(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

/**
 * Neues Geheimnis.
 *
 * 20 Byte = 160 Bit, wie in RFC 4226 für HMAC-SHA1 empfohlen. Kürzer wäre
 * ratbar, länger bringt bei SHA-1 nichts.
 */
export function generateSecret(): string {
  return toBase32(randomBytes(20));
}

/** Ein Einmalkennwort für einen bestimmten Zeitschritt. */
function hotp(secret: Buffer, counter: number): string {
  // Der Zähler ist ein 8-Byte-Wert in Netzwerkreihenfolge.
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac('sha1', secret).update(buffer).digest();

  // Dynamische Kürzung nach RFC 4226 §5.4: die letzten vier Bit des Digests
  // zeigen auf die Stelle, an der die vier Ergebnisbytes beginnen.
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];

  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** Das aktuell gültige Kennwort — nur für Tests und die Einrichtungsvorschau. */
export function generateToken(base32Secret: string, at: Date = new Date()): string {
  const counter = Math.floor(at.getTime() / 1000 / STEP_SECONDS);
  return hotp(fromBase32(base32Secret), counter);
}

/**
 * Prüft ein eingegebenes Kennwort.
 *
 * Der Vergleich läuft über `timingSafeEqual`: ein zeichenweiser Vergleich
 * würde über die Antwortzeit verraten, wie viele Stellen stimmen. Bei sechs
 * Ziffern ist das keine theoretische Sorge — es reduziert den Suchraum von
 * einer Million auf sechzig Versuche.
 */
export function verifyToken(base32Secret: string, token: string, at: Date = new Date()): boolean {
  const clean = token.replace(/\D/g, '');
  if (clean.length !== DIGITS) return false;

  const secret = fromBase32(base32Secret);
  if (secret.length === 0) return false;

  const current = Math.floor(at.getTime() / 1000 / STEP_SECONDS);
  const candidate = Buffer.from(clean);

  let valid = false;
  for (let offset = -WINDOW; offset <= WINDOW; offset++) {
    const expected = Buffer.from(hotp(secret, current + offset));
    // Bewusst ohne vorzeitigen Abbruch: die Schleife läuft immer vollständig,
    // damit die Laufzeit nicht verrät, *welcher* Zeitschritt gepasst hat.
    if (expected.length === candidate.length && timingSafeEqual(expected, candidate)) {
      valid = true;
    }
  }
  return valid;
}

/**
 * Adresse für den QR-Code.
 *
 * `issuer` erscheint im Authenticator als Kontoname. Er steht zweimal darin —
 * als Pfadpräfix und als Parameter: ältere Programme lesen nur das eine,
 * neuere nur das andere.
 */
export function otpauthUrl(params: { secret: string; account: string; issuer: string }): string {
  const label = encodeURIComponent(`${params.issuer}:${params.account}`);
  const query = new URLSearchParams({
    secret: params.secret,
    issuer: params.issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

/**
 * Wiederherstellungscodes.
 *
 * Zehn Stück, je zehn Zeichen aus einem Alphabet ohne verwechselbare Zeichen
 * (kein 0/O, kein 1/I/l). Sie werden auf Papier notiert oder in einen
 * Passwortspeicher kopiert — dort zählt Abtippbarkeit mehr als Kürze.
 *
 * Sie sind der einzige Weg zurück, wenn das Telefon verloren geht. Ohne sie
 * bliebe nur ein Eingriff in die Datenbank, und genau das soll ein zweiter
 * Faktor nicht nötig machen.
 */
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const bytes = randomBytes(10);
    const code = Array.from(bytes, (b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join('');
    return `${code.slice(0, 5)}-${code.slice(5)}`;
  });
}

/** Vergleich eines Wiederherstellungscodes, unabhängig von Schreibweise. */
export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}
