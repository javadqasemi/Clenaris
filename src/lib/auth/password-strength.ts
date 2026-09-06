/**
 * Passwortstärke-Bewertung.
 *
 * Bewusst in einem eigenen Modul ohne Server-Abhängigkeiten: das
 * Registrierungsformular braucht die Bewertung im Browser, darf aber
 * `@node-rs/argon2` (natives Modul) nicht mitbündeln.
 *
 * Die Bewertung ist Hilfestellung, keine Sicherheitsmassnahme — die
 * verbindliche Prüfung passiert im Zod-Schema auf dem Server.
 */

export interface PasswordStrength {
  score: 0 | 1 | 2 | 3 | 4;
  label: 'sehr schwach' | 'schwach' | 'mittel' | 'stark' | 'sehr stark';
  issues: string[];
}

/** Wörter, die in einem Passwort für diese Applikation naheliegen. */
const WEAK_TERMS = [
  'password',
  'passwort',
  '12345678',
  'qwertz',
  'qwerty',
  'clenaris',
  'reinigung',
  'putzen',
  'bern',
  'schweiz',
];

export function assessPassword(password: string): PasswordStrength {
  const issues: string[] = [];
  let score = 0;

  if (password.length < 10) issues.push('Mindestens 10 Zeichen verwenden.');
  else score++;

  if (password.length >= 14) score++;

  if (!/[A-Z]/.test(password)) issues.push('Mindestens einen Grossbuchstaben verwenden.');
  else score++;

  if (!/[0-9]/.test(password)) issues.push('Mindestens eine Ziffer verwenden.');
  else score++;

  if (/[^A-Za-z0-9]/.test(password)) score++;

  const lower = password.toLowerCase();
  if (WEAK_TERMS.some((term) => lower.includes(term))) {
    issues.push('Keine leicht erratbaren Wörter verwenden.');
    score = Math.max(0, score - 2);
  }

  // Wiederholungen und einfache Folgen abwerten.
  if (/(.)\1{2,}/.test(password)) {
    issues.push('Keine Zeichen mehrfach hintereinander wiederholen.');
    score = Math.max(0, score - 1);
  }

  const clamped = Math.min(4, Math.max(0, score)) as 0 | 1 | 2 | 3 | 4;
  const labels = ['sehr schwach', 'schwach', 'mittel', 'stark', 'sehr stark'] as const;

  return { score: clamped, label: labels[clamped], issues };
}
