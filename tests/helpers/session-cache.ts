import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Angemeldete Sitzungen über Testdateien hinweg wiederverwenden.
 *
 * Der Grund ist eine Schutzmassnahme, die richtig arbeitet: Die Anmeldung
 * erlaubt acht Versuche je fünf Minuten und Adresse. Das ist für Menschen
 * grosszügig und für einen Testlauf viel zu wenig — jede Datei läuft in einem
 * eigenen Prozess und meldete bisher alle fünf Konten neu an. Ein voller Lauf
 * kam so auf über fünfzig Anmeldungen, lief in die Bremse und wartete sich
 * durch die vom Server genannten Sperrzeiten.
 *
 * Die naheliegende Abhilfe wäre gewesen, das Limit für Tests hochzusetzen.
 * Dann prüfte der Lauf aber eine Anwendung, die es so nicht gibt. Stattdessen
 * verhalten sich die Tests wie ein Browser: Sie melden sich einmal an und
 * behalten das Cookie.
 *
 * Die Ablage liegt im Temp-Verzeichnis, nicht im Projekt — sie ist ein
 * Zwischenstand des Laufs, kein Artefakt, und sie enthält gültige Sitzungen.
 */

const CACHE_DIR = join(tmpdir(), 'clenaris-tests');
const CACHE_FILE = join(CACHE_DIR, 'sessions.json');

type Store = Record<string, string>;

function read(): Store {
  try {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as Store;
  } catch {
    // Fehlt die Datei oder ist sie unlesbar, gibt es eben nichts zu erben.
    return {};
  }
}

export function cachedJar(key: string): string | undefined {
  return read()[key];
}

export function rememberJar(key: string, jar: string): void {
  const store = read();
  store[key] = jar;
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(store), 'utf8');
  } catch {
    // Lässt sich nicht schreiben, meldet sich der nächste Prozess eben neu an.
  }
}

export function forgetJar(key: string): void {
  const store = read();
  delete store[key];
  try {
    writeFileSync(CACHE_FILE, JSON.stringify(store), 'utf8');
  } catch {
    // siehe oben
  }
}
