import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * RB-001 — das Verhalten von `scripts/react-hydrationskorrektur.mjs` in jedem
 * Zustand, den es antreffen kann.
 *
 * Das Skript verändert Framework-Code unter `node_modules`. Das ist nur
 * vertretbar, wenn es **nichts** anfasst, was es nicht eindeutig erkennt.
 * Diese Reihe führt es in einem Wegwerfverzeichnis gegen nachgebaute Dateien
 * aus und prüft Exitcode **und** Dateiinhalt: angewandt genau einmal,
 * wiederholbar, und in jedem unklaren Zustand Abbruch ohne Schreiben.
 *
 * Reine Prüfung ohne Server — sie liest und schreibt nur im Temp-Verzeichnis.
 */

const SKRIPT = resolve('scripts/react-hydrationskorrektur.mjs');
const BETROFFEN = '19.2.0-canary-0bdb9206-20250818';

const ORIGINAL = '    case 5:\n      resetHooksOnUnwind(next);\n    default:';
const KORREKTUR_KERN = 'fiber === hydrationParentFiber &&';

function datei(version: string, rumpf: string): string {
  return [
    '"use strict";',
    'function replaySuspendedUnitOfWork(unitOfWork) {',
    '  var next = unitOfWork;',
    '  switch (next.tag) {',
    rumpf,
    '      unwindInterruptedWork(current, next);',
    '  }',
    '}',
    `exports.version = "${version}";`,
    '',
  ].join('\n');
}

const KORRIGIERT_VON_UPSTREAM = [
  '    case 5:',
  '      resetHooksOnUnwind(next);',
  '      var fiber = next;',
  '      fiber === hydrationParentFiber &&',
  '        (isHydrating',
  '          ? (popToNextHostParent(fiber),',
  '            5 === fiber.tag &&',
  '              null != fiber.stateNode &&',
  '              (nextHydratableInstance = fiber.stateNode))',
  '          : (popToNextHostParent(fiber), (isHydrating = !0)));',
  '    default:',
].join('\n');

const verzeichnisse: string[] = [];

/** Ein Projektverzeichnis mit genau einer React-Kopie; gibt den Dateipfad zurück. */
function projekt(inhalt: string): { wurzel: string; pfad: string } {
  const wurzel = mkdtempSync(join(tmpdir(), 'clenaris-reactkorrektur-'));
  verzeichnisse.push(wurzel);
  const cjs = join(wurzel, 'node_modules', 'next', 'dist', 'compiled', 'react-dom', 'cjs');
  mkdirSync(cjs, { recursive: true });
  const pfad = join(cjs, 'react-dom-client.production.js');
  writeFileSync(pfad, inhalt, 'utf8');
  return { wurzel, pfad };
}

function ausfuehren(wurzel: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [SKRIPT, ...args], { cwd: wurzel, encoding: 'utf8' });
  return { code: r.status, ausgabe: `${r.stdout}${r.stderr}` };
}

const vorkommen = (text: string, teil: string) => text.split(teil).length - 1;

after(() => {
  for (const v of verzeichnisse) rmSync(v, { recursive: true, force: true });
});

describe('React-Hydrationskorrektur — nur, was eindeutig erkannt ist', () => {
  it('bekannte Fassung, Original genau einmal: wird genau einmal korrigiert', () => {
    const { wurzel, pfad } = projekt(datei(BETROFFEN, ORIGINAL));
    const r = ausfuehren(wurzel);
    assert.equal(r.code, 0, r.ausgabe);
    const neu = readFileSync(pfad, 'utf8');
    assert.equal(vorkommen(neu, KORREKTUR_KERN), 1);
    assert.equal(vorkommen(neu, ORIGINAL), 0);
    assert.match(neu, /nextHydratableInstance = fiber\.stateNode/);
  });

  it('ein zweiter Lauf ändert nichts', () => {
    const { wurzel, pfad } = projekt(datei(BETROFFEN, ORIGINAL));
    ausfuehren(wurzel);
    const einmal = readFileSync(pfad, 'utf8');
    const r = ausfuehren(wurzel);
    assert.equal(r.code, 0, r.ausgabe);
    assert.equal(readFileSync(pfad, 'utf8'), einmal);
    assert.match(r.ausgabe, /korrigiert/);
  });

  it('--pruefen meldet eine fehlende Korrektur mit Exit 1 und schreibt nichts', () => {
    const inhalt = datei(BETROFFEN, ORIGINAL);
    const { wurzel, pfad } = projekt(inhalt);
    const r = ausfuehren(wurzel, '--pruefen');
    assert.equal(r.code, 1);
    assert.equal(readFileSync(pfad, 'utf8'), inhalt);
  });

  it('unbekannte Fassung ohne Korrektur: Abbruch, nichts geschrieben', () => {
    const inhalt = datei('19.2.1-canary-deadbeef-20260101', ORIGINAL);
    const { wurzel, pfad } = projekt(inhalt);
    const r = ausfuehren(wurzel);
    assert.equal(r.code, 1);
    assert.match(r.ausgabe, /unbekannte React-Fassung/);
    assert.equal(readFileSync(pfad, 'utf8'), inhalt);
  });

  it('Original doppelt: nicht eindeutig, Abbruch, nichts geschrieben', () => {
    const inhalt = datei(BETROFFEN, `${ORIGINAL}\n${ORIGINAL}`);
    const { wurzel, pfad } = projekt(inhalt);
    const r = ausfuehren(wurzel);
    assert.equal(r.code, 1);
    assert.match(r.ausgabe, /nicht eindeutig/);
    assert.equal(readFileSync(pfad, 'utf8'), inhalt);
  });

  it('Original fehlt bei bekannter Fassung: Abbruch', () => {
    const inhalt = datei(BETROFFEN, '    case 5:\n      somethingElse(next);\n    default:');
    const { wurzel, pfad } = projekt(inhalt);
    const r = ausfuehren(wurzel);
    assert.equal(r.code, 1);
    assert.match(r.ausgabe, /nicht gefunden/);
    assert.equal(readFileSync(pfad, 'utf8'), inhalt);
  });

  it('Original und Korrektur zugleich: Abbruch', () => {
    const inhalt = datei(BETROFFEN, `${KORRIGIERT_VON_UPSTREAM}\n${ORIGINAL}`);
    const { wurzel, pfad } = projekt(inhalt);
    const r = ausfuehren(wurzel);
    assert.equal(r.code, 1);
    assert.equal(readFileSync(pfad, 'utf8'), inhalt);
  });

  it('künftige Fassung, die die Korrektur selbst enthält: erledigt, nichts geschrieben', () => {
    const inhalt = datei('19.3.0', KORRIGIERT_VON_UPSTREAM);
    const { wurzel, pfad } = projekt(inhalt);
    const r = ausfuehren(wurzel, '--pruefen');
    assert.equal(r.code, 0, r.ausgabe);
    assert.match(r.ausgabe, /Korrektur bereits enthalten/);
    assert.equal(readFileSync(pfad, 'utf8'), inhalt);
  });

  it('keine React-Kopie gefunden: Abbruch', () => {
    const wurzel = mkdtempSync(join(tmpdir(), 'clenaris-reactkorrektur-'));
    verzeichnisse.push(wurzel);
    const r = ausfuehren(wurzel);
    assert.equal(r.code, 1);
  });
});
