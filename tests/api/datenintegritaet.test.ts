import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { pruefen } from '../../scripts/datenintegritaet';
import { testDb, testDbGrund, testDbSchliessen } from '../helpers/testdb';

/**
 * Wave 24 — die Gleichungen aus `scripts/datenintegritaet.ts` gegen den
 * Bestand der Testdatenbank.
 *
 * Jede andere Reihe prüft, dass ein Weg eine Regel einhält. Diese prüft das
 * Ergebnis aller Wege zusammen: Nach allem, was die Reihen angelegt, bezahlt,
 * storniert und gutgeschrieben haben, muss jeder Saldo aufgehen, keine Nummer
 * doppelt und kein Lager negativ sein. Eine Reihe, die an den Triggern vorbei
 * etwas Inkonsistentes zurücklässt, fällt hier auf — nicht erst in der
 * Produktion.
 *
 * Nur `fehler` lassen den Fall scheitern. `hinweis` (Nummernlücken durch
 * Aufräumen in Prüfreihen, Kundenwert aus Seeds) sind in Testdaten erwartbar;
 * sie werden gezählt, aber nicht bewertet.
 */

after(async () => {
  await testDbSchliessen();
});

describe('Datenintegrität des Bestands', () => {
  it('keine Regelverletzung in Finanzen, Nummern, Lager, Mandantenbezug, Annahmen und Zeiten', async () => {
    const db = testDb();
    assert.ok(db, `kein Zugang zur Testdatenbank: ${testDbGrund()}`);
    const ergebnisse = await pruefen(db);
    assert.ok(ergebnisse.length >= 10, 'die Prüfungen wurden geladen');
    const verletzt = ergebnisse.filter((e) => e.art === 'fehler' && e.anzahl > 0);
    assert.deepEqual(
      verletzt.map((e) => `${e.schluessel}: ${e.anzahl} (${e.beispiele.join(', ')})`),
      [],
    );
  });
});
