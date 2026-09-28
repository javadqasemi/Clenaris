import 'server-only';

import { createHmac, randomInt } from 'node:crypto';

import { hashPassword, verifyPassword } from '@/lib/auth/password';
import { deriveSecret, deriveSecretAll } from '@/lib/crypto';

/**
 * Bestätigungscodes für die elektronische Unterzeichnung.
 *
 * **Warum nicht `PublicAccessToken`.** Der speichert SHA-256 über 256 Bit
 * Zufall — für einen Link richtig, für sechs Ziffern falsch: eine Million
 * Möglichkeiten sind aus einem Datenbankabzug in Sekunden durchprobiert.
 *
 * **Warum zwei Schichten.** Erst ein HMAC mit einem zweckgebundenen Schlüssel
 * (`deriveSecret`, Kontext `clenaris-signature-otp-v1`): Wer nur die
 * Datenbank hat, kann ohne den Serverschlüssel keinen einzigen Kandidaten
 * prüfen. Dann Argon2id über das HMAC-Ergebnis: Wer Datenbank *und*
 * Schlüssel hat, braucht je Code rund eine Million speicherharte Läufe —
 * bei zehn Minuten Gültigkeit ist das wertlos. Beides mit vorhandener
 * Infrastruktur; kein neues Geheimnis.
 *
 * Der Code selbst kommt aus dem CSPRNG (`randomInt`), nicht aus `Math.random`.
 * Die Challenge-Kennung geht in den HMAC, damit derselbe Code für zwei
 * Challenges zwei verschiedene Hashes ergibt.
 */

export const OTP_DIGITS = 6;
export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_MS = 60 * 1000;

export function generateOtpCode(): string {
  return String(randomInt(0, 10 ** OTP_DIGITS)).padStart(OTP_DIGITS, '0');
}

const OTP_KONTEXT = 'clenaris-signature-otp-v1';

function geschuetztMit(schluessel: Buffer, challengeId: string, code: string): string {
  return createHmac('sha256', schluessel).update(`${challengeId}:${code}`).digest('hex');
}

export async function hashOtpCode(challengeId: string, code: string): Promise<string> {
  // Geschrieben wird immer mit dem aktiven Schlüssel — nie mit einem alten.
  return hashPassword(geschuetztMit(deriveSecret(OTP_KONTEXT), challengeId, code));
}

/**
 * Prüfen — unter jedem Schlüssel des Bundes, aktiver zuerst.
 *
 * **Warum nicht nur unter dem aktiven.** Der Hash in der Datenbank ist mit dem
 * Schlüssel entstanden, der zum Zeitpunkt des Versands aktiv war. Wird
 * dazwischen rotiert, passt er nicht mehr — und die Person, die gerade
 * unterzeichnet und den Code per SMS bekommen hat, sähe „Der Code stimmt
 * nicht", ohne jeden Hinweis auf den Grund.
 *
 * Der Code lebt zehn Minuten; das Fenster ist also klein. Klein ist aber kein
 * Trost für den, der hineinfällt, und die Kosten sind gering: Im Normalbetrieb
 * hat der Bund genau einen Eintrag, und die Schleife endet beim ersten
 * Treffer. Während einer Rotation sind es zwei Argon2-Läufe statt einem — für
 * die Dauer der Rotation, bei einer Handvoll offener Codes.
 *
 * Der Reihenfolge wegen: Der aktive Schlüssel steht vorn, also kostet der
 * Normalfall unverändert einen Lauf.
 */
export async function verifyOtpCode(
  codeHash: string,
  challengeId: string,
  code: string,
): Promise<boolean> {
  if (!/^\d{6}$/.test(code)) return false;

  for (const schluessel of deriveSecretAll(OTP_KONTEXT)) {
    if (await verifyPassword(codeHash, geschuetztMit(schluessel, challengeId, code))) {
      return true;
    }
  }
  return false;
}
