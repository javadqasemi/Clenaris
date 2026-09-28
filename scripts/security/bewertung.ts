/**
 * Einordnung eines `npm audit`-Befunds gegen seine Bewertung in
 * `security/akzeptierte-befunde.json` (Sicherheitsautomation, 2026-09-26).
 *
 * Rein und ohne Dateizugriff, damit `tests/api/sicherheitsbewertung.test.ts`
 * die Regeln mit festen Daten prüfen kann.
 *
 * **Eine Risikoannahme ist befristet, und die Frist hat Folgen.** Ohne diese
 * Regeln läge eine Bewertung vom Herbst im nächsten Sommer noch da und
 * „deckte" einen Befund, den längst niemand mehr angesehen hat. Deshalb:
 *
 *  • `critical` blockiert immer — keine Bewertung hebt das auf.
 *  • `high` ohne gültige Bewertung blockiert; mit gültiger ist es ein Hinweis.
 *  • Läuft eine Bewertung in höchstens `VORWARNUNG_TAGE` Tagen ab, wird aus
 *    dem Hinweis eine **Warnung** — der Gesamtstatus zeigt sie, bevor der
 *    Lauf am Stichtag rot wird.
 *  • Nach Ablauf: `high` blockiert wieder; `moderate`/`low` werden Warnung,
 *    bis jemand neu bewertet oder den Eintrag entfernt.
 *  • Eine Frist länger als `HOECHSTFRIST_TAGE` ist selbst eine Warnung: Eine
 *    Risikoannahme über mehr als ein halbes Jahr ist keine Bewertung, sondern
 *    ein Vergessen mit Datum.
 */

export type Schwere = 'blockierend' | 'warnung' | 'hinweis';

export interface Bewertung {
  id: string;
  paket: string;
  schwere: string;
  begruendung: string;
  bewertetAm?: string;
  bis: string;
}

export const VORWARNUNG_TAGE = 30;
export const HOECHSTFRIST_TAGE = 183;

function tageZwischen(von: string, bis: string): number {
  return Math.round((Date.parse(`${bis}T00:00:00Z`) - Date.parse(`${von}T00:00:00Z`)) / 86_400_000);
}

export function befundEinordnen(
  advisorySchwere: string,
  bewertung: Bewertung | undefined,
  heute: string,
): { schwere: Schwere; vermerk: string } {
  if (advisorySchwere === 'critical') {
    return { schwere: 'blockierend', vermerk: 'kritisch — lässt sich nicht wegbewerten' };
  }
  if (!bewertung) {
    return advisorySchwere === 'high'
      ? { schwere: 'blockierend', vermerk: 'nicht bewertet — in security/akzeptierte-befunde.json einordnen oder beheben' }
      : { schwere: 'hinweis', vermerk: 'nicht bewertet (Stufe unter high)' };
  }
  const rest = tageZwischen(heute, bewertung.bis);
  if (rest < 0) {
    return {
      schwere: advisorySchwere === 'high' ? 'blockierend' : 'warnung',
      vermerk: `Bewertung abgelaufen am ${bewertung.bis} — neu bewerten oder beheben`,
    };
  }
  if (bewertung.bewertetAm && tageZwischen(bewertung.bewertetAm, bewertung.bis) > HOECHSTFRIST_TAGE) {
    return { schwere: 'warnung', vermerk: `Frist bis ${bewertung.bis} länger als ${HOECHSTFRIST_TAGE} Tage ab Bewertung — kürzer fassen` };
  }
  if (rest <= VORWARNUNG_TAGE) {
    return { schwere: 'warnung', vermerk: `Bewertung läuft in ${rest} Tag(en) ab (${bewertung.bis}) — neu bewerten` };
  }
  return { schwere: 'hinweis', vermerk: `bewertet bis ${bewertung.bis}: ${bewertung.begruendung}` };
}

/** Bewertungen, zu denen `npm audit` keinen Befund mehr meldet — Einträge zum Entfernen. */
export function veralteteBewertungen(bewertungen: Bewertung[], gemeldeteIds: Set<string>): Bewertung[] {
  return bewertungen.filter((b) => !gemeldeteIds.has(b.id));
}
