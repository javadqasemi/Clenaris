/**
 * Die Bilanz eines `node:test`-Laufs lesen und als Freigabetor bewerten
 * (N-08, 2026-09-27).
 *
 * ---------------------------------------------------------------------------
 *  Warum ein eigenes Modul
 * ---------------------------------------------------------------------------
 *
 * Zwei Stellen entscheiden, ob eine Prüfreihe „grün" ist: die Sicherheitsreihen
 * in `scripts/security-check.ts` und die ganze Reihe in `scripts/verify.ts`.
 * Beide sahen bis hierher nur auf `# fail` bzw. den Exitcode. Ein Fall, der
 * sich mit `t.skip()` verabschiedet, ist für `node:test` aber kein Fehlschlag —
 * der Lauf endet mit 0, und „bestanden" hiess damit auch „gar nicht geprüft".
 * Der Lauf vom 2026-09-27 hatte zufällig null übersprungene Fälle; erzwungen
 * hat das niemand. Genau die Lücke, die `security-check.ts` bei „nicht geprüft"
 * schon geschlossen hatte, stand hier noch offen.
 *
 * Eine Regel, einmal geschrieben und direkt geprüft
 * (`tests/api/pruefbilanz.test.ts`): Wer zählt, zählt überall gleich.
 *
 * ---------------------------------------------------------------------------
 *  Was als Fehlschlag gilt — und warum auch Vorbedingungen
 * ---------------------------------------------------------------------------
 *
 * Jeder übersprungene, offene (`todo`) oder abgebrochene Fall. Auch die, die
 * sich mit „kein Zugang zur Testdatenbank" oder „Postausgang fehlt"
 * überspringen: Das sind Vorbedingungen der Freigabereihe, keine
 * Eigenschaften des Produkts. Fehlen sie, ist der Lauf keine Freigabe, und das
 * soll er laut sagen, statt grün zu enden. Ein Fall, der von einer *externen*
 * Fähigkeit abhängt (ein echter KI-Anbieter, ein Gerät), gehört in eine eigene
 * externe Reihe — nicht als Überspringen in die Freigabereihe.
 *
 * Und: **keine Zusammenfassung gefunden ist ein Fehlschlag.** Ein Lauf, der
 * vor der Bilanz abstürzt oder dessen Ausgabe abgeschnitten wurde, beweist
 * nichts — auch nicht „null übersprungen".
 *
 * Ohne Abhängigkeiten und ohne Pfad-Aliasse, damit die Prüfreihe es direkt
 * laden kann.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface Testbilanz {
  /** Wurde eine Schlusszusammenfassung gefunden? Ohne sie ist nichts bewiesen. */
  gefunden: boolean;
  tests: number;
  bestanden: number;
  gescheitert: number;
  abgebrochen: number;
  uebersprungen: number;
  offen: number;
  /** Namen der übersprungenen oder offenen Fälle, soweit die Ausgabe sie nennt. */
  uebersprungeneFaelle: string[];
}

// Farbcodes des Spec-Berichts — sie stehen zwischen Zeichen und Zahl.
// eslint-disable-next-line no-control-regex
const FARBEN = /\u001b\[[0-9;]*m/g;

/**
 * Die Bilanz aus der Ausgabe lesen — TAP (`# skipped 3`) **und** Spec
 * (`ℹ skipped 3`).
 *
 * Beide, weil `node:test` den Bericht nach Umgebung wählt: Bis Node 22 TAP,
 * sobald die Ausgabe kein Terminal ist, danach je nach Fassung Spec. Ein
 * Leser, der nur eine Form kennt, meldete nach einem Node-Wechsel still
 * „keine Zusammenfassung" — oder schlimmer, lese nur `# fail`.
 *
 * Gezählt wird doppelt: die Zusammenfassung und die einzelnen Zeilen mit
 * `# SKIP`/`# TODO` (TAP) bzw. `﹣` (Spec). Massgebend ist der grössere Wert —
 * ein übersprungener `describe`-Block erscheint je nach Fassung nicht in der
 * Summe der Fälle, wohl aber als eigene Zeile.
 */
export function testbilanzLesen(ausgabe: string): Testbilanz {
  const text = ausgabe.replace(FARBEN, '');
  const summe: Record<string, number> = {};
  for (const m of text.matchAll(/^[ \t]*(?:#|ℹ)[ \t]+(tests|pass|fail|cancelled|skipped|todo)[ \t]+(\d+)[ \t]*$/gm)) {
    // Die letzte Nennung gilt — die Schlussbilanz steht am Ende.
    summe[m[1]!] = Number(m[2]);
  }
  const gefunden = 'tests' in summe && 'pass' in summe && 'fail' in summe;

  const faelle: string[] = [];
  let zeilenSkip = 0;
  let zeilenTodo = 0;
  for (const m of text.matchAll(/^[ \t]*(?:not )?ok \d+ - (.*?)[ \t]+#[ \t]+(SKIP|TODO)\b.*$/gim)) {
    if (m[2]!.toUpperCase() === 'SKIP') zeilenSkip += 1;
    else zeilenTodo += 1;
    faelle.push(m[1]!.trim());
  }
  for (const m of text.matchAll(/^[ \t]*﹣[ \t]+(.*)$/gm)) {
    zeilenSkip += 1;
    faelle.push(m[1]!.trim());
  }

  return {
    gefunden,
    tests: summe.tests ?? 0,
    bestanden: summe.pass ?? 0,
    gescheitert: summe.fail ?? 0,
    abgebrochen: summe.cancelled ?? 0,
    uebersprungen: Math.max(summe.skipped ?? 0, zeilenSkip),
    offen: Math.max(summe.todo ?? 0, zeilenTodo),
    uebersprungeneFaelle: faelle,
  };
}

/**
 * Die Bilanz als Tor: leer heisst bestanden, sonst je Grund ein Satz.
 *
 * `gescheitert` steht mit darin, obwohl der Exitcode es schon sagt — die
 * Aufrufer sollen nicht zwei Quellen zusammensetzen müssen, um eine Frage zu
 * beantworten.
 */
export function bilanzPruefen(b: Testbilanz): string[] {
  if (!b.gefunden) return ['Keine Schlusszusammenfassung des Testlaufs gefunden — der Lauf ist abgebrochen oder die Ausgabe unvollständig.'];
  const gruende: string[] = [];
  if (b.tests === 0) gruende.push('Der Lauf enthielt keinen einzigen Fall.');
  if (b.gescheitert > 0) gruende.push(`${b.gescheitert} Fall/Fälle gescheitert.`);
  if (b.abgebrochen > 0) gruende.push(`${b.abgebrochen} Fall/Fälle abgebrochen.`);
  if (b.uebersprungen > 0) {
    gruende.push(
      `${b.uebersprungen} Fall/Fälle übersprungen — in der Freigabereihe ist jedes Überspringen ein Fehlschlag` +
        (b.uebersprungeneFaelle.length ? `: ${b.uebersprungeneFaelle.slice(0, 10).join('; ')}` : '.'),
    );
  }
  if (b.offen > 0) gruende.push(`${b.offen} Fall/Fälle als „todo" markiert.`);
  return gruende;
}

/**
 * Die Bilanz der Browserreihe als Tor — aus dem JSON-Bericht von Playwright
 * (`stats`), dieselbe Regel wie `bilanzPruefen` (2026-09-27, N-08).
 *
 * Playwright endet mit 0, wenn Fälle sich per `test.skip()` verabschieden,
 * und ein Fall, der erst im zweiten Anlauf besteht, heisst `flaky` — beides
 * sieht der Exitcode nicht. Ohne Bericht gibt es keine Zahlen und damit keinen
 * Beweis. Eine eigene, reine Funktion, damit die Regel geprüft werden kann,
 * ohne eine Browserreihe zu starten (`pruefbilanz.test.ts`).
 */
export interface BrowserZahlen {
  expected?: number;
  skipped?: number;
  unexpected?: number;
  flaky?: number;
}

export function browserBilanzPruefen(stats: BrowserZahlen | null | undefined): string[] {
  if (!stats) return ['Kein JSON-Bericht der Browserreihe — ohne Zahlen ist nichts bewiesen.'];
  const gruende: string[] = [];
  if ((stats.expected ?? 0) === 0) gruende.push('Kein einziger Browserfall bestanden.');
  if ((stats.skipped ?? 0) > 0) gruende.push(`${stats.skipped} Browserfall/-fälle übersprungen.`);
  if ((stats.flaky ?? 0) > 0) gruende.push(`${stats.flaky} Browserfall/-fälle wackelig.`);
  if ((stats.unexpected ?? 0) > 0) gruende.push(`${stats.unexpected} Browserfall/-fälle gescheitert.`);
  return gruende;
}

/**
 * Konfigurierte Prüfdateien auflösen. Eine fehlende Datei wird **gemeldet**,
 * nicht weggefiltert: Bis 2026-09-27 stand hier `filter(existsSync)`, und eine
 * umbenannte Sicherheitsreihe verschwand still aus dem Lauf — der Rest blieb
 * grün, und niemand merkte, dass die Mandantenprüfung nicht mehr lief.
 */
export function konfigurierteDateien(wurzel: string, dateien: readonly string[]): { vorhanden: string[]; fehlend: string[] } {
  const vorhanden: string[] = [];
  const fehlend: string[] = [];
  for (const d of dateien) (existsSync(join(wurzel, d)) ? vorhanden : fehlend).push(d);
  return { vorhanden, fehlend };
}
