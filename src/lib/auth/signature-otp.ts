import 'server-only';

import { createHmac, randomInt } from 'node:crypto';

import { hashPassword, verifyPassword } from '@/lib/auth/password';
import { deriveSecret } from '@/lib/crypto';

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

function geschuetzt(challengeId: string, code: string): string {
  return createHmac('sha256', deriveSecret('clenaris-signature-otp-v1'))
    .update(`${challengeId}:${code}`)
    .digest('hex');
}

export async function hashOtpCode(challengeId: string, code: string): Promise<string> {
  return hashPassword(geschuetzt(challengeId, code));
}

export async function verifyOtpCode(
  codeHash: string,
  challengeId: string,
  code: string,
): Promise<boolean> {
  if (!/^\d{6}$/.test(code)) return false;
  return verifyPassword(codeHash, geschuetzt(challengeId, code));
}
