import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signatur der Anfragen des Release-Ausführers (2026-09-27).
 *
 * Eine Datei für beide Seiten: die Anwendung prüft damit
 * (`/api/cron/release-auftraege`), der Ausführer signiert damit
 * (`scripts/release-ausfuehrer.ts`). Zwei Umsetzungen derselben Regel liefen
 * beim ersten Tippfehler auseinander, und der Fehler zeigte sich erst am
 * Tag der Installation.
 *
 * **Was signiert wird.** `v1\n<METHODE>\n<Pfad mit Abfrage>\n<Zeit>\n<SHA-256
 * des Rohrumpfs>`. Methode und Pfad, damit eine Signatur für „Aufträge
 * lesen" nicht als „Auftrag übernehmen" gilt; die Zeit, damit eine
 * mitgeschnittene Anfrage nach fünf Minuten wertlos ist; der Rumpf als
 * Prüfsumme über die **Rohbytes**, nicht über geparstes JSON — ein anderer
 * Serialisierer auf der Gegenseite ergäbe sonst eine andere Signatur für
 * dieselben Daten.
 *
 * **Warum zusätzlich zum Bearer-Token.** Das Token reist in jeder Anfrage
 * mit; wer es aus einem Protokoll oder einem Proxy liest, kann damit lesen.
 * Übernehmen und Ergebnisse melden verlangt die Signatur, und deren Schlüssel
 * verlässt den Ausführer nie. Die Wiederholung innerhalb des Zeitfensters
 * fängt die Idempotenz der Schnittstelle ab (Ausführungsschlüssel): Dieselbe
 * Anfrage zweimal bewirkt dasselbe wie einmal.
 */

export const SIGNATUR_KOPF = 'x-clenaris-signatur';
export const ZEIT_KOPF = 'x-clenaris-zeit';
/** Höchstens so viele Sekunden Abstand zwischen Signatur und Eingang, in beide Richtungen. */
export const ZEITFENSTER_SEKUNDEN = 300;

function nachricht(methode: string, pfad: string, zeit: string, rumpf: string): string {
  const rumpfSumme = createHash('sha256').update(rumpf, 'utf8').digest('hex');
  return `v1\n${methode.toUpperCase()}\n${pfad}\n${zeit}\n${rumpfSumme}`;
}

export function signieren(schluessel: string, anfrage: { methode: string; pfad: string; zeit: number; rumpf: string }): string {
  return `v1=${createHmac('sha256', schluessel).update(nachricht(anfrage.methode, anfrage.pfad, String(anfrage.zeit), anfrage.rumpf)).digest('hex')}`;
}

/**
 * Prüft Signatur und Zeit. Gibt den Grund der Ablehnung zurück oder `null`.
 *
 * Der Grund bleibt im Protokoll der Anwendung; nach aussen antwortet die
 * Schnittstelle einheitlich 401 — wer probiert, soll nicht erfahren, ob die
 * Zeit oder die Signatur falsch war.
 */
export function signaturPruefen(
  schluessel: string,
  anfrage: { methode: string; pfad: string; zeit: string | null; signatur: string | null; rumpf: string },
  jetztMs = Date.now(),
): string | null {
  if (!anfrage.zeit || !/^\d{9,11}$/.test(anfrage.zeit)) return 'Zeitangabe fehlt oder ist ungültig';
  if (Math.abs(jetztMs / 1000 - Number(anfrage.zeit)) > ZEITFENSTER_SEKUNDEN) return 'Zeitangabe ausserhalb des Fensters';
  if (!anfrage.signatur || !/^v1=[0-9a-f]{64}$/.test(anfrage.signatur)) return 'Signatur fehlt oder ist ungültig geformt';
  const erwartet = Buffer.from(
    `v1=${createHmac('sha256', schluessel).update(nachricht(anfrage.methode, anfrage.pfad, anfrage.zeit, anfrage.rumpf)).digest('hex')}`,
  );
  const erhalten = Buffer.from(anfrage.signatur);
  return erwartet.length === erhalten.length && timingSafeEqual(erwartet, erhalten) ? null : 'Signatur stimmt nicht';
}
