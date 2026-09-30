import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Beweise eines roten Prüflaufs sichern, bevor sie verschwinden (2026-09-30, RC-20).
 *
 * Anlass: Im `verify:release` auf `acae4f1` scheiterte Stresslauf 4 von 5
 * einmal (`abmelden.spec.ts`, „browserContext.close: Target page, context or
 * browser has been closed"). Die Spur des Falls war danach **zweimal**
 * verloren, und die Ursache liess sich nicht mehr belegen:
 *
 *  1. Playwright leert `test-results/` zu Beginn jedes Laufs — Lauf 5 hat die
 *     Spur von Lauf 4 überschrieben, bevor jemand sie ansehen konnte.
 *  2. `verify:release` entfernt am Ende seinen Worktree samt `test-results/`
 *     und `hydrationsbefunde/`. Die Zeile „Vollständige Ausgabe des roten
 *     Laufs: …" zeigte danach auf eine Datei, die es nicht mehr gab.
 *
 * Eine Stressreihe, die einen seltenen Fehler findet und seinen Beweis
 * selbst wegräumt, misst nur noch, *dass* etwas passiert ist. Genau für den
 * seltenen Fall ist sie aber da.
 *
 * Kopiert, nicht verschoben: Der Aufrufer räumt danach selbst auf, und ein
 * halb verschobenes Verzeichnis wäre schlechter als zwei Kopien.
 */

/** Hat das Verzeichnis überhaupt Inhalt? Leere Ablagen wären nur Rauschen. */
function mitInhalt(pfad: string): boolean {
  return existsSync(pfad) && readdirSync(pfad).length > 0;
}

/**
 * Den Inhalt von `test-results/` eines roten Laufs nach `ziel` kopieren —
 * **bevor** der nächste Playwright-Lauf das Verzeichnis leert.
 *
 * Liefert den Zielpfad, oder `null`, wenn es nichts zu sichern gab (dann
 * entsteht auch kein leeres Zielverzeichnis).
 */
export function laufspurenSichern(testergebnisse: string, ziel: string): string | null {
  if (!mitInhalt(testergebnisse)) return null;
  mkdirSync(ziel, { recursive: true });
  cpSync(testergebnisse, ziel, { recursive: true });
  return ziel;
}

/**
 * Beweise aus einem Prüfabzug (dem Release-Worktree) nach `ablage` kopieren,
 * bevor der Abzug entfernt wird: `hydrationsbefunde/` (Protokolle roter
 * Stressläufe, gesicherte Spuren, Hydrationsberichte) und `test-results/`
 * (Spur eines roten Laufs im Kern, Bericht der Stressreihe).
 *
 * Liefert die gesicherten Ziele; leer, wenn der Abzug nichts hinterlassen hat.
 */
export function abzugsbefundeSichern(abzug: string, ablage: string): string[] {
  const gesichert: string[] = [];
  for (const name of ['hydrationsbefunde', 'test-results']) {
    const quelle = join(abzug, name);
    if (!mitInhalt(quelle)) continue;
    const ziel = join(ablage, name);
    mkdirSync(ziel, { recursive: true });
    cpSync(quelle, ziel, { recursive: true });
    gesichert.push(ziel);
  }
  return gesichert;
}
