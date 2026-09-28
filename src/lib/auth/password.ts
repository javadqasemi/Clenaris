import { hash, verify } from '@node-rs/argon2';

import { BusinessRuleError } from '@/lib/errors';

import { MELDUNG_OEFFENTLICHES_PASSWORT, passwortHierGesperrt } from './oeffentliche-zugangsdaten';

/**
 * Passwort-Hashing mit Argon2id.
 *
 * Architekturentscheid: Argon2id statt bcrypt — speicherhart, damit GPU-Angriffe
 * teuer bleiben. Parameter nach OWASP-Empfehlung 2024 (19 MiB, 2 Iterationen,
 * 1 Thread), was auf Vercel-Lambdas rund 50–80 ms kostet.
 */

const OPTIONS = {
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * Hier und nicht in jedem Dienst einzeln wird das veröffentlichte Passwort
 * abgewiesen (Notfallauftrag 2026-09-27, `oeffentliche-zugangsdaten.ts`).
 *
 * Jeder Weg, auf dem ein Konto ein Passwort bekommt — Registrierung,
 * Zurücksetzen, Wechsel, Einladung —, endet in dieser Funktion. Eine Prüfung
 * in den Diensten hätte vier Stellen, und der fünfte Weg, den jemand später
 * baut, hätte keine. Die Prüfung im Zod-Schema wäre ebenso falsch: Sie
 * entscheidet ohne Kenntnis der Umgebung, und die Prüfreihe setzt die
 * Demopasswörter gegen ihre Wegwerf-Datenbank bewusst wieder.
 *
 * Wiederherstellungs- und Einmalcodes laufen ebenfalls hier durch; sie sind
 * zufällig erzeugt und treffen die Liste nie.
 */
export async function hashPassword(plain: string): Promise<string> {
  if (passwortHierGesperrt(plain)) {
    throw new BusinessRuleError(MELDUNG_OEFFENTLICHES_PASSWORT, [
      { field: 'password', message: MELDUNG_OEFFENTLICHES_PASSWORT, code: 'custom' },
    ]);
  }
  return hash(plain, OPTIONS);
}

export async function verifyPassword(hashValue: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashValue, plain);
  } catch {
    return false;
  }
}

// Die Stärkebewertung lebt in einem client-tauglichen Modul, damit das
// Registrierungsformular sie nutzen kann, ohne das native Argon2-Modul
// mitzubündeln.
export { assessPassword, type PasswordStrength } from './password-strength';
