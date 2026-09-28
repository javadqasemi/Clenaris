/**
 * RB-001 — Rückportierung einer React-Korrektur in die von Next mitgelieferte
 * React-Fassung. Eine **befristete Verträglichkeitslösung**, keine
 * Dauereinrichtung (Entfernungskriterium unten).
 *
 *   node scripts/react-hydrationskorrektur.mjs          # prüfen und, wo nötig, anwenden
 *   node scripts/react-hydrationskorrektur.mjs --pruefen # nur prüfen, Exit 1 wenn offen
 *
 * ---------------------------------------------------------------------------
 *  Der Fehler
 * ---------------------------------------------------------------------------
 *
 * Next 15.5 bringt React als eigene Kopie mit (`next/dist/compiled/react-dom*`).
 * In den Fassungen `19.2.0-canary-0bdb9206-20250818` und
 * `19.2.0-experimental-0bdb9206-20250818` — mitgeliefert von Next 15.5.25
 * **und** 15.5.26 — setzt `replaySuspendedUnitOfWork` (Fall 5) den
 * Hydrationszeiger nicht zurück, wenn ein angehaltenes Host-Element
 * wiederabgespielt wird:
 *
 *   beginWork(<main>) beansprucht <main>, der Zeiger rückt aufs erste Kind;
 *   ein Kind ist ein noch nicht aufgelöster Flight-Chunk → React hält an;
 *   ist der Chunk beim Weitermachen erfüllt, ruft React beginWork(<main>)
 *   erneut auf — und vergleicht das erste Kind mit „main" → #418.
 *
 * Nachweis: `docs/HYDRATION.md` §16; deterministischer Test:
 * `tests/e2e/hydration-wiederholung.spec.ts` (scheitert ohne diese Korrektur,
 * geprüft mit Next 15.5.25 und 15.5.26).
 *
 * ---------------------------------------------------------------------------
 *  Die Korrektur — und wann sie angewandt wird
 * ---------------------------------------------------------------------------
 *
 * Wörtlich die Zeilen aus React 19.3.0 (`react-dom@19.3.0`,
 * `19.3.0-canary-8b0da1c6-20260922`). Angewandt wird **nur**, wenn alles
 * zutrifft:
 *
 *  • die React-Fassung der Datei steht in `BETROFFENE_FASSUNGEN`;
 *  • der erwartete Originalausschnitt steht **genau einmal** in der Datei —
 *    wörtlich, mit Einzug und Variablenname (Produktions- und
 *    Entwicklungsbau unterscheiden sich darin);
 *  • die Korrektur steht noch nicht darin.
 *
 * Ersetzt wird genau diese eine Stelle, keine freie Textersetzung. Jeder
 * andere Zustand endet mit Exit 1 (fail-closed): unbekannte Fassung ohne
 * Korrektur, Ausschnitt null- oder mehrfach, Original und Korrektur
 * zugleich. Eine unbekannte Fassung, die die Korrektur schon selbst
 * enthält, gilt als erledigt.
 *
 * **Lebenszyklus** (`package.json`): `postinstall` (nach `npm ci`), `build`
 * (bevor das Bündel entsteht — fängt auch `npm install <paket>` ab, das die
 * Lebenszyklusskripte des Projekts **nicht** ausführt, gemessen beim Update
 * auf 15.5.26) und `dev` (übersetzt direkt aus `node_modules`). **Kein**
 * Aufruf beim reinen Serverstart: `next start` / `start:built` / PM2 lesen
 * nur das fertige Bündel, und das Skript schreibt ohnehin nur, wenn die
 * Korrektur fehlt.
 *
 * **Entfernungskriterium:** Sobald eine Next-Fassung eine React-Fassung mit
 * der Korrektur mitbringt (voraussichtlich erst Next 16), meldet
 * `--pruefen` für jede Datei „Korrektur bereits enthalten". Dann: dieses
 * Skript und seine drei Aufrufe in `package.json` entfernen; der
 * Regressionstest bleibt und muss weiter grün sein.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const melden = (zeile) => process.stdout.write(`${zeile}\n`);
const warnen = (zeile) => process.stderr.write(`${zeile}\n`);

const pruefenAllein = process.argv.includes('--pruefen');
const WURZEL = join(process.cwd(), 'node_modules', 'next', 'dist', 'compiled');

/** Nur diese React-Fassungen werden verändert — geprüft, dass sie den Fehler haben. */
const BETROFFENE_FASSUNGEN = new Set([
  '19.2.0-canary-0bdb9206-20250818',
  '19.2.0-experimental-0bdb9206-20250818',
]);

/**
 * Die beiden Bauformen: Produktion/Profiling (`replaySuspendedUnitOfWork`,
 * Variable `next`, `case 5:` mit vier Leerzeichen Einzug) und Entwicklung
 * (`replayBeginWork`, Variable `unitOfWork`, acht Leerzeichen).
 */
const FORMEN = [
  { variable: 'next', einzug: '    ' },
  { variable: 'unitOfWork', einzug: '        ' },
].map(({ variable, einzug }) => {
  const innen = `${einzug}  `;
  const original = `${einzug}case 5:\n${innen}resetHooksOnUnwind(${variable});\n${einzug}default:`;
  const korrigiert =
    `${einzug}case 5:\n` +
    `${innen}resetHooksOnUnwind(${variable});\n` +
    `${innen}var fiber = ${variable};\n` +
    `${innen}fiber === hydrationParentFiber &&\n` +
    `${innen}  (isHydrating\n` +
    `${innen}    ? (popToNextHostParent(fiber),\n` +
    `${innen}      5 === fiber.tag &&\n` +
    `${innen}        null != fiber.stateNode &&\n` +
    `${innen}        (nextHydratableInstance = fiber.stateNode))\n` +
    `${innen}    : (popToNextHostParent(fiber), (isHydrating = !0)));\n` +
    `${einzug}default:`;
  return { variable, original, korrigiert };
});

/** Die Korrektur, unabhängig vom Einzug — auch in einer künftigen React-Fassung. */
const KORREKTUR_ERKENNUNG =
  /fiber === hydrationParentFiber &&\s*\(isHydrating\s*\?\s*\(popToNextHostParent\(fiber\),\s*5 === fiber\.tag &&\s*null != fiber\.stateNode &&\s*\(nextHydratableInstance = fiber\.stateNode\)\)/g;

const anzahl = (text, teil) => text.split(teil).length - 1;

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
    .filter((pfad) => readFileSync(pfad, 'utf8').includes('function replaySuspendedUnitOfWork'));
}

function abbrechen(kurz, grund) {
  warnen(`✗ ${kurz}: ${grund}`);
  warnen('  React-Hydrationskorrektur abgebrochen (fail-closed) — docs/HYDRATION.md §16.');
  process.exit(1);
}

function main() {
  const dateien = ziele();
  if (dateien.length === 0) abbrechen('node_modules/next', 'keine React-Kopie unter next/dist/compiled gefunden.');

  let offen = 0;
  for (const pfad of dateien) {
    const kurz = pfad.slice(WURZEL.length + 1);
    const quelle = readFileSync(pfad, 'utf8');
    const fassung = /exports\.version = "([^"]+)"/.exec(quelle)?.[1] ?? 'unbekannt';
    const korrekturen = (quelle.match(KORREKTUR_ERKENNUNG) ?? []).length;
    const treffer = FORMEN.map((f) => ({ ...f, n: anzahl(quelle, f.original) })).filter((f) => f.n > 0);

    if (korrekturen === 1 && treffer.length === 0) {
      melden(`✓ ${kurz} (${fassung}): ${BETROFFENE_FASSUNGEN.has(fassung) ? 'korrigiert' : 'Korrektur bereits enthalten'}`);
      continue;
    }
    if (korrekturen > 1) abbrechen(kurz, `Korrektur ${korrekturen}-mal enthalten.`);
    if (korrekturen === 1) abbrechen(kurz, 'Korrektur und ursprünglicher Ausschnitt zugleich vorhanden.');
    if (!BETROFFENE_FASSUNGEN.has(fassung)) {
      abbrechen(kurz, `unbekannte React-Fassung ${fassung} ohne erkennbare Korrektur — prüfen, bevor etwas verändert wird.`);
    }
    if (treffer.length !== 1 || treffer[0].n !== 1) {
      abbrechen(kurz, `erwarteter Originalausschnitt ${treffer.length === 0 ? 'nicht gefunden' : 'nicht eindeutig'}.`);
    }
    if (pruefenAllein) {
      warnen(`✗ ${kurz} (${fassung}): Korrektur fehlt`);
      offen += 1;
      continue;
    }

    const { original, korrigiert } = treffer[0];
    const stelle = quelle.indexOf(original);
    const neu = quelle.slice(0, stelle) + korrigiert + quelle.slice(stelle + original.length);
    // Nachkontrolle, bevor geschrieben wird: genau eine Korrektur, kein Original mehr.
    if ((neu.match(KORREKTUR_ERKENNUNG) ?? []).length !== 1 || anzahl(neu, original) !== 0) {
      abbrechen(kurz, 'Nachkontrolle der Ersetzung fehlgeschlagen — nichts geschrieben.');
    }
    writeFileSync(pfad, neu, 'utf8');
    melden(`✓ ${kurz} (${fassung}): Korrektur eingesetzt`);
  }
  if (offen > 0) process.exit(1);
}

main();
