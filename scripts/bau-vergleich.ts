/**
 * Zwei Bauten desselben Stands vergleichen (2026-09-30).
 *
 *   npx tsx scripts/bau-vergleich.ts <bauA> <bauB> [--bericht <datei.json>]
 *
 * Ausgang 0: Die beiden Bauverzeichnisse unterscheiden sich nur in den
 *            erwarteten Punkten (Build-ID, Vorschau- und Aktionsschlüssel,
 *            Spurdateien — `scripts/release/bau-vergleich-regeln.ts`).
 * Ausgang 1: jeder andere Unterschied — oder ein Aufruf, der nichts beweisen
 *            kann (fehlendes Verzeichnis, keine `BUILD_ID`). Ein Werkzeug, das
 *            bei falschem Aufruf 0 meldete, liesse ein Tor grün werden, das nie
 *            verglichen hat.
 *
 * Der Ablauf, für den das gedacht ist (beide Bauten im selben Verzeichnis,
 * damit Projektpfad und Bauverzeichnis gleich heissen):
 *
 *   npm run build && mv .next .next-bau-a
 *   npm run build
 *   npx tsx scripts/bau-vergleich.ts .next-bau-a .next --bericht bau-vergleich.json
 *
 * Beide Bauten gegen **dieselbe** Datenbank: Die Website ist vorgerendert, und
 * ein Bau gegen eine andere Datenbank unterscheidet sich zu Recht — das ist
 * genau der Befund, den der Vergleich zeigen soll, wenn er ungewollt ist.
 *
 * Der Bericht (`--bericht`) enthält alle erwarteten und unerwarteten
 * Unterschiede mit Pfad und, bei Inhalten, einen kurzen, geschwärzten Auszug
 * um die erste abweichende Stelle.
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  ERWARTETE_ABWEICHUNGEN,
  baeumeVergleichen,
  berichtBauen,
  verzeichnisQuelle,
  type ErwarteteAbweichung,
} from './release/bau-vergleich-regeln';

const HOECHSTENS = 50;

function main(): number {
  const argumente = process.argv.slice(2);
  const berichtStelle = argumente.indexOf('--bericht');
  const bericht = berichtStelle >= 0 ? argumente[berichtStelle + 1] : undefined;
  if (berichtStelle >= 0 && (!bericht || bericht.startsWith('--'))) {
    console.error('FEHLER: --bericht verlangt einen Dateinamen.');
    return 1;
  }
  const verzeichnisse = argumente.filter((a, i) => !a.startsWith('--') && !(berichtStelle >= 0 && i === berichtStelle + 1));
  if (verzeichnisse.length !== 2) {
    console.error('Aufruf: npx tsx scripts/bau-vergleich.ts <bauA> <bauB> [--bericht <datei.json>]');
    return 1;
  }
  const [a, b] = verzeichnisse.map((v) => resolve(v)) as [string, string];
  for (const v of [a, b]) {
    if (!existsSync(v) || !statSync(v).isDirectory()) {
      console.error(`FEHLER: ${v} ist kein Verzeichnis.`);
      return 1;
    }
  }
  if (a === b) {
    // Ein Verzeichnis mit sich selbst verglichen ist immer gleich — und bewiese nichts.
    console.error('FEHLER: Beide Angaben zeigen auf dasselbe Verzeichnis.');
    return 1;
  }

  let befund;
  try {
    befund = baeumeVergleichen(verzeichnisQuelle(a), verzeichnisQuelle(b));
  } catch (fehler) {
    console.error(`FEHLER: ${fehler instanceof Error ? fehler.message : String(fehler)}`);
    return 1;
  }

  const jeRegel = new Map<ErwarteteAbweichung, number>();
  for (const e of befund.erwartet) for (const art of e.abweichungen) jeRegel.set(art, (jeRegel.get(art) ?? 0) + 1);

  console.log(`Bau A        : ${a} (Build-ID ${befund.buildIdA})`);
  console.log(`Bau B        : ${b} (Build-ID ${befund.buildIdB})`);
  console.log(`Gleich       : ${befund.gleich} Dateien`);
  console.log(`Erwartet     : ${befund.erwartet.length} Dateien`);
  for (const [art, anzahl] of [...jeRegel].sort()) console.log(`  ${String(anzahl).padStart(6)} × ${ERWARTETE_ABWEICHUNGEN[art]}`);
  console.log(`Unerwartet   : ${befund.unerwartet.length} Dateien`);
  for (const u of befund.unerwartet.slice(0, HOECHSTENS)) {
    const art = u.art === 'nur-in-a' ? 'nur in A' : u.art === 'nur-in-b' ? 'nur in B' : `Inhalt ab Byte ${u.stelle}`;
    console.log(`  ${u.pfad} — ${art}`);
    if (u.art === 'inhalt') {
      console.log(`      A: ${u.auszugA}`);
      console.log(`      B: ${u.auszugB}`);
    }
  }
  if (befund.unerwartet.length > HOECHSTENS) console.log(`  … und ${befund.unerwartet.length - HOECHSTENS} weitere (vollständig im Bericht)`);

  if (bericht) {
    const ziel = resolve(bericht);
    mkdirSync(dirname(ziel), { recursive: true });
    writeFileSync(ziel, `${JSON.stringify(berichtBauen({ a, b, befund, erstelltUtc: new Date().toISOString() }), null, 2)}\n`);
    console.log(`Bericht      : ${ziel}`);
  }

  if (befund.unerwartet.length > 0) {
    console.log('ERGEBNIS: unerwartete Unterschiede — die beiden Bauten sind nicht derselbe Bau.');
    return 1;
  }
  console.log('ERGEBNIS: nur erwartete Unterschiede.');
  return 0;
}

process.exitCode = main();
