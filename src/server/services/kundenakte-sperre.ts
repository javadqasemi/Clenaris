import 'server-only';

import type { Tx } from '@/lib/db';

/**
 * Eine Kundenakte je E-Mail-Adresse — die Sperre, die das auch unter
 * Gleichzeitigkeit hält (2026-09-27).
 *
 * Fünf Wege legen eine Akte an: das Büro (`createCustomer`), die Umwandlung
 * einer Anfrage (`convertLeadToCustomer`), die Gastbuchung
 * (`gastkundschaftAnlegen`), die Registrierung (`auth.service`) und das
 * Profil (`profile.service`). Alle folgen demselben Muster „nach der
 * Adresse suchen, sonst anlegen" — und unter READ COMMITTED lesen zwei
 * gleichzeitige Aufrufe beide „keine Akte" und legen beide eine an. Die
 * Nebenläufigkeitsprüfung fand fünf Akten für fünf gleichzeitige Anlagen
 * derselben Adresse.
 *
 * Warum keine eindeutige Datenbankbedingung auf `(organizationId, email)`:
 * Gelöschte Akten (`deletedAt`) behalten ihre Adresse, und im Bestand gibt
 * es Dubletten aus der Zeit vor dieser Regel. Ein Teilindex `WHERE
 * deleted_at IS NULL` verlangte zuerst eine Bereinigung des Bestands, die
 * niemand ungeprüft ausführen soll. Die Sperre schützt ab sofort jede neue
 * Anlage, ohne Bestandsdaten anzufassen; der Teilindex bleibt als offener
 * Punkt in `docs/MANDANTEN.md`.
 *
 * **Jeder** Anlageweg nimmt sie, vor seiner Suche und in seiner Transaktion.
 * Eine Sperre, die nur ein Teil der Wege nimmt, schützt nichts. Schlüssel:
 * Organisation und Adresse in Kleinschrift — `Anna@…` und `anna@…` sind
 * dieselbe Person.
 */
export async function kundenakteSperren(tx: Tx, organizationId: string, email: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`kundenakte:${organizationId}:${email.trim().toLowerCase()}`}))`;
}
