/**
 * Status einer Prüfung mit einem ausdrücklich verlangten Teil (2026-09-29, M2).
 *
 * `security:check -- --datenbank` verlangt den Abgleich der handgeschriebenen
 * Schranken (Teilindizes, Trigger) gegen eine **laufende** Datenbank. Fehlte
 * die Adresse, stand bis dahin „Datenbankabgleich: NICHT GEPRÜFT" nur im
 * Hinweistext — der Status der Prüfung blieb BESTANDEN, und der Gesamtbericht
 * meldete OK. Wer `--datenbank` ruft, will aber genau diese Aussage; ein
 * Bestanden ohne sie ist eine falsche Auskunft.
 *
 * Die Regel: Blockierende Befunde gehen vor (BEFUND). Sonst ist eine Prüfung,
 * deren verlangter Teil nicht lief, NICHT_GEPRUEFT — nie BESTANDEN. Der
 * Gesamtstatus von `security-check.ts` wird damit ebenfalls NICHT_GEPRUEFT
 * und endet nicht mit Erfolg.
 */

export type Pruefstatus = 'BESTANDEN' | 'BEFUND' | 'NICHT_GEPRUEFT' | 'FEHLER';

export function statusMitPflichtteil(
  befunde: { schwere: 'blockierend' | 'warnung' | 'hinweis' }[],
  pflichtteil: { verlangt: boolean; gelaufen: boolean },
): Pruefstatus {
  if (befunde.some((b) => b.schwere !== 'hinweis')) return 'BEFUND';
  if (pflichtteil.verlangt && !pflichtteil.gelaufen) return 'NICHT_GEPRUEFT';
  return 'BESTANDEN';
}
