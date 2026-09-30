import 'server-only';

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { istPruefumgebung } from '@/lib/security/malware';

/**
 * Prüfanbieter für den KI-Textassistenten (2026-09-29).
 *
 * Die Browserprüfung des Textassistenten braucht eine Antwort — aber keine
 * echte KI: Eine Prüfreihe, die Texte an einen Anbieter schickt, ist nicht
 * deterministisch, kostet Geld und trägt Prüftexte hinaus. Dieser Anbieter
 * antwortet mit vorgegebenen Texten und merkt sich, **was er bekommen hat**
 * (nach dem Ausgangsfilter) — so kann die Prüfreihe auch belegen, dass
 * Kontaktangaben ersetzt beim Anbieter ankommen.
 *
 * **Nur in einer Prüfumgebung und nur auf ausdrücklichen Wunsch.** Aktiv ist
 * er ausschliesslich, wenn
 *
 *  • `istPruefumgebung()` gilt — Testzwischenspeicher gesetzt **und** eine
 *    Datenbank, deren Name sie als Test-/Wegwerfdatenbank ausweist (dieselbe
 *    Doppelbedingung wie beim Testprüfer für Schadsoftware), und
 *  • die Prüfreihe die Schalterdatei `ki-pruefanbieter.json` in diesem
 *    Zwischenspeicher angelegt hat.
 *
 * Ohne Schalterdatei bleibt alles wie ohne Anbieter — `text-assist.test.ts`
 * prüft genau das (503 ohne Anbieter) und darf davon nichts merken. Eine
 * echte Auslieferung erfüllt die erste Bedingung nie.
 */

const DATEI = 'ki-pruefanbieter.json';

interface Zustand {
  /** Antworten der Reihe nach; „Erneut generieren" bekommt die nächste. */
  antworten: string[];
  aufrufe: number;
  /** Die Anfrage, wie sie den Prozess verlassen hätte (nach dem Ausgangsfilter). */
  letzteAnfrage?: string;
}

function schalter(): string | null {
  const verzeichnis = process.env.CLENARIS_TEST_CACHE_DIR?.trim();
  return verzeichnis ? join(verzeichnis, DATEI) : null;
}

export function pruefanbieterAktiv(): boolean {
  if (!istPruefumgebung()) return false;
  const datei = schalter();
  return Boolean(datei && existsSync(datei));
}

export function pruefantwort(anfrage: string): string {
  const datei = schalter();
  if (!datei || !pruefanbieterAktiv()) throw new Error('Prüfanbieter nicht aktiv.');
  const zustand = JSON.parse(readFileSync(datei, 'utf8')) as Zustand;
  if (!Array.isArray(zustand.antworten) || zustand.antworten.length === 0) {
    throw new Error('Prüfanbieter ohne Antworten.');
  }
  const antwort = zustand.antworten[zustand.aufrufe % zustand.antworten.length]!;
  writeFileSync(datei, JSON.stringify({ ...zustand, aufrufe: zustand.aufrufe + 1, letzteAnfrage: anfrage }), 'utf8');
  return antwort;
}
