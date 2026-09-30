import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { COMMIT_MUSTER } from '../../src/lib/release/manifest';

import { browserBilanzPruefen, type BrowserZahlen } from './testbilanz';

/**
 * Wie der Prüfweg endet — und was er als Release-Nachweis hinterlässt
 * (2026-09-30).
 *
 * ---------------------------------------------------------------------------
 *  Warum ein eigenes, reines Modul
 * ---------------------------------------------------------------------------
 *
 * Bis hierher stand der Schluss am Ende von `scripts/verify.ts` als drei
 * `console.log`: `verify:release:core` meldete „✅ Release-Kern bestanden“
 * und endete mit 0, `verify:release:stress` ebenso mit „✅ Stressreihe 5/5
 * bestanden“. Die Warnung „RELEASE NICHT BELEGT“ stand in der Zeile darunter.
 * Wer oder was nur auf den Exitcode oder auf das grüne Häkchen sah — ein
 * Skript, ein CI-Schritt, ein müder Mensch am Ende eines halbstündigen
 * Laufs —, las eine Teilprüfung als Freigabe. Ein Teilweg, der wie der
 * Gesamtweg endet, ist ein Freigabeweg mit Hintertür.
 *
 * Jetzt gilt (Vertrag C9 der Härtung Production V2):
 *
 *   verify:release          „RELEASE BESTANDEN“, Exitcode 0, schreibt
 *                           `test-results/release-nachweis.json`
 *   verify:release:core     letzte Zeile „TEILPRÜFUNG BESTANDEN — KEIN
 *   verify:release:stress   RELEASE-NACHWEIS“, Exitcode 3, kein Häkchen,
 *                           kein Nachweis
 *   alle übrigen Modi       unverändert „Alle blockierenden Schritte
 *                           bestanden“, Exitcode 0
 *
 * Exitcode **3**, nicht 0 und nicht 1: 0 hiesse „freigegeben“, 1 hiesse
 * „gescheitert“ — beides wäre falsch. Eine eigene Zahl lässt einen Aufrufer
 * die Teilprüfung von beidem unterscheiden, ohne die Ausgabe zu lesen, und
 * ein Aufrufer, der nur `!= 0` prüft, hält sie sicher für keine Freigabe.
 *
 * Als reine Funktionen, damit die Regel ohne einen halbstündigen Lauf
 * geprüft werden kann (`tests/api/pruefbilanz.test.ts`). `verify.ts` und
 * `e2e-stress.ts` entscheiden nichts davon selbst.
 *
 * ---------------------------------------------------------------------------
 *  Warum der Nachweis eine Datei ist
 * ---------------------------------------------------------------------------
 *
 * „RELEASE BESTANDEN“ im Terminal ist nach dem Schliessen des Fensters weg,
 * und der Release-Weg entfernt seinen Abzug am Ende. Die Datei hält fest,
 * *was* bestanden hat: Commit, Anfang und Ende, jeden Schritt des Kerns, die
 * Browserbilanz je Engine, und jeden der fünf Stressläufe mit seinen
 * Zahlen. Sie liegt in `test-results/` des Abzugs und wird mit den übrigen
 * Beweisen nach `hydrationsbefunde/release-…/` gesichert
 * (`befundsicherung.ts`), bevor der Abzug verschwindet.
 *
 * Der Nachweis wird nur aus vollständigen Zahlen gebaut
 * (`releaseNachweisBauen`): Fehlt die Kernbilanz, ist sie nicht grün, sind
 * es nicht genau fünf grüne Stressläufe oder fehlt einer Engine jeder
 * bestandene Fall, gibt es keinen Nachweis, sondern Gründe. Die Datei kann
 * also nicht mehr behaupten, als die Läufe belegt haben.
 */

export type Modus = 'statisch' | 'pruefreihen' | 'browser' | 'voll' | 'release' | 'release-kern' | 'release-stress';

export const MODI: readonly Modus[] = ['statisch', 'pruefreihen', 'browser', 'voll', 'release', 'release-kern', 'release-stress'];

/** Läufe der Stressreihe im Release-Weg; eine kleinere Zahl ist kein Release-Nachweis. */
export const STRESS_LAEUFE = 5;

/** Exitcode einer bestandenen Teilprüfung — weder Freigabe (0) noch Fehlschlag (1). */
export const TEILPRUEFUNG_EXITCODE = 3;

/** Die letzte Zeile jeder Teilprüfung. Aufrufer dürfen nach „KEIN RELEASE-NACHWEIS“ suchen. */
export const TEILPRUEFUNG_ZEILE = 'TEILPRÜFUNG BESTANDEN — KEIN RELEASE-NACHWEIS';

/** Dateiname des Nachweises, in `test-results/` des Release-Abzugs. */
export const RELEASE_NACHWEIS_DATEI = 'release-nachweis.json';

/** Die Engines der Browserreihe (`playwright.config.ts`, Projekte). */
export const ENGINES = ['chromium', 'firefox', 'webkit'] as const;

export interface Abschluss {
  /** Was am Ende ausgegeben wird; die letzte Zeile ist die Aussage. */
  text: string;
  /** Exitcode des Prüfwegs. */
  code: number;
  /** Schreibt dieser Modus den Release-Nachweis? Nur `release`. */
  nachweis: boolean;
}

/**
 * Der Schluss eines **bestandenen** Laufs je Modus. Ein gescheiterter Lauf
 * kommt hier nicht an — `verify.ts` bricht vorher mit Exitcode 1 ab.
 */
export function abschluss(modus: Modus): Abschluss {
  switch (modus) {
    case 'release':
      return { text: `✅  RELEASE BESTANDEN — Kern und Stressreihe ${STRESS_LAEUFE}/${STRESS_LAEUFE}.`, code: 0, nachweis: true };
    case 'release-kern':
      return {
        text: [
          'Release-Kern bestanden: sauberer Abzug, frische Testdatenbank, voller Prüfweg.',
          `Es fehlt die Stressreihe (${STRESS_LAEUFE} Browserläufe, je frischer Server) — ein Release-Nachweis ist erst \`npm run verify:release\`, Kern und Stressreihe im selben Abzug.`,
          TEILPRUEFUNG_ZEILE,
        ].join('\n'),
        code: TEILPRUEFUNG_EXITCODE,
        nachweis: false,
      };
    case 'release-stress':
      return {
        text: [
          `Stressreihe ${STRESS_LAEUFE}/${STRESS_LAEUFE} bestanden — gegen den Bau im Arbeitsbaum, nicht gegen einen sauberen Abzug.`,
          'Es fehlt der Kern (sauberer Abzug, frische Testdatenbank, voller Prüfweg) — ein Release-Nachweis ist erst `npm run verify:release`.',
          TEILPRUEFUNG_ZEILE,
        ].join('\n'),
        code: TEILPRUEFUNG_EXITCODE,
        nachweis: false,
      };
    case 'statisch':
    case 'pruefreihen':
    case 'browser':
    case 'voll':
      return { text: '✅  Alle blockierenden Schritte bestanden.', code: 0, nachweis: false };
  }
}

// ---------------------------------------------------------------------------
//  Browserbilanz je Engine (Playwright-JSON-Bericht)
// ---------------------------------------------------------------------------

export type EngineZahlen = Required<BrowserZahlen>;

export interface BrowserBilanz {
  /** Die Gesamtzahlen aus `stats` des Berichts. */
  gesamt: BrowserZahlen;
  /** Dieselben vier Zahlen je Projekt (= Engine), aus den einzelnen Fällen gezählt. */
  jeEngine: Record<string, EngineZahlen>;
  /** Die konfigurierten Projekte laut Bericht — auch die, in denen nichts lief. */
  engines: string[];
}

const leer = (): EngineZahlen => ({ expected: 0, skipped: 0, unexpected: 0, flaky: 0 });

interface JsonTest {
  projectName?: unknown;
  status?: unknown;
}
interface JsonSpec {
  tests?: JsonTest[];
}
interface JsonSuite {
  specs?: JsonSpec[];
  suites?: JsonSuite[];
}

/**
 * Die Browserbilanz aus einem Playwright-JSON-Bericht, gesamt und je Engine.
 *
 * `stats` kennt nur die Summe. Eine Summe von „57 bestanden“ sagt aber nicht,
 * ob Firefox und WebKit überhaupt gefahren sind — genau die Engines, deren
 * Fehler (Bilder, Scrollsperre, sichere Cookies) Chromium nicht zeigen kann.
 * Deshalb wird je Fall (`suites → specs → tests`, rekursiv) nach
 * `projectName` und `status` gezählt; die vier Zustände sind dieselben wie in
 * `stats` (`expected`, `unexpected`, `flaky`, `skipped`).
 *
 * `null`, wenn der Bericht kein Objekt ist oder `stats` fehlt: Ohne Zahlen ist
 * nichts bewiesen, und der Aufrufer wertet `null` als Fehlschlag.
 */
export function browserBilanzAusBericht(bericht: unknown): BrowserBilanz | null {
  if (typeof bericht !== 'object' || bericht === null) return null;
  const b = bericht as { stats?: BrowserZahlen; suites?: JsonSuite[]; config?: { projects?: { name?: unknown }[] } };
  if (typeof b.stats !== 'object' || b.stats === null) return null;

  const jeEngine: Record<string, EngineZahlen> = {};
  const konfiguriert = (b.config?.projects ?? []).map((p) => p.name).filter((n): n is string => typeof n === 'string' && n.length > 0);
  for (const name of konfiguriert) jeEngine[name] = leer();

  const besuchen = (suite: JsonSuite): void => {
    for (const spec of suite.specs ?? []) {
      for (const fall of spec.tests ?? []) {
        const engine = typeof fall.projectName === 'string' && fall.projectName ? fall.projectName : '(ohne Projekt)';
        const zahlen = (jeEngine[engine] ??= leer());
        if (fall.status === 'expected' || fall.status === 'unexpected' || fall.status === 'flaky' || fall.status === 'skipped') zahlen[fall.status] += 1;
        // Ein unbekannter Zustand (neue Playwright-Fassung) wird als
        // gescheitert gezählt, nicht verschluckt: Die Summenprobe in
        // `engineBilanzPruefen` meldet ihn dann ohnehin.
        else zahlen.unexpected += 1;
      }
    }
    for (const unter of suite.suites ?? []) besuchen(unter);
  };
  for (const suite of b.suites ?? []) besuchen(suite);

  return { gesamt: b.stats, jeEngine, engines: konfiguriert.length > 0 ? konfiguriert : Object.keys(jeEngine) };
}

/** Den Bericht von der Platte lesen; fehlt er oder ist er kaputt, `null`. */
export function browserBerichtLesen(pfad: string): BrowserBilanz | null {
  if (!existsSync(pfad)) return null;
  try {
    return browserBilanzAusBericht(JSON.parse(readFileSync(pfad, 'utf8')));
  } catch {
    return null;
  }
}

/**
 * Die Browserbilanz als Tor: dieselbe Regel wie `browserBilanzPruefen`
 * (`testbilanz.ts`) für die Summe, und dazu je Engine.
 *
 * `jedeEngine` verlangt, dass **jede** konfigurierte Engine mindestens einen
 * bestandenen Fall hat. Richtig für die volle Reihe: Eine Engine, die nichts
 * gefahren hat, ist keine geprüfte Engine, auch wenn die Summe grün ist.
 * Falsch für einen Lauf über eine einzelne Datei (`e2e:stress -- --datei`),
 * die nur Chromium betrifft — dort wird nur geprüft, was lief.
 *
 * Die Summenprobe fängt ein geändertes Berichtsformat: Passen die Zahlen je
 * Engine nicht zu `stats`, ist die Zählung je Engine nicht belastbar, und
 * das wird gesagt, statt falsche Zahlen in einen Nachweis zu schreiben.
 */
export function engineBilanzPruefen(bilanz: BrowserBilanz | null, optionen: { jedeEngine: boolean }): string[] {
  if (!bilanz) return browserBilanzPruefen(null);
  const gruende = [...browserBilanzPruefen(bilanz.gesamt)];

  const summe = leer();
  for (const zahlen of Object.values(bilanz.jeEngine)) {
    for (const k of Object.keys(summe) as (keyof EngineZahlen)[]) summe[k] += zahlen[k];
  }
  const abweichung = (Object.keys(summe) as (keyof EngineZahlen)[]).filter((k) => summe[k] !== (bilanz.gesamt[k] ?? 0));
  if (abweichung.length > 0) {
    gruende.push(`Zählung je Engine passt nicht zur Gesamtzahl (${abweichung.join(', ')}) — hat sich das Berichtsformat von Playwright geändert?`);
  }

  for (const engine of bilanz.engines) {
    const zahlen = bilanz.jeEngine[engine] ?? leer();
    const lief = zahlen.expected + zahlen.unexpected + zahlen.flaky + zahlen.skipped > 0;
    if (!optionen.jedeEngine && !lief) continue;
    for (const grund of browserBilanzPruefen(zahlen)) gruende.push(`${engine}: ${grund}`);
  }
  return gruende;
}

/** Eine Zeile je Engine für die Ausgabe: „chromium 52 bestanden · 0 gescheitert · …“. */
export function engineZeilen(bilanz: BrowserBilanz): string[] {
  return bilanz.engines.map((engine) => {
    const z = bilanz.jeEngine[engine] ?? leer();
    return `${engine.padEnd(9)} ${String(z.expected).padStart(4)} bestanden · ${z.unexpected} gescheitert · ${z.skipped} übersprungen · ${z.flaky} wackelig`;
  });
}

// ---------------------------------------------------------------------------
//  Der Release-Nachweis
// ---------------------------------------------------------------------------

export interface Schrittergebnis {
  schritt: string;
  ok: boolean;
  dauerMs: number;
  hinweis?: string;
}

/** Was `verify.ts` nach einem Lauf ablegt, wenn `CLENARIS_PRUEFWEG_BILANZ` gesetzt ist. */
export interface Laufbilanz {
  modus: Modus;
  ok: boolean;
  schritte: Schrittergebnis[];
  browser: BrowserBilanz | null;
}

/** Ein Lauf der Stressreihe, wie `e2e-stress.ts` ihn in seinen Bericht schreibt. */
export interface Stresslauf {
  nummer: number;
  bestanden: number;
  fehlgeschlagen: number;
  uebersprungen: number;
  wackelig: number;
  dauerSekunden: number;
  hydrationsartefakte: number;
  exitcode: number;
  jeEngine: Record<string, EngineZahlen>;
  /** Warum der Lauf rot ist; leer heisst grün. */
  gruende: string[];
}

export interface Stressbericht {
  port: string;
  datei: string | null;
  laeufe: number;
  ergebnisse: Stresslauf[];
}

export interface ReleaseNachweis {
  art: 'clenaris-release-nachweis';
  format: 1;
  commit: string;
  /** `BUILD_ID` des Baus, gegen den Kern und Stressreihe liefen. */
  buildId: string | null;
  start: string;
  ende: string;
  kern: { ok: true; schritte: Schrittergebnis[]; browser: { gesamt: BrowserZahlen; jeEngine: Record<string, EngineZahlen> } };
  stress: { laeufe: number; gruen: number; ergebnisse: Stresslauf[] };
}

export interface NachweisEingabe {
  commit: string;
  buildId: string | null;
  start: Date;
  ende: Date;
  kern: Laufbilanz | null;
  stress: Stressbericht | null;
}

/** Ist ein Stresslauf grün? Dieselbe Regel wie in `e2e-stress.ts`, hier als Probe des Berichts. */
export function stresslaufGruen(lauf: Stresslauf): boolean {
  return (
    lauf.exitcode === 0 &&
    lauf.gruende.length === 0 &&
    lauf.hydrationsartefakte === 0 &&
    lauf.bestanden > 0 &&
    lauf.fehlgeschlagen === 0 &&
    lauf.uebersprungen === 0 &&
    lauf.wackelig === 0
  );
}

/**
 * Den Nachweis bauen — oder sagen, warum es keinen gibt.
 *
 * Geprüft wird hier noch einmal, was die Läufe selbst schon entschieden
 * haben. Das ist Absicht: Die Datei ist das, was nach dem Lauf übrig bleibt
 * und später vorgezeigt wird. Sie soll aus sich heraus stimmen, nicht nur,
 * weil der Aufrufer vorher richtig abgebrochen hat.
 */
export function releaseNachweisBauen(e: NachweisEingabe): { nachweis: ReleaseNachweis; gruende: [] } | { nachweis: null; gruende: string[] } {
  const gruende: string[] = [];
  if (!COMMIT_MUSTER.test(e.commit)) gruende.push(`Kein gültiger Commit („${e.commit}“) — ein Nachweis ohne Commit belegt nichts.`);

  // Die drei Engines stehen hier fest und werden nicht dem Bericht
  // entnommen: Fiele eine Engine aus `playwright.config.ts`, meldete der
  // Bericht sie gar nicht erst als konfiguriert — und ein Nachweis ohne
  // WebKit sähe aus wie einer mit.
  const ohneBestandenenFall = (jeEngine: Record<string, EngineZahlen> | undefined) =>
    ENGINES.filter((engine) => (jeEngine?.[engine]?.expected ?? 0) === 0);

  if (!e.kern) gruende.push('Keine Bilanz des Kerns — der volle Prüfweg im Abzug hat keine Zahlen hinterlassen.');
  else {
    if (!e.kern.ok || e.kern.schritte.some((s) => !s.ok)) gruende.push('Der Kern ist nicht bestanden.');
    if (e.kern.schritte.length === 0) gruende.push('Der Kern nennt keinen einzigen Schritt.');
    gruende.push(...engineBilanzPruefen(e.kern.browser, { jedeEngine: true }).map((g) => `Kern, Browserreihe: ${g}`));
    for (const engine of e.kern.browser ? ohneBestandenenFall(e.kern.browser.jeEngine) : []) {
      gruende.push(`Kern, Browserreihe: ${engine} ohne einen bestandenen Fall.`);
    }
  }

  if (!e.stress) gruende.push('Kein Bericht der Stressreihe.');
  else {
    if (e.stress.laeufe !== STRESS_LAEUFE || e.stress.ergebnisse.length !== STRESS_LAEUFE) {
      gruende.push(`Die Stressreihe hat ${e.stress.ergebnisse.length} von verlangten ${STRESS_LAEUFE} Läufen.`);
    }
    if (e.stress.datei) gruende.push(`Die Stressreihe lief nur über ${e.stress.datei}, nicht über die ganze Browserreihe.`);
    const rot = e.stress.ergebnisse.filter((l) => !stresslaufGruen(l));
    if (rot.length > 0) gruende.push(`Stressläufe rot: ${rot.map((l) => l.nummer).join(', ')}.`);
    for (const lauf of e.stress.ergebnisse) {
      for (const engine of ohneBestandenenFall(lauf.jeEngine)) gruende.push(`Stresslauf ${lauf.nummer}: ${engine} ohne einen bestandenen Fall.`);
    }
  }

  if (!(e.ende.getTime() >= e.start.getTime())) gruende.push('Das Ende liegt vor dem Anfang.');
  if (gruende.length > 0 || !e.kern || !e.stress) return { nachweis: null, gruende };

  const browser = e.kern.browser!;
  return {
    gruende: [],
    nachweis: {
      art: 'clenaris-release-nachweis',
      format: 1,
      commit: e.commit,
      buildId: e.buildId,
      start: e.start.toISOString(),
      ende: e.ende.toISOString(),
      kern: { ok: true, schritte: e.kern.schritte, browser: { gesamt: browser.gesamt, jeEngine: browser.jeEngine } },
      stress: { laeufe: e.stress.laeufe, gruen: e.stress.ergebnisse.length, ergebnisse: e.stress.ergebnisse },
    },
  };
}

/**
 * Den Nachweis nach `verzeichnis/release-nachweis.json` schreiben — **nur**
 * im Modus `release`. Jeder andere Modus bekommt `null` und keine Datei:
 * Ein Teilweg darf nicht einmal versehentlich eine Datei hinterlassen, die
 * wie ein Nachweis aussieht.
 */
export function releaseNachweisSchreiben(modus: Modus, verzeichnis: string, nachweis: ReleaseNachweis): string | null {
  if (!abschluss(modus).nachweis) return null;
  mkdirSync(verzeichnis, { recursive: true });
  const pfad = join(verzeichnis, RELEASE_NACHWEIS_DATEI);
  writeFileSync(pfad, `${JSON.stringify(nachweis, null, 2)}\n`, 'utf8');
  return pfad;
}
