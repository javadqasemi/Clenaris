import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DIMENSIONEN, literaleAusQuelltext, matrizenPruefen, titelAusQuelltext } from '../../scripts/security/testmatrix';

/**
 * Die Belegkette der Abdeckungsmatrizen (2026-09-30).
 *
 * Direkt importiert wie `pruefbilanz.test.ts`: Geprüft wird die Regel, nach
 * der `scripts/testmatrix-pruefen.ts` (Schritt „Testmatrix belegt“ in
 * `verify:static`) einen Matrixbeleg als gefunden wertet — kein Server, keine
 * Datenbank.
 *
 * Gegen den alten Stand scheitert der erste Fall: Dort genügte
 * `inhalt.includes(titel)`, und ein Titel, der nur noch in einem Kommentar
 * stand, galt als Beleg. Der dritte Fall hätte gegen den alten Stand der
 * Matrizen gescheitert — zwei Belege zeigten auf den umbenannten Fall
 * „fünfzig gleichzeitige Erneuerungen: genau eine gelingt …“, einer auf einen
 * Tabelleneintrag der Rechtematrix, der kein Titel ist.
 *
 * Der vierte Fall scheitert gegen den ersten Stand der strengen Regel: Dort
 * zählte an einem Beleg nur der Titel, und die Vorlage eines
 * tabellengetriebenen Falls (`${role}: …`) belegte jede Zeile der Tabelle —
 * auch eine, die es nicht mehr gab. Ein Zusatzfeld `eintrag` wurde still
 * übergangen.
 */

/**
 * Eine Wurzel mit genau den beiden Matrizen und einer Testdatei. `eintrag`
 * wird nur gesetzt, wenn er übergeben ist — auch als leere Zeichenkette,
 * denn gerade die soll als Formfehler auffallen.
 */
function wurzelMit(quelltext: string, belegTitel: string, eintrag?: string): string {
  const wurzel = mkdtempSync(join(tmpdir(), 'clenaris-matrix-'));
  mkdirSync(join(wurzel, 'security'), { recursive: true });
  mkdirSync(join(wurzel, 'tests', 'api'), { recursive: true });
  writeFileSync(join(wurzel, 'tests', 'api', 'beispiel.test.ts'), quelltext);
  const nichtZutreffend = { status: 'nicht_zutreffend', grund: 'nur für diese Prüfung' };
  const dimensionen = Object.fromEntries(DIMENSIONEN.map((d) => [d, nichtZutreffend]));
  const beleg = { datei: 'tests/api/beispiel.test.ts', test: belegTitel, ...(eintrag !== undefined ? { eintrag } : {}) };
  dimensionen.happyPath = { status: 'abgedeckt', belege: [beleg] } as never;
  writeFileSync(join(wurzel, 'security', 'testmatrix.json'), JSON.stringify({ funktionen: [{ id: 'beispiel', name: 'Beispiel', dimensionen }] }));
  writeFileSync(join(wurzel, 'security', 'sicherheitsmatrix.json'), JSON.stringify({ klassen: [] }));
  return wurzel;
}

describe('Belege der Abdeckungsmatrizen', () => {
  it('ein Titel nur im Kommentar gilt nicht als Beleg', () => {
    const quelltext = [
      "import { it } from 'node:test';",
      '// Früher hiess der Fall: it(\'genau eine gelingt\', …) — umbenannt.',
      '/* describe("genau eine gelingt", () => {}) */',
      "const meldung = \"it('genau eine gelingt')\";",
      "it('genau eine rotiert', () => {});",
    ].join('\n');

    assert.deepEqual(titelAusQuelltext(quelltext), ['genau eine rotiert'], 'nur der ausgeführte Aufruf liefert einen Titel');

    const wurzel = wurzelMit(quelltext, 'genau eine gelingt');
    try {
      const ergebnis = matrizenPruefen(wurzel);
      assert.equal(ergebnis.fehler.length, 1, ergebnis.fehler.join(' | '));
      assert.match(ergebnis.fehler[0]!, /Titel nicht gefunden/);
      assert.match(ergebnis.fehler[0]!, /nicht als Titel eines it\/test\/describe-Aufrufs/, 'die Meldung sagt, dass der Text nur erwähnt ist');
      assert.match(ergebnis.fehler[0]!, /ähnlichster Titel: „genau eine rotiert“/, 'die Meldung schlägt den umbenannten Fall vor');
    } finally {
      rmSync(wurzel, { recursive: true, force: true });
    }

    // Die Gegenprobe: Derselbe Aufbau mit dem echten Titel besteht, und ein
    // Bruchstück des Titels belegt nichts.
    const echt = wurzelMit(quelltext, 'genau eine rotiert');
    const bruchstueck = wurzelMit(quelltext, 'genau eine');
    try {
      assert.deepEqual(matrizenPruefen(echt).fehler, []);
      assert.equal(matrizenPruefen(bruchstueck).fehler.length, 1, 'ein Teil eines Titels ist kein Beleg');
    } finally {
      rmSync(echt, { recursive: true, force: true });
      rmSync(bruchstueck, { recursive: true, force: true });
    }
  });

  it('Titel in allen drei Anführungsformen werden gefunden', () => {
    const quelltext = [
      "import { describe, it } from 'node:test';",
      "import { test } from '@playwright/test';",
      "describe('einfache Anführung — mit \"doppelten\" darin', () => {",
      // Eine Maskierung beendet die Zeichenkette nicht und bleibt roh stehen.
      '  it("doppelte Anführung — mit \\"maskierten\\" darin", () => {});',
      // Eine Vorlage wird roh zitiert, mit ihrem Platzhalter; der Ausdruck im
      // Platzhalter darf selbst Zeichenketten und Klammern enthalten.
      "  for (const rolle of ROLLEN) it(`${rolle}: ${erlaubt[rolle] ? 'darf' : 'darf nicht'}`, () => {});",
      '});',
      "test.describe('Playwright-Gruppe', () => {",
      '  test(',
      "    'Titel auf der nächsten Zeile',",
      '    async () => {',
      "      await test.step(`Schritt ${1 + 1}`, async () => {});",
      '      const n = anzahl / 2; const muster = /it\\(\'kein Titel\'\\)/;',
      "      muster.test('auch kein Titel'); regex.test(\"ebenso wenig\");",
      '    },',
      '  );',
      "  test.skip('übersprungen belegt nichts', () => {});",
      '});',
    ].join('\n');

    assert.deepEqual(titelAusQuelltext(quelltext), [
      'einfache Anführung — mit "doppelten" darin',
      'doppelte Anführung — mit \\"maskierten\\" darin',
      "${rolle}: ${erlaubt[rolle] ? 'darf' : 'darf nicht'}",
      'Playwright-Gruppe',
      'Titel auf der nächsten Zeile',
      'Schritt ${1 + 1}',
    ]);
  });

  it('ein Tabelleneintrag als Zusatzbeleg zählt nur als Zeichenkette im Code', () => {
    // Aufgebaut wie die Rechtematrix: Der Gruppentitel entsteht zur Laufzeit,
    // zitierbar ist nur die Vorlage des Falls, und die gilt für jede Zeile.
    const quelltext = [
      "import { describe, it } from 'node:test';",
      "const MATRIX = [{ name: 'POST /api/leads — Anfrage erfassen' }];",
      "// Früher stand hier auch 'DELETE /api/leads — Anfrage löschen'.",
      'for (const entry of MATRIX) {',
      '  describe(entry.name, () => {',
      "    for (const role of ROLLEN) it(`${role}: ${erlaubt ? 'darf' : 'darf nicht'}`, () => {});",
      '  });',
      '}',
    ].join('\n');
    const vorlage = "${role}: ${erlaubt ? 'darf' : 'darf nicht'}";

    const literale = literaleAusQuelltext(quelltext);
    assert.ok(literale.includes('POST /api/leads — Anfrage erfassen'), 'die Tabellenzeile ist ein Literal im Code');
    assert.ok(!literale.includes('DELETE /api/leads — Anfrage löschen'), 'ein Literal im Kommentar ist keines');

    const faelle = {
      vorhanden: wurzelMit(quelltext, vorlage, 'POST /api/leads — Anfrage erfassen'),
      nurKommentar: wurzelMit(quelltext, vorlage, 'DELETE /api/leads — Anfrage löschen'),
      bruchstueck: wurzelMit(quelltext, vorlage, 'POST /api/leads'),
      leer: wurzelMit(quelltext, vorlage, ''),
    };
    try {
      assert.deepEqual(matrizenPruefen(faelle.vorhanden).fehler, []);

      const kommentar = matrizenPruefen(faelle.nurKommentar).fehler;
      assert.equal(kommentar.length, 1, kommentar.join(' | '));
      assert.match(kommentar[0]!, /Eintrag nicht gefunden/);
      assert.match(kommentar[0]!, /nicht als Zeichenkette im Code/, 'die Meldung sagt, dass die Zeile nur erwähnt ist');

      assert.equal(matrizenPruefen(faelle.bruchstueck).fehler.length, 1, 'ein Teil einer Tabellenzeile ist kein Beleg');

      const leer = matrizenPruefen(faelle.leer).fehler;
      assert.equal(leer.length, 1, leer.join(' | '));
      assert.match(leer[0]!, /„eintrag“ ist leer/, 'ein leerer Zusatzbeleg wäre immer gefunden — er ist ein Formfehler');
    } finally {
      for (const wurzel of Object.values(faelle)) rmSync(wurzel, { recursive: true, force: true });
    }
  });

  it('beide Matrizen sind vollständig belegt', () => {
    const ergebnis = matrizenPruefen(join(__dirname, '..', '..'));
    assert.deepEqual(ergebnis.fehler, [], `kaputte Belege:\n${ergebnis.fehler.join('\n')}`);
    assert.equal(ergebnis.matrizen.length, 2);
    for (const m of ergebnis.matrizen) {
      assert.ok(m.zaehler.abgedeckt > 0, `${m.datei}: keine einzige abgedeckte Stelle — die Matrix wurde nicht gelesen`);
    }
    assert.ok(ergebnis.gelesen > 0, 'keine Testdatei gelesen');
  });
});
