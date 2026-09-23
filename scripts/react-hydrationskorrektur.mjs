/**
 * RB-001 — Rückportierung einer React-Korrektur in die von Next mitgelieferte
 * React-Fassung.
 *
 *   node scripts/react-hydrationskorrektur.mjs          # anwenden (idempotent)
 *   node scripts/react-hydrationskorrektur.mjs --pruefen # nur prüfen, Exit 1 wenn offen
 *
 * ---------------------------------------------------------------------------
 *  Der Fehler
 * ---------------------------------------------------------------------------
 *
 * Next 15.5 bringt React als eigene Kopie mit
 * (`next/dist/compiled/react-dom`, `19.2.0-canary-0bdb9206-20250818`). Diese
 * Fassung setzt den Hydrationszeiger nicht zurück, wenn sie ein angehaltenes
 * Host-Element **wiederabspielt** (`replaySuspendedUnitOfWork`, Fall 5):
 *
 *   beginWork(<main>) beansprucht <main>, der Zeiger rückt aufs erste Kind;
 *   ein Kind ist ein noch nicht aufgelöster Flight-Chunk → React hält an;
 *   ist der Chunk beim Weitermachen erfüllt, ruft React beginWork(<main>)
 *   erneut auf — und vergleicht das erste Kind mit „main" → #418, der ganze
 *   Baum wird im Browser neu gebaut.
 *
 * In der Anwendung trifft das `<main id="inhalt">` des App-Rahmens: Sein Kind
 * ist das `LayoutRouter`-Element des Segments, das die Fehlergrenze
 * (`error.tsx`) als Client-Referenz trägt. Lädt deren Chunk noch, liefert
 * Flight das Element als `lazy`. Der Nachweis steht in `docs/HYDRATION.md`
 * §16, der deterministische Test in `tests/e2e/hydration-wiederholung.spec.ts`.
 *
 * ---------------------------------------------------------------------------
 *  Die Korrektur
 * ---------------------------------------------------------------------------
 *
 * Wörtlich die Zeilen, mit denen React 19.3.0 den Fall behebt (verglichen mit
 * `react-dom@19.3.0` und `react-dom@19.3.0-canary-8b0da1c6-20260922`): Ist das
 * wiederabgespielte Element der aktuelle Hydrationselternteil, geht der
 * Zeiger auf das Element selbst zurück, bevor `beginWork` erneut läuft.
 *
 * **Warum eine Rückportierung und kein Versionssprung.** Next 15.5.26, die
 * letzte Fassung der 15er-Reihe, bringt dieselbe fehlerhafte React-Kopie mit.
 * Die Korrektur gibt es erst mit Next 16 — ein Hauptversionssprung mit
 * eigenen Brüchen, der nicht in eine Fehlerbehebung gehört.
 *
 * **Warum ein Skript und kein `patch-package`.** Keine neue Abhängigkeit, und
 * das Verhalten bei Abweichungen ist ausdrücklich: Findet das Skript die
 * erwartete Stelle nicht, **bricht es ab** (Exit 1) — Installation und Bau
 * scheitern, statt eine unkorrigierte Fassung auszuliefern. Bringt eine
 * künftige Next-Fassung die Korrektur selbst mit, erkennt das Skript das und
 * tut nichts.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Ausgabe direkt auf die Standardkanäle: ein Kommandozeilenwerkzeug, kein Anwendungscode.
const melden = (zeile) => process.stdout.write(`${zeile}\n`);
const warnen = (zeile) => process.stderr.write(`${zeile}\n`);

const pruefenAllein = process.argv.includes('--pruefen');
const WURZEL = join(process.cwd(), 'node_modules', 'next', 'dist', 'compiled');

/** Erkennungszeichen der Korrektur — bei uns wie bei React 19.3. */
const KORRIGIERT = /fiber === hydrationParentFiber &&\s*\(isHydrating\s*\?\s*\(popToNextHostParent\(fiber\)/;

/**
 * Die fehlerhafte Stelle: Fall 5 ruft nur `resetHooksOnUnwind` und fällt dann
 * in `default` durch. Die Variable heisst im Produktionsbau `next`, im
 * Entwicklungsbau `unitOfWork`.
 */
const FEHLERHAFT = /(case 5:\n(\s*)resetHooksOnUnwind\((\w+)\);\n)(\s*default:)/;

function korrektur(einzug, variable) {
  return [
    `${einzug}var fiber = ${variable};`,
    `${einzug}fiber === hydrationParentFiber &&`,
    `${einzug}  (isHydrating`,
    `${einzug}    ? (popToNextHostParent(fiber),`,
    `${einzug}      5 === fiber.tag &&`,
    `${einzug}        null != fiber.stateNode &&`,
    `${einzug}        (nextHydratableInstance = fiber.stateNode))`,
    `${einzug}    : (popToNextHostParent(fiber), (isHydrating = !0)));`,
    '',
  ].join('\n');
}

/** Alle React-DOM-Kopien in Next, die den Arbeitszyklus enthalten. */
function ziele() {
  if (!existsSync(WURZEL)) return [];
  return readdirSync(WURZEL)
    .filter((d) => d === 'react-dom' || d.startsWith('react-dom-'))
    .flatMap((d) => {
      const cjs = join(WURZEL, d, 'cjs');
      if (!existsSync(cjs)) return [];
      return readdirSync(cjs)
        .filter((f) => /^react-dom-(client|profiling)\.[a-z]+\.js$/.test(f))
        .map((f) => join(cjs, f));
    })
    .filter((pfad) => {
      const quelle = readFileSync(pfad, 'utf8');
      return quelle.includes('function replaySuspendedUnitOfWork');
    });
}

function main() {
  const dateien = ziele();
  if (dateien.length === 0) {
    warnen('✗ React-Hydrationskorrektur: keine React-Kopie unter node_modules/next/dist/compiled gefunden.');
    process.exit(1);
  }

  let offen = 0;
  for (const pfad of dateien) {
    const kurz = pfad.slice(WURZEL.length + 1);
    const quelle = readFileSync(pfad, 'utf8');
    const start = quelle.indexOf('function replaySuspendedUnitOfWork');
    // Der Entwicklungsbau lagert den Fall in `replayBeginWork` aus.
    const bereichStart = quelle.includes('function replayBeginWork') ? quelle.indexOf('function replayBeginWork') : start;
    const bereich = quelle.slice(bereichStart, bereichStart + 2500);

    if (KORRIGIERT.test(bereich)) {
      melden(`✓ ${kurz}: korrigiert`);
      continue;
    }
    const treffer = FEHLERHAFT.exec(bereich);
    if (!treffer) {
      warnen(
        `✗ ${kurz}: erwartete Stelle nicht gefunden. Die React-Fassung in Next hat sich geändert — ` +
          'prüfen, ob sie die Korrektur selbst enthält, und dieses Skript anpassen (docs/HYDRATION.md §16).',
      );
      process.exit(1);
    }
    if (pruefenAllein) {
      warnen(`✗ ${kurz}: Korrektur fehlt`);
      offen += 1;
      continue;
    }
    const [ganz, kopf, einzug, variable, rest] = treffer;
    const neu = `${kopf}${korrektur(einzug, variable)}${rest}`;
    const ergebnis = quelle.slice(0, bereichStart) + bereich.replace(ganz, neu) + quelle.slice(bereichStart + bereich.length);
    writeFileSync(pfad, ergebnis, 'utf8');
    melden(`✓ ${kurz}: Korrektur eingesetzt`);
  }
  if (offen > 0) process.exit(1);
}

main();
