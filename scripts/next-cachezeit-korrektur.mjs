/**
 * RB-002 — Korrektur der Zeitmarke, mit der Next einen Cache-Tag ungültig
 * macht. Eine **befristete Verträglichkeitslösung** nach dem Muster von RB-001
 * (`scripts/react-hydrationskorrektur.mjs`), keine Dauereinrichtung.
 *
 *   node scripts/next-cachezeit-korrektur.mjs          # prüfen und, wo nötig, anwenden
 *   node scripts/next-cachezeit-korrektur.mjs --pruefen # nur prüfen, Exit 1 wenn offen
 *
 * ---------------------------------------------------------------------------
 *  Der Fehler
 * ---------------------------------------------------------------------------
 *
 * `revalidatePath`/`revalidateTag` enden in Next 15.5 in zwei Aufrufen, die
 * dieselbe Tabelle beschreiben (`tags-manifest.external.js`):
 *
 *   1. `FileSystemCache.revalidateTag` setzt `Date.now()` — aber nur, wenn der
 *      Tag noch **nie** ungültig gemacht wurde (`if (!has(tag))`);
 *   2. danach `DefaultCacheHandler.expireTags` — immer, mit
 *      `performance.timeOrigin + performance.now()`, der **monotonen** Uhr.
 *
 * Ob eine gespeicherte Seite veraltet ist, entscheidet `isStale` durch
 * Vergleich dieser Marke mit dem Alter des Eintrags — und das ist die
 * Änderungszeit der Datei (`mtime`), die **Wanduhr**. Die beiden Uhren laufen
 * in einem langlebigen Prozess auseinander: gemessen 2–3 ms je Minute auf dem
 * Prüfrechner, `Date.now()` vorn. Nach zwei Stunden Laufzeit lag die Marke
 * einer Ungültigmachung dadurch 100–200 ms *vor* dem Eintrag, der kurz davor
 * geschrieben worden war, und der Eintrag galt als frisch: Ein
 * veröffentlichter Handlungsaufruf erschien nicht, ein abgeschalteter blieb
 * stehen — bis `revalidate` (eine Stunde) ablief. Nach dem Neustart des
 * Servers (Abweichung ≈ 0) verhielt sich dieselbe Folge richtig.
 *
 * Gefunden 2026-09-28: `tests/api/rbac.test.ts` „lässt ihn nach dem
 * Abschalten wieder verschwinden" scheiterte auf einem seit Stunden laufenden
 * Prüfserver und nie auf einem frischen. In Produktion läuft der Server Tage;
 * das Fenster wächst mit.
 *
 * ---------------------------------------------------------------------------
 *  Die Korrektur
 * ---------------------------------------------------------------------------
 *
 * `expireTags` nimmt das **Maximum** beider Uhren. Eine Ungültigmachung liegt
 * damit nie vor der Wanduhr (Dateieinträge) und nie vor der monotonen Uhr
 * (Einträge des Handlers selbst, `use cache` — in dieser Anwendung nicht
 * benutzt). Beide Fehlerrichtungen, die übrig bleiben, sind die sichere: ein
 * Eintrag wird einmal zu viel neu erzeugt, nie zu lange ausgeliefert.
 *
 * Angewandt wird **nur**, wenn alles zutrifft (fail-closed wie RB-001):
 *
 *  • die Next-Fassung steht in `BETROFFENE_FASSUNGEN`;
 *  • der erwartete Originalausschnitt steht **genau einmal** in der Datei;
 *  • die Korrektur steht noch nicht darin.
 *
 * Jeder andere Zustand endet mit Exit 1. Eine unbekannte Fassung, die die
 * Korrektur schon enthält, gilt als erledigt.
 *
 * **Lebenszyklus** (`package.json`): `postinstall`, `build` und `dev`, wie
 * RB-001. Die Datei wird von `next start` zur Laufzeit aus `node_modules`
 * geladen (nicht gebündelt, geprüft: `.next/server` enthält nur den
 * Middleware-Aufruf) — ein laufender Server braucht nach dem Anwenden einen
 * Neustart, keinen Neubau.
 *
 * **Regressionsprüfung:** `tests/api/next-cachezeit.test.ts` lädt die
 * gepatchte Datei, stellt die monotone Uhr zurück und verlangt, dass die
 * Marke nicht vor `Date.now()` liegt — ohne Korrektur scheitert sie.
 *
 * **Entfernungskriterium:** Bei einem Next-Update endet das Skript mit
 * „unbekannte Next-Fassung" (fail-closed). Dann die neue `expireTags`-Stelle
 * lesen: Führt Next beide Seiten des Vergleichs mit derselben Uhr, dieses
 * Skript und seine Aufrufe entfernen — die Regressionsprüfung bleibt und muss
 * weiter grün sein. Sonst die Fassung aufnehmen und den Ausschnitt anpassen.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const melden = (zeile) => process.stdout.write(`${zeile}\n`);
const warnen = (zeile) => process.stderr.write(`${zeile}\n`);

const pruefenAllein = process.argv.includes('--pruefen');
const NEXT = join(process.cwd(), 'node_modules', 'next');

/** Nur diese Next-Fassungen werden verändert — geprüft, dass sie den Fehler haben. */
const BETROFFENE_FASSUNGEN = new Set(['15.5.26']);

const DATEIEN = [
  join('dist', 'server', 'lib', 'cache-handlers', 'default.external.js'),
  join('dist', 'esm', 'server', 'lib', 'cache-handlers', 'default.external.js'),
];

const ORIGINAL =
  "        const timestamp = Math.round(performance.timeOrigin + performance.now());\n" +
  "        debug == null ? void 0 : debug('expireTags', {";

const KORREKTUR =
  '        // Clenaris RB-002 (scripts/next-cachezeit-korrektur.mjs): nie vor der Wanduhr,\n' +
  '        // mit der `isStale` das Alter gespeicherter Seiten (mtime) vergleicht.\n' +
  '        const timestamp = Math.max(Math.round(performance.timeOrigin + performance.now()), Date.now());\n' +
  "        debug == null ? void 0 : debug('expireTags', {";

function vorkommen(text, ausschnitt) {
  let n = 0;
  for (let i = text.indexOf(ausschnitt); i !== -1; i = text.indexOf(ausschnitt, i + ausschnitt.length)) n += 1;
  return n;
}

function main() {
  const paket = join(NEXT, 'package.json');
  if (!existsSync(paket)) {
    warnen('✗ node_modules/next fehlt — zuerst `npm ci`.');
    return 1;
  }
  const fassung = JSON.parse(readFileSync(paket, 'utf8')).version;
  let fehler = 0;

  for (const relativ of DATEIEN) {
    const datei = join(NEXT, relativ);
    const name = `next/${relativ.replaceAll('\\', '/')}`;
    if (!existsSync(datei)) {
      warnen(`✗ ${name} (${fassung}): Datei fehlt.`);
      fehler += 1;
      continue;
    }
    const text = readFileSync(datei, 'utf8');
    const original = vorkommen(text, ORIGINAL);
    const korrigiert = vorkommen(text, KORREKTUR);

    if (korrigiert === 1 && original === 0) {
      melden(`✓ ${name} (${fassung}): Korrektur ${BETROFFENE_FASSUNGEN.has(fassung) ? 'angewandt' : 'bereits enthalten'}.`);
      continue;
    }
    if (!BETROFFENE_FASSUNGEN.has(fassung)) {
      warnen(`✗ ${name}: unbekannte Next-Fassung ${fassung} ohne Korrektur — Originalausschnitt prüfen (siehe Kopf dieses Skripts).`);
      fehler += 1;
      continue;
    }
    if (original !== 1 || korrigiert !== 0) {
      warnen(`✗ ${name} (${fassung}): Ausschnitt ${original}× gefunden, Korrektur ${korrigiert}× — erwartet genau einmal das Original.`);
      fehler += 1;
      continue;
    }
    if (pruefenAllein) {
      warnen(`✗ ${name} (${fassung}): Korrektur fehlt — \`node scripts/next-cachezeit-korrektur.mjs\` ausführen.`);
      fehler += 1;
      continue;
    }
    writeFileSync(datei, text.replace(ORIGINAL, KORREKTUR), 'utf8');
    melden(`✓ ${name} (${fassung}): Korrektur eingesetzt.`);
  }
  return fehler === 0 ? 0 : 1;
}

process.exitCode = main();
