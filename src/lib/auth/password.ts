import { hash, verify } from '@node-rs/argon2';

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

export async function hashPassword(plain: string): Promise<string> {
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
