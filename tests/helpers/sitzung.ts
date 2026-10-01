import 'dotenv/config';

import { createHash } from 'node:crypto';

/**
 * Das Leerlauffenster der Sitzung, wie es der Prüfserver sieht — eine Quelle
 * für beide Seiten der Prüfung: den Server (`tests/api/sitzung-leerlauf.test.ts`)
 * und den Browser (`tests/e2e/sitzung-leerlauf.spec.ts`).
 *
 * ---------------------------------------------------------------------------
 *  Warum die Werte aus der Umgebung kommen und nicht als Zahl dastehen
 * ---------------------------------------------------------------------------
 *
 * `refreshSession` und der Aktivitätswächter lesen `SESSION_IDLE_TTL` und
 * `SESSION_REMEMBER_IDLE_TTL` aus der Umgebung des Servers; ohne Angabe
 * gelten die Vorgaben aus `src/lib/env.ts` (15 Minuten, sieben Tage). Stünde
 * hier fest 900, liefe die Reihe auf einer Maschine mit längerem Fenster in
 * eine 200, wo sie 401 erwartet — und man suchte den Fehler im Dienst statt
 * in der Prüfung. `scripts/test-server.ts` übersteuert beide Werte nicht; der
 * Server liest also dieselbe `.env` wie dieser Prozess.
 *
 * `dotenv/config` steht deshalb **hier** und nicht nur mittelbar über den
 * Prisma-Klienten in `testdb.ts`: Ob jene Datei vor dieser geladen wird, hängt
 * von der Reihenfolge der Importe im Aufrufer ab. Eine Prüfung, deren
 * Erwartung davon abhängt, in welcher Zeile ein Import steht, bricht beim
 * nächsten Sortieren der Importe — still, weil dann die Vorgaben gälten.
 * `dotenv` überschreibt keine bereits gesetzte Variable; was der Aufrufer
 * ausdrücklich setzt, gewinnt.
 */
function sekundenAusUmgebung(name: string, vorgabe: number): number {
  const wert = Number(process.env[name]?.trim() || vorgabe);
  return Number.isFinite(wert) && wert > 0 ? wert : vorgabe;
}

/** Leerlauffenster ohne „Angemeldet bleiben", in Sekunden. */
export const LEERLAUF_S = sekundenAusUmgebung('SESSION_IDLE_TTL', 900);

/** Leerlauffenster mit „Angemeldet bleiben", in Sekunden. */
export const LEERLAUF_DAUERHAFT_S = sekundenAusUmgebung('SESSION_REMEMBER_IDLE_TTL', 604_800);

/**
 * Der Schlüssel, unter dem die Datenbank einen Erneuerungstoken kennt:
 * SHA-256 des rohen Cookiewerts, hexadezimal — dieselbe Rechnung wie
 * `hashToken` in `src/lib/auth/jwt.ts`. Der Rohwert selbst steht nie in der
 * Datenbank, und keine Prüfmeldung gibt ihn aus.
 */
export function tokenHash(roh: string): string {
  return createHash('sha256').update(roh).digest('hex');
}
