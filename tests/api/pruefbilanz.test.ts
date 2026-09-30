import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { abzugsbefundeSichern, laufspurenSichern } from '../../scripts/security/befundsicherung';
import { statusMitPflichtteil } from '../../scripts/security/pflichtabgleich';
import { bilanzPruefen, browserBilanzPruefen, konfigurierteDateien, testbilanzLesen } from '../../scripts/security/testbilanz';

/**
 * Das Freigabetor zählt übersprungene Fälle (N-08, 2026-09-27).
 *
 * Direkt importiert wie `sicherheitsbewertung.test.ts`: Geprüft wird die
 * Regel, nach der `security-check.ts` und `verify.ts` einen Testlauf als
 * bestanden werten — nicht ein Testlauf selbst. Die Ausgaben unten sind
 * gekürzte, aber wörtliche Formen dessen, was `node:test` schreibt.
 *
 * Gegen den alten Stand scheitert jeder Fall hier: Dort wurde nur `# fail`
 * gelesen, und fehlende Dateien fielen per `filter(existsSync)` weg.
 */

const TAP_GRUEN = `TAP version 13
# Subtest: Mandanten
ok 1 - Mandanten
  ---
  duration_ms: 12.3
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 50.1
`;

const TAP_UEBERSPRUNGEN = `TAP version 13
# Subtest: löst einen fremden Code nicht auf
ok 1 - löst einen fremden Code nicht auf # SKIP kein Zugang zur Testdatenbank: ECONNREFUSED
  ---
  duration_ms: 0.2
  ...
# Subtest: ein zweiter Fall
ok 2 - ein zweiter Fall
1..2
# tests 2
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 1
# todo 0
`;

const SPEC_UEBERSPRUNGEN = `▶ Scan
  ✔ findet den eigenen Einsatz (12.1ms)
  ﹣ ein Code einer fremden Organisation löst nichts auf (0.1ms) # keine fremde Organisation
▶ Scan (15.2ms)
ℹ tests 2
ℹ suites 1
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 80.2
`;

describe('Bilanz eines Testlaufs', () => {
  it('ein grüner Lauf ohne Überspringen besteht', () => {
    const b = testbilanzLesen(TAP_GRUEN);
    assert.equal(b.gefunden, true);
    assert.equal(b.bestanden, 1);
    assert.deepEqual(bilanzPruefen(b), []);
  });

  it('ein übersprungener Fall (TAP) ist ein Fehlschlag — auch ohne gescheiterten Fall und mit Exitcode 0', () => {
    const b = testbilanzLesen(TAP_UEBERSPRUNGEN);
    assert.equal(b.gescheitert, 0);
    assert.equal(b.uebersprungen, 1);
    const gruende = bilanzPruefen(b);
    assert.equal(gruende.length, 1, gruende.join(' | '));
    assert.match(gruende[0]!, /übersprungen/);
    assert.match(gruende[0]!, /löst einen fremden Code nicht auf/, 'der übersprungene Fall wird beim Namen genannt');
  });

  it('dasselbe im Spec-Bericht, auch mit Farbcodes', () => {
    const farbig = SPEC_UEBERSPRUNGEN.replace(/ℹ skipped 1/, '\u001b[34mℹ skipped 1\u001b[39m');
    const b = testbilanzLesen(farbig);
    assert.equal(b.gefunden, true);
    assert.equal(b.uebersprungen, 1);
    assert.ok(bilanzPruefen(b).some((g) => g.includes('übersprungen')));
  });

  it('ein übersprungener Block zählt, auch wenn die Summe ihn nicht nennt', () => {
    const ausgabe = TAP_GRUEN.replace('ok 1 - Mandanten', 'ok 1 - Mandanten # SKIP Keine Testdatenbank');
    assert.equal(testbilanzLesen(ausgabe).uebersprungen, 1);
  });

  it('todo und abgebrochen sind Fehlschläge', () => {
    const todo = testbilanzLesen(TAP_GRUEN.replace('# todo 0', '# todo 2'));
    assert.ok(bilanzPruefen(todo).some((g) => g.includes('todo')));
    const abgebrochen = testbilanzLesen(TAP_GRUEN.replace('# cancelled 0', '# cancelled 1'));
    assert.ok(bilanzPruefen(abgebrochen).some((g) => g.includes('abgebrochen')));
  });

  it('ohne Schlusszusammenfassung ist nichts bewiesen — auch nicht „null übersprungen"', () => {
    const abgeschnitten = TAP_GRUEN.split('# tests')[0]!;
    const b = testbilanzLesen(abgeschnitten);
    assert.equal(b.gefunden, false);
    assert.equal(bilanzPruefen(b).length, 1);
    assert.equal(bilanzPruefen(testbilanzLesen('')).length, 1);
  });

  it('ein Lauf ohne Fälle besteht nicht', () => {
    const leer = TAP_GRUEN.replace('# tests 1', '# tests 0').replace('# pass 1', '# pass 0');
    assert.ok(bilanzPruefen(testbilanzLesen(leer)).some((g) => g.includes('keinen einzigen Fall')));
  });
});

/**
 * Die Browserreihe (N-08, Rest): Playwright endet mit 0, auch wenn Fälle
 * übersprungen wurden oder erst im zweiten Anlauf bestanden. Die Regel steht
 * als reine Funktion in `testbilanz.ts`; `verify.ts` (voller Weg und
 * `npm run verify:e2e`) wertet damit den JSON-Bericht aus.
 */
describe('Bilanz der Browserreihe', () => {
  it('ein grüner Bericht ohne Übersprungenes besteht', () => {
    assert.deepEqual(browserBilanzPruefen({ expected: 57, skipped: 0, unexpected: 0, flaky: 0 }), []);
  });

  it('ein übersprungener Browserfall ist ein Fehlschlag — auch wenn alle übrigen bestehen', () => {
    assert.ok(browserBilanzPruefen({ expected: 56, skipped: 1, unexpected: 0, flaky: 0 }).some((g) => g.includes('übersprungen')));
  });

  it('ein wackeliger Fall (erst im zweiten Anlauf grün) ist ein Fehlschlag', () => {
    assert.ok(browserBilanzPruefen({ expected: 56, skipped: 0, unexpected: 0, flaky: 1 }).some((g) => g.includes('wackelig')));
  });

  it('ein gescheiterter Fall ist ein Fehlschlag', () => {
    assert.ok(browserBilanzPruefen({ expected: 56, skipped: 0, unexpected: 1, flaky: 0 }).some((g) => g.includes('gescheitert')));
  });

  it('ohne Bericht oder ohne einen einzigen bestandenen Fall ist nichts bewiesen', () => {
    assert.ok(browserBilanzPruefen(null).some((g) => g.includes('Kein JSON-Bericht')));
    assert.ok(browserBilanzPruefen({}).some((g) => g.includes('Kein einziger Browserfall')));
  });
});

describe('Konfigurierte Prüfdateien', () => {
  it('eine konfigurierte, aber fehlende Datei wird gemeldet statt still weggefiltert', () => {
    const wurzel = join(__dirname, '..', '..');
    const { vorhanden, fehlend } = konfigurierteDateien(wurzel, ['tests/api/pruefbilanz.test.ts', 'tests/api/gibt-es-nicht.test.ts']);
    assert.deepEqual(vorhanden, ['tests/api/pruefbilanz.test.ts']);
    assert.deepEqual(fehlend, ['tests/api/gibt-es-nicht.test.ts']);
  });
});

// M2 (2026-09-29): `security:check -- --datenbank` ohne Adresse meldete
// BESTANDEN, nur mit einem Hinweis im Text. Gegen den alten Stand scheitert
// der zweite Fall.
describe('Verlangter Datenbankabgleich', () => {
  it('ohne Verlangen und ohne Befund: bestanden', () => {
    assert.equal(statusMitPflichtteil([], { verlangt: false, gelaufen: false }), 'BESTANDEN');
  });
  it('verlangt, aber nicht gelaufen (keine Adresse): nicht geprüft — nie bestanden', () => {
    assert.equal(statusMitPflichtteil([{ schwere: 'hinweis' }], { verlangt: true, gelaufen: false }), 'NICHT_GEPRUEFT');
  });
  it('verlangt und gelaufen: bestanden; ein blockierender Befund geht in jedem Fall vor', () => {
    assert.equal(statusMitPflichtteil([], { verlangt: true, gelaufen: true }), 'BESTANDEN');
    assert.equal(statusMitPflichtteil([{ schwere: 'blockierend' }], { verlangt: true, gelaufen: false }), 'BEFUND');
  });
});

// RC-20 (2026-09-30): Ein roter Stresslauf verlor seine Spur zweimal — der
// nächste Playwright-Lauf leerte `test-results/`, und `verify:release`
// entfernte danach den ganzen Abzug. Die Fälle spielen genau diese Abfolge
// nach: sichern, dann die Quelle löschen, dann nachsehen, was übrig ist.
// Gegen den alten Stand scheitern sie, weil es nichts gab, das sicherte.
describe('Beweise eines roten Laufs überleben das Aufräumen', () => {
  const abzugAnlegen = () => {
    const abzug = mkdtempSync(join(tmpdir(), 'clenaris-befund-'));
    mkdirSync(join(abzug, 'test-results', 'abmelden-chromium'), { recursive: true });
    writeFileSync(join(abzug, 'test-results', 'abmelden-chromium', 'trace.zip'), 'SPUR');
    mkdirSync(join(abzug, 'hydrationsbefunde'), { recursive: true });
    writeFileSync(join(abzug, 'hydrationsbefunde', 'stress-lauf-4.log'), 'AUSGABE');
    return abzug;
  };

  it('die Spur eines roten Laufs ist nach dem Leeren von test-results noch da', () => {
    const abzug = abzugAnlegen();
    const ziel = join(abzug, 'hydrationsbefunde', 'stress-lauf-4');
    try {
      assert.equal(laufspurenSichern(join(abzug, 'test-results'), ziel), ziel);
      rmSync(join(abzug, 'test-results'), { recursive: true, force: true }); // wie Playwright zu Beginn des nächsten Laufs
      assert.equal(readFileSync(join(ziel, 'abmelden-chromium', 'trace.zip'), 'utf8'), 'SPUR');
    } finally {
      rmSync(abzug, { recursive: true, force: true });
    }
  });

  it('die Beweise des Abzugs sind nach dem Entfernen des Abzugs noch da', () => {
    const abzug = abzugAnlegen();
    const ablage = mkdtempSync(join(tmpdir(), 'clenaris-ablage-'));
    try {
      assert.equal(abzugsbefundeSichern(abzug, ablage).length, 2);
      rmSync(abzug, { recursive: true, force: true }); // wie `verify:release` am Ende
      assert.equal(readFileSync(join(ablage, 'test-results', 'abmelden-chromium', 'trace.zip'), 'utf8'), 'SPUR');
      assert.equal(readFileSync(join(ablage, 'hydrationsbefunde', 'stress-lauf-4.log'), 'utf8'), 'AUSGABE');
    } finally {
      rmSync(abzug, { recursive: true, force: true });
      rmSync(ablage, { recursive: true, force: true });
    }
  });

  it('ohne Beweise entsteht keine leere Ablage', () => {
    const leer = mkdtempSync(join(tmpdir(), 'clenaris-leer-'));
    try {
      assert.equal(laufspurenSichern(join(leer, 'test-results'), join(leer, 'ziel')), null);
      assert.deepEqual(abzugsbefundeSichern(leer, join(leer, 'ablage')), []);
      assert.ok(!existsSync(join(leer, 'ziel')) && !existsSync(join(leer, 'ablage')));
    } finally {
      rmSync(leer, { recursive: true, force: true });
    }
  });
});
