import { resolve } from 'node:path';

import { matrizenPruefen } from './security/testmatrix';

/**
 * Prüfung der beiden Abdeckungsmatrizen unter `security/`.
 *
 *   npx tsx scripts/testmatrix-pruefen.ts
 *
 * ---------------------------------------------------------------------------
 *  Wogegen das gebaut ist
 * ---------------------------------------------------------------------------
 *
 * `security/testmatrix.json` und `security/sicherheitsmatrix.json` behaupten
 * je Funktion bzw. Sicherheitsklasse: „Das prüft der Test X in Datei Y.“ Eine
 * solche Behauptung veraltet leise. Ein Test wird umbenannt, weil sein Titel
 * nicht mehr stimmt; eine Datei wird aufgeteilt; ein Fall wird gestrichen,
 * weil er doppelt war. Die Matrix sagt danach weiter „abgedeckt“, und niemand
 * merkt es, bis jemand im Ernstfall den Beleg sucht und ihn nicht findet.
 *
 * Deshalb wird hier nicht nachgezählt, sondern **nachgeschlagen**: Für jeden
 * Beleg muss die Datei existieren und der zitierte Titel einem ausgeführten
 * Testtitel darin **gleich** sein — dem ersten Argument eines `it`, `test`,
 * `describe`, `test.describe` oder `test.step`. Eine Erwähnung im Kommentar
 * oder in einer Meldung zählt seit 2026-09-30 nicht mehr; die Regel und ihre
 * Begründung stehen in `scripts/security/testmatrix.ts`, wo auch
 * `tests/api/testmatrix.test.ts` sie direkt prüft.
 *
 * ---------------------------------------------------------------------------
 *  Was scheitert und was nicht
 * ---------------------------------------------------------------------------
 *
 * **Ein kaputter Beleg scheitert (Exit 1)**, ebenso eine Matrix, die ihre
 * eigene Form verletzt (unbekannter Status, „abgedeckt“ ohne Beleg, Lücke ohne
 * Grund). Das sind Fehler der Matrix, und sie sind billig zu beheben — die
 * Meldung nennt den ähnlichsten vorhandenen Titel.
 *
 * **Lücken scheitern nicht.** Sie werden vollständig ausgegeben, damit sie
 * gesehen werden; warum sie kein Fehlschlag sind, steht bei `matrizenPruefen`.
 *
 * Seit 2026-09-30 ein Schritt von `verify:static` („Testmatrix belegt“) und
 * damit von CI und jedem vollen Prüfweg. Die Wurzel ist das Projekt, in dem
 * dieses Skript liegt, nicht das Arbeitsverzeichnis — sonst prüfte ein Aufruf
 * aus einem Unterordner eine Matrix, die es dort nicht gibt, und meldete
 * „Datei fehlt“ statt der eigentlichen Befunde.
 */

const WURZEL = resolve(__dirname, '..');

const ergebnis = matrizenPruefen(WURZEL);

for (const m of ergebnis.matrizen) {
  console.log(`\n${m.datei}`);
  console.log(
    `  abgedeckt: ${m.zaehler.abgedeckt} · Lücken: ${m.zaehler.luecke} · nicht zutreffend: ${m.zaehler.nicht_zutreffend} · Fehler: ${m.fehler.length}`,
  );
  if (m.luecken.length > 0) {
    console.log('  Lücken:');
    for (const l of m.luecken) console.log(`    - ${l}`);
  }
}

console.log(`\nGelesene Testdateien: ${ergebnis.gelesen}`);

if (ergebnis.fehler.length > 0) {
  console.error(`\n${ergebnis.fehler.length} kaputte Belege oder Formfehler:`);
  for (const f of ergebnis.fehler) console.error(`  ✗ ${f}`);
  process.exit(1);
}

console.log('\nAlle Belege sind ausgeführte Testtitel. Lücken sind gemeldet, nicht gescheitert.');
