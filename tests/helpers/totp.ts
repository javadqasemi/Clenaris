import { createHmac } from 'node:crypto';

/**
 * TOTP nach RFC 6238 — **bewusst eine zweite Implementierung**.
 *
 * Die naheliegende Lösung wäre, `src/lib/auth/totp.ts` zu importieren. Dann
 * prüfte der Test aber dieselbe Funktion mit sich selbst: Ein Fehler im
 * Zählerformat, in der Byte-Reihenfolge oder im base32-Alphabet käme in beiden
 * Richtungen gleich heraus, und der Test wäre damit einverstanden.
 *
 * Diese fünfzehn Zeilen sind unabhängig aus dem RFC gebaut. Stimmen beide
 * überein, stimmt das Format wirklich — und jede Authenticator-App auf der
 * Welt kommt damit zurecht.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32ToBytes(input: string): Buffer {
  const clean = input.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];

  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error(`Kein base32-Zeichen: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(out);
}

export function totp(secret: string, when: number = Date.now(), stepSeconds = 30): string {
  const counter = Math.floor(when / 1000 / stepSeconds);

  const message = Buffer.alloc(8);
  message.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  message.writeUInt32BE(counter >>> 0, 4);

  const mac = createHmac('sha1', base32ToBytes(secret)).update(message).digest();

  // Dynamic Truncation, RFC 4226 §5.3.
  const offset = mac[mac.length - 1] & 0x0f;
  const code =
    ((mac[offset] & 0x7f) << 24) |
    (mac[offset + 1] << 16) |
    (mac[offset + 2] << 8) |
    mac[offset + 3];

  return String(code % 1_000_000).padStart(6, '0');
}

/** Die Nutzlast eines JWT lesen — ohne Signaturprüfung, nur zum Hineinschauen. */
export function decodeJwt(token: string): Record<string, unknown> {
  const part = token.split('.')[1];
  if (!part) throw new Error('Kein JWT.');
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

/** Einen einzelnen Cookie-Wert aus einem `cookie`-Kopf ziehen. */
export function cookieValue(jar: string, name: string): string | undefined {
  return jar
    .split('; ')
    .find((entry) => entry.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
