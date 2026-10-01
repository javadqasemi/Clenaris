import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { abzugsbefundeSichern, laufspurenSichern } from '../../scripts/security/befundsicherung';
import { statusMitPflichtteil } from '../../scripts/security/pflichtabgleich';
import {
  abschluss,
  browserBilanzAusBericht,
  engineBilanzPruefen,
  MODI,
  RELEASE_NACHWEIS_DATEI,
  releaseNachweisBauen,
  releaseNachweisSchreiben,
  STRESS_LAEUFE,
  TEILPRUEFUNG_EXITCODE,
  TEILPRUEFUNG_ZEILE,
  type BrowserBilanz,
  type Laufbilanz,
  type NachweisEingabe,
  type Stresslauf,
} from '../../scripts/security/pruefweg-abschluss';
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

// ---------------------------------------------------------------------------
//  Browserbilanz je Engine und Release-Semantik (2026-09-30)
// ---------------------------------------------------------------------------

/**
 * Ein Playwright-JSON-Bericht in der Form, die der Berichter `json` schreibt
 * (`playwright/types/testReporter.d.ts`, `JSONReport`): `config.projects`,
 * verschachtelte `suites` mit `specs`, je Fall `projectName` und `status`,
 * und die Summe in `stats`. Gekürzt auf die Felder, die gelesen werden.
 */
function playwrightBericht(faelle: { projekt: string; status: 'expected' | 'unexpected' | 'flaky' | 'skipped' }[], projekte = ['chromium', 'firefox', 'webkit']) {
  const stats = { startTime: '2026-09-30T08:00:00.000Z', duration: 1000, expected: 0, unexpected: 0, flaky: 0, skipped: 0 };
  for (const f of faelle) stats[f.status] += 1;
  return {
    config: { projects: projekte.map((name) => ({ id: name, name })) },
    suites: [
      {
        title: 'beispiel.browser.spec.ts',
        specs: [],
        suites: [{ title: 'Gruppe', specs: faelle.map((f, i) => ({ title: `Fall ${i}`, ok: true, tests: [{ projectName: f.projekt, status: f.status }] })) }],
      },
    ],
    errors: [],
    stats,
  };
}

const GRUENE_FAELLE = [
  { projekt: 'chromium', status: 'expected' },
  { projekt: 'chromium', status: 'expected' },
  { projekt: 'chromium', status: 'expected' },
  { projekt: 'firefox', status: 'expected' },
  { projekt: 'firefox', status: 'expected' },
  { projekt: 'webkit', status: 'expected' },
] as const;

const gruen = (): BrowserBilanz => browserBilanzAusBericht(playwrightBericht([...GRUENE_FAELLE]))!;

function stresslauf(nummer: number, aenderung: Partial<Stresslauf> = {}): Stresslauf {
  return {
    nummer,
    bestanden: 6,
    fehlgeschlagen: 0,
    uebersprungen: 0,
    wackelig: 0,
    dauerSekunden: 300,
    hydrationsartefakte: 0,
    exitcode: 0,
    jeEngine: gruen().jeEngine,
    gruende: [],
    ...aenderung,
  };
}

function vollstaendigeEingabe(): NachweisEingabe {
  const kern: Laufbilanz = {
    modus: 'voll',
    ok: true,
    schritte: [
      { schritt: 'Datenbankschranken (live)', ok: true, dauerMs: 900 },
      { schritt: 'Build', ok: true, dauerMs: 240_000 },
    ],
    browser: gruen(),
  };
  return {
    commit: '9fd662b0c0ffee0c0ffee0c0ffee0c0ffee0c0ff',
    buildId: 'pruefbau-1',
    start: new Date('2026-09-30T08:00:00Z'),
    ende: new Date('2026-09-30T09:10:00Z'),
    kern,
    stress: { port: '3001', datei: null, laeufe: STRESS_LAEUFE, ergebnisse: Array.from({ length: STRESS_LAEUFE }, (_, i) => stresslauf(i + 1)) },
  };
}

describe('Browserbilanz je Engine', () => {
  it('zählt je Engine aus dem JSON-Bericht von Playwright, auch in verschachtelten Gruppen', () => {
    const b = gruen();
    assert.deepEqual(b.engines, ['chromium', 'firefox', 'webkit']);
    assert.deepEqual(b.jeEngine.chromium, { expected: 3, skipped: 0, unexpected: 0, flaky: 0 });
    assert.deepEqual(b.jeEngine.firefox, { expected: 2, skipped: 0, unexpected: 0, flaky: 0 });
    assert.deepEqual(b.jeEngine.webkit, { expected: 1, skipped: 0, unexpected: 0, flaky: 0 });
    assert.deepEqual(engineBilanzPruefen(b, { jedeEngine: true }), []);
  });

  it('eine Engine ohne bestandenen Fall ist in der vollen Reihe ein Fehlschlag, in einer Einzeldatei nicht', () => {
    // Die Summe ist grün — genau das sah die Browser-Bilanz bis hierher allein.
    const nurChromium = browserBilanzAusBericht(playwrightBericht([{ projekt: 'chromium', status: 'expected' }]))!;
    assert.deepEqual(browserBilanzPruefen(nurChromium.gesamt), [], 'die Summe allein ist grün');
    const gruende = engineBilanzPruefen(nurChromium, { jedeEngine: true });
    assert.ok(gruende.some((g) => g.startsWith('firefox:')), gruende.join(' | '));
    assert.ok(gruende.some((g) => g.startsWith('webkit:')), gruende.join(' | '));
    assert.deepEqual(engineBilanzPruefen(nurChromium, { jedeEngine: false }), []);
  });

  it('ein übersprungener Fall wird seiner Engine zugeschrieben, und ohne Bericht ist nichts bewiesen', () => {
    const faelle = [...GRUENE_FAELLE, { projekt: 'webkit', status: 'skipped' } as const];
    const gruende = engineBilanzPruefen(browserBilanzAusBericht(playwrightBericht(faelle)), { jedeEngine: true });
    assert.ok(gruende.some((g) => g.startsWith('webkit:') && g.includes('übersprungen')), gruende.join(' | '));
    assert.ok(engineBilanzPruefen(null, { jedeEngine: true }).some((g) => g.includes('Kein JSON-Bericht')));
    assert.equal(browserBilanzAusBericht({ suites: [] }), null, 'ohne stats kein Bericht');
  });

  it('passt die Zählung je Engine nicht zur Summe, wird das gemeldet statt geglaubt', () => {
    const bericht = playwrightBericht([...GRUENE_FAELLE]);
    bericht.stats.expected += 4; // wie ein Berichtsformat, dessen Fälle nicht mehr gefunden werden
    assert.ok(engineBilanzPruefen(browserBilanzAusBericht(bericht), { jedeEngine: true }).some((g) => g.includes('passt nicht zur Gesamtzahl')));
  });
});

/**
 * Release-Semantik (Vertrag C9). Gegen den alten Stand scheitern die ersten
 * beiden Fälle: `verify:release:core` endete mit „✅ Release-Kern bestanden“
 * und Exitcode 0, und einen Nachweis als Datei gab es in keinem Modus.
 */
describe('Release-Semantik des Prüfwegs', () => {
  it('Teilläufe des Release-Wegs enden nie mit „RELEASE BESTANDEN" und nie mit 0', () => {
    assert.equal(TEILPRUEFUNG_ZEILE, 'TEILPRÜFUNG BESTANDEN — KEIN RELEASE-NACHWEIS', 'der Wortlaut ist Vertrag — Aufrufer suchen danach');
    assert.equal(TEILPRUEFUNG_EXITCODE, 3);
    for (const modus of ['release-kern', 'release-stress'] as const) {
      const ende = abschluss(modus);
      assert.notEqual(ende.code, 0, `${modus} endet mit 0`);
      assert.equal(ende.code, TEILPRUEFUNG_EXITCODE, `${modus}: Exitcode`);
      assert.equal(ende.text.includes('RELEASE BESTANDEN'), false, `${modus} meldet „RELEASE BESTANDEN“`);
      assert.equal(ende.text.includes('✅'), false, `${modus} trägt ein Häkchen`);
      const zeilen = ende.text.trim().split('\n');
      assert.equal(zeilen[zeilen.length - 1], TEILPRUEFUNG_ZEILE, `${modus}: letzte Zeile`);
      assert.equal(ende.nachweis, false);
    }
    // Und umgekehrt: „RELEASE BESTANDEN“ sagt genau ein Modus, mit 0.
    for (const modus of MODI) assert.equal(abschluss(modus).text.includes('RELEASE BESTANDEN'), modus === 'release', modus);
    assert.equal(abschluss('release').code, 0);
  });

  it('nur der Gesamtweg schreibt den Release-Nachweis', () => {
    const gebaut = releaseNachweisBauen(vollstaendigeEingabe());
    assert.deepEqual(gebaut.gruende, []);
    assert.ok(gebaut.nachweis);
    const wurzel = mkdtempSync(join(tmpdir(), 'clenaris-nachweis-'));
    try {
      for (const modus of MODI) {
        const verzeichnis = join(wurzel, modus, 'test-results');
        const pfad = releaseNachweisSchreiben(modus, verzeichnis, gebaut.nachweis);
        const datei = join(verzeichnis, RELEASE_NACHWEIS_DATEI);
        assert.equal(abschluss(modus).nachweis, modus === 'release', `${modus}: Nachweispflicht`);
        assert.equal(existsSync(datei), modus === 'release', `${modus}: Datei`);
        assert.equal(pfad, modus === 'release' ? datei : null, `${modus}: Rückgabe`);
      }
      const geschrieben = JSON.parse(readFileSync(join(wurzel, 'release', 'test-results', RELEASE_NACHWEIS_DATEI), 'utf8'));
      assert.equal(geschrieben.commit, '9fd662b0c0ffee0c0ffee0c0ffee0c0ffee0c0ff');
      assert.equal(geschrieben.kern.ok, true);
      assert.equal(geschrieben.stress.gruen, STRESS_LAEUFE);
      assert.equal(geschrieben.stress.ergebnisse.length, STRESS_LAEUFE);
      assert.deepEqual(Object.keys(geschrieben.kern.browser.jeEngine).sort(), ['chromium', 'firefox', 'webkit']);
      assert.equal(geschrieben.stress.ergebnisse[0].jeEngine.webkit.expected, 1, 'jeder Stresslauf trägt seine Zahlen je Engine');
    } finally {
      rmSync(wurzel, { recursive: true, force: true });
    }
  });

  it('der Release-Nachweis entsteht nur aus vollständigen, grünen Zahlen', () => {
    const faelle: [string, (e: NachweisEingabe) => void, RegExp][] = [
      ['ohne Kernbilanz', (e) => (e.kern = null), /Keine Bilanz des Kerns/],
      ['Kern nicht bestanden', (e) => (e.kern!.ok = false), /Kern ist nicht bestanden/],
      ['Kern ohne WebKit', (e) => (e.kern!.browser = browserBilanzAusBericht(playwrightBericht(GRUENE_FAELLE.filter((f) => f.projekt !== 'webkit'), ['chromium', 'firefox']))), /webkit ohne einen bestandenen Fall/],
      ['vier statt fünf Stressläufe', (e) => e.stress!.ergebnisse.pop(), /4 von verlangten 5/],
      ['ein Stresslauf mit übersprungenem Fall', (e) => (e.stress!.ergebnisse[2] = stresslauf(3, { uebersprungen: 1, gruende: ['1 übersprungen'] })), /Stressläufe rot: 3/],
      ['ein Stresslauf mit Hydrationsartefakt', (e) => (e.stress!.ergebnisse[4] = stresslauf(5, { hydrationsartefakte: 1 })), /Stressläufe rot: 5/],
      ['Stressreihe nur über eine Datei', (e) => (e.stress!.datei = 'tests/e2e/abmelden.spec.ts'), /nur über/],
      ['kein Commit', (e) => (e.commit = 'HEAD'), /Kein gültiger Commit/],
      ['ohne Stressbericht', (e) => (e.stress = null), /Kein Bericht der Stressreihe/],
    ];
    for (const [name, aendern, erwartet] of faelle) {
      const eingabe = vollstaendigeEingabe();
      aendern(eingabe);
      const ergebnis = releaseNachweisBauen(eingabe);
      assert.equal(ergebnis.nachweis, null, `${name}: trotzdem ein Nachweis`);
      assert.ok(ergebnis.gruende.some((g) => erwartet.test(g)), `${name}: ${ergebnis.gruende.join(' | ')}`);
    }
  });
});

/**
 * `db:test:setup --ohne-demo` (2026-10-01, Befund der Gegenprüfung). Ohne
 * `--frisch` wurde eine bestehende Testdatenbank samt Demodaten früherer
 * Läufe weiterverwendet, und das Skript meldete trotzdem „nur
 * Konfiguration“. Jetzt bricht es ab, bevor es irgendetwas anfasst.
 *
 * Als Prozess, weil das Skript beim Laden selbst läuft. Beide Adressen
 * zeigen auf einen Port, an dem nichts lauscht, und das Arbeitsverzeichnis
 * ist leer (keine `.env`): Fehlte die Sperre, scheiterte der Aufruf an der
 * Verbindung — mit einer anderen Meldung, also rot, und ohne dass eine echte
 * Datenbank berührt würde. Darum prüft der Fall die Meldung und nicht nur den
 * Exitcode; ohne `--frisch` verwirft das Skript ohnehin nichts.
 */
describe('Testdatenbank für den Release-Kern', () => {
  it('--ohne-demo ohne --frisch bricht vor jedem Datenbankzugriff ab', () => {
    const wurzel = join(__dirname, '..', '..');
    const leer = mkdtempSync(join(tmpdir(), 'clenaris-testdb-'));
    const nirgends = 'postgresql://pruefung:pruefung@127.0.0.1:9/clenaris_gibt_es_nicht_test';
    try {
      const lauf = spawnSync(process.execPath, [join(wurzel, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(wurzel, 'scripts', 'setup-test-db.ts'), '--ohne-demo'], {
        cwd: leer,
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, DATABASE_URL: nirgends.replace('_test', ''), TEST_DATABASE_URL: nirgends },
      });
      const ausgabe = `${lauf.stdout}${lauf.stderr}`;
      assert.equal(lauf.status, 1, ausgabe);
      assert.match(lauf.stderr, /--ohne-demo nur zusammen mit --frisch/);
      // Abgebrochen vor dem ersten Schritt: nicht einmal die Zieladresse ist
      // ausgegeben, geschweige denn eine Migration oder ein Seed gestartet.
      assert.doesNotMatch(ausgabe, /Testdatenbank \(Ziel\)|Migrationen|Konfiguration \(ohne Demodaten/);
    } finally {
      rmSync(leer, { recursive: true, force: true });
    }
  });
});
