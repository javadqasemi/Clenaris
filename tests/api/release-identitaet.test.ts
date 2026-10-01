import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ausgangNichtBelegt, hindernis, zielNichtBelegt, type AuftragFuerRegeln, type ReleaseFuerRegeln } from '../../src/lib/release/ausfuehrungsregeln';
import { IDENTITAETS_NAMEN, IDENTITAETS_ZUSTAENDE, identitaetLesen, type Identitaet, type IdentitaetsZustand } from '../../src/lib/release/identitaet';
import { aktuelleVersion } from '../../src/lib/version';
import { PAKET_VERSION, PRUEF_ARTEFAKT_COMMIT, PRUEF_BUILD_ID, pruefManifest, pruefVerzeichnis } from '../helpers/pruefartefakt';

/**
 * Identität der laufenden Instanz (2026-09-30, Production-V2-Härtung) — rein,
 * gegen Verzeichnisse in `tmpdir()`, ohne Server.
 *
 * Was hier nicht wiederkommen darf: Bis zur Härtung meldete eine Instanz als
 * Stand, was ihr eine Umgebungsvariable sagte (`APP_VERSION` für den Commit,
 * `CLENARIS_VERSION` für die Version). Ein Verzeichnis A, mit den Variablen
 * von B gestartet, gab sich als B aus, und der Ausführer meldete „B
 * installiert". Jeder Fall hier scheitert gegen diesen Stand — es gab weder
 * `identitaetLesen` noch eine Prüfung der `BUILD_ID`, und
 * `aktuelleVersion()` glaubte `CLENARIS_VERSION`.
 *
 * Jeder Aufruf reicht `env` und `distDir` ausdrücklich herein: Die Prüfreihe
 * läuft oft mit `NEXT_DIST_DIR` und in der Umgebung `test`, und genau diese
 * Werte sollen die Fälle nicht still umfärben.
 */

const verzeichnisse: string[] = [];
function dir(o: Parameters<typeof pruefVerzeichnis>[0] = {}): string {
  const d = pruefVerzeichnis(o);
  verzeichnisse.push(d);
  return d;
}

after(() => {
  for (const d of verzeichnisse) rmSync(d, { recursive: true, force: true });
});

const PRODUKTION = { CLENARIS_UMGEBUNG: 'production' };

describe('Identität der Instanz (rein)', () => {
  it('RELEASE.json und BUILD_ID stimmen überein: Identität belegt', () => {
    const i = identitaetLesen({ verzeichnis: dir(), distDir: '.next', env: PRODUKTION });
    assert.equal(i.zustand, 'belegt');
    assert.equal(i.belegt, true);
    assert.equal(i.commit, PRUEF_ARTEFAKT_COMMIT);
    assert.equal(i.version, PAKET_VERSION);
    assert.equal(i.buildId, PRUEF_BUILD_ID);
    assert.equal(i.grund, null);
  });

  it('BUILD_ID weicht ab: widersprüchlich — kein Commit, die echte Build-ID bleibt sichtbar', () => {
    const i = identitaetLesen({ verzeichnis: dir({ buildId: 'ein-anderer-bau-0002' }), distDir: '.next', env: PRODUKTION });
    assert.equal(i.zustand, 'widerspruechlich');
    assert.equal(i.belegt, false);
    assert.equal(i.commit, null, 'ein Commit, den der Bau nicht bestätigt, geht nicht hinaus');
    assert.equal(i.buildId, 'ein-anderer-bau-0002');
    assert.match(i.grund ?? '', /BUILD_ID/);
  });

  it('BUILD_ID fehlt oder Manifest beschreibt ein anderes Bauverzeichnis: widersprüchlich', () => {
    const ohneBau = identitaetLesen({ verzeichnis: dir({ buildId: null }), distDir: '.next', env: PRODUKTION });
    assert.equal(ohneBau.zustand, 'widerspruechlich');
    assert.equal(ohneBau.buildId, null);
    // Der Bau liegt in `.next-pruef`, das Manifest beschreibt `.next`: Die
    // Build-ID stimmt zufällig, aber das Manifest spricht von einem anderen Bau.
    const anderesVerzeichnis = identitaetLesen({ verzeichnis: dir({ distDir: '.next-pruef' }), distDir: '.next-pruef', env: PRODUKTION });
    assert.equal(anderesVerzeichnis.zustand, 'widerspruechlich');
    assert.match(anderesVerzeichnis.grund ?? '', /\.next-pruef/);
  });

  it('eine von Hand geänderte Version im Manifest: widersprüchlich', () => {
    const i = identitaetLesen({ verzeichnis: dir({ manifest: pruefManifest({ version: '99.0.0' }) }), distDir: '.next', env: PRODUKTION });
    assert.equal(i.zustand, 'widerspruechlich');
    assert.equal(i.version, PAKET_VERSION, 'ohne Beleg gilt die in den Code eingebaute Version, nicht die behauptete');
    assert.equal(i.commit, null);
  });

  it('ohne RELEASE.json: Version aus package.json, nicht belegt', () => {
    const i = identitaetLesen({ verzeichnis: dir({ manifest: null }), distDir: '.next', env: PRODUKTION });
    assert.equal(i.zustand, 'ohne-manifest');
    assert.equal(i.belegt, false);
    assert.equal(i.version, PAKET_VERSION);
    assert.equal(i.commit, null);
    assert.equal(i.buildId, PRUEF_BUILD_ID, 'die Build-ID des Baus bleibt eine Tatsache, auch ohne Manifest');
  });

  it('Prüfmanifest wirkt nur in der Umgebung test', () => {
    // Das Verzeichnis hat einen Bau, aber kein RELEASE.json; das Prüfmanifest
    // liegt daneben, wie `scripts/test-server.ts` es schreibt.
    const d = dir({ manifest: null });
    const pruef = join(d, 'pruef-release.json');
    writeFileSync(pruef, JSON.stringify(pruefManifest()));

    const imTest = identitaetLesen({ verzeichnis: d, distDir: '.next', env: { CLENARIS_UMGEBUNG: 'test', CLENARIS_PRUEF_RELEASE_MANIFEST: pruef } });
    assert.equal(imTest.zustand, 'belegt');
    assert.equal(imTest.commit, PRUEF_ARTEFAKT_COMMIT);

    for (const umgebung of ['production', 'staging', 'preview', '', 'Test']) {
      const i = identitaetLesen({ verzeichnis: d, distDir: '.next', env: { CLENARIS_UMGEBUNG: umgebung, CLENARIS_PRUEF_RELEASE_MANIFEST: pruef } });
      assert.equal(i.zustand, 'ohne-manifest', `Umgebung „${umgebung}": das Prüfmanifest darf nicht wirken`);
      assert.equal(i.commit, null);
    }

    // Auch in der Umgebung test muss es zum Bau passen — es legt nur Commit
    // und Herkunft fest, nicht die Build-ID.
    writeFileSync(pruef, JSON.stringify(pruefManifest({ buildId: 'fremder-bau-0003' })));
    const fremd = identitaetLesen({ verzeichnis: d, distDir: '.next', env: { CLENARIS_UMGEBUNG: 'test', CLENARIS_PRUEF_RELEASE_MANIFEST: pruef } });
    assert.equal(fremd.zustand, 'widerspruechlich');

    // Ein genanntes, aber fehlendes Prüfmanifest ist eine kaputte Prüfumgebung.
    const fehlt = identitaetLesen({ verzeichnis: d, distDir: '.next', env: { CLENARIS_UMGEBUNG: 'test', CLENARIS_PRUEF_RELEASE_MANIFEST: join(d, 'gibt-es-nicht.json') } });
    assert.equal(fehlt.zustand, 'ungueltig');
  });

  it('fremdes oder Format-1-Manifest wird nicht geglaubt', () => {
    const { format: _format, quelleZeitUtc: _zeit, ...rest } = pruefManifest();
    const formatEins = { ...rest, format: 1, erstelltUtc: '2026-09-28T10:00:00.000Z' };
    const faelle: [string, unknown, RegExp][] = [
      ['Format 1', formatEins, /Format 1/],
      ['ohne Format', rest, /Format ohne Angabe/],
      ['fremde Anwendung', { ...pruefManifest(), anwendung: 'andere' }, /keine Clenaris-Fassung/],
      ['Commit als Kürzel', { ...pruefManifest(), commit: PRUEF_ARTEFAKT_COMMIT.slice(0, 12) }, /commit/],
      ['unbekanntes Feld', { ...pruefManifest(), ziel: '2.29.18.45' }, /Vertrag/],
      ['kein JSON', '{ "format": 2, ', /kein JSON/],
      ['Liste statt Objekt', [pruefManifest()], /kein Objekt/],
    ];
    for (const [name, manifest, grund] of faelle) {
      const i = identitaetLesen({ verzeichnis: dir({ manifest }), distDir: '.next', env: PRODUKTION });
      assert.equal(i.zustand, 'ungueltig', name);
      assert.equal(i.belegt, false, name);
      assert.equal(i.commit, null, name);
      assert.equal(i.manifest, null, name);
      assert.match(i.grund ?? '', grund, name);
    }
  });

  it('CLENARIS_VERSION überschreibt die laufende Version nicht mehr', () => {
    const vorher = process.env.CLENARIS_VERSION;
    process.env.CLENARIS_VERSION = '99.9.9';
    try {
      // Der Prüfprozess läuft im Repository ohne RELEASE.json: Die Version
      // ist die aus `package.json`, was immer die Variable sagt.
      assert.equal(aktuelleVersion(), PAKET_VERSION);
    } finally {
      if (vorher === undefined) delete process.env.CLENARIS_VERSION;
      else process.env.CLENARIS_VERSION = vorher;
    }
  });
});

/**
 * Die Regeln des Release-Ausführers gegen jeden Zustand der Identität
 * (2026-10-01, Befund der Gegenprüfung) — rein, ohne Server.
 *
 * Über HTTP ist der Zweig „nicht belegt" nicht erreichbar: Der Prüfserver
 * belegt seinen Stand immer (Prüfmanifest, `scripts/test-server.ts`), und
 * `release-center.test.ts` setzt genau das voraus. Bis hierher prüfte deshalb
 * nichts die zentrale Regel dieses Wegs — kein Rollout, kein „erfolgreich",
 * kein „zurückgesetzt", solange die Instanz ihren Stand nicht belegt. Eine
 * Änderung, die eine der drei Abfragen `!identitaet.belegt` strich, blieb
 * grün.
 *
 * **Die unbelegten Identitäten hier würden sonst passen.** `identitaetLesen`
 * gibt ohne Beleg keinen Commit heraus; eine Prüfung mit `commit: null`
 * würde auch ohne die Abfrage `belegt` abgewiesen (null ≠ Ziel) und bewiese
 * nichts. Deshalb tragen die Fälle unten Commit und Version, mit denen die
 * Regel bei belegtem Stand durchginge — die Gegenprobe mit `belegt` zeigt das
 * im selben Durchgang. Gegen eine Fassung ohne die Abfrage scheitert jeder
 * unbelegte Zustand.
 *
 * Die Zustände kommen aus `IDENTITAETS_ZUSTAENDE`: Kommt ein fünfter hinzu,
 * läuft er hier ohne Zutun mit.
 */
describe('Regeln des Release-Ausführers gegen jeden Identitätszustand (rein)', () => {
  const ZIEL_COMMIT = 'b'.repeat(40);
  const AUSGANG_COMMIT = 'a'.repeat(40);
  const release: ReleaseFuerRegeln = { version: '2.0.0', ciStatus: 'PASSED', commit: ZIEL_COMMIT, artifactSha256: 'c'.repeat(64) };
  const auftrag: AuftragFuerRegeln = { fromVersion: '1.0.0', toVersion: '2.0.0' };

  /** Eine Identität im Zustand `zustand` mit den Angaben, die sonst passen würden. */
  const identitaet = (zustand: IdentitaetsZustand, angaben: { version: string; commit: string }): Identitaet => ({
    belegt: zustand === 'belegt',
    zustand,
    version: angaben.version,
    commit: angaben.commit,
    buildId: 'pruefbau-regeln-0001',
    grund: zustand === 'belegt' ? null : 'für die Prüfung gesetzt',
    manifest: null,
  });

  it('alle vier Zustände sind erfasst — und nur „belegt" ist belegt', () => {
    assert.deepEqual([...IDENTITAETS_ZUSTAENDE].sort(), ['belegt', 'ohne-manifest', 'ungueltig', 'widerspruechlich']);
    for (const zustand of IDENTITAETS_ZUSTAENDE) assert.ok(IDENTITAETS_NAMEN[zustand], `kein Name für ${zustand}`);
  });

  it('ohne belegten Stand wird nichts ausgerollt — auch wenn die behauptete Version älter ist als das Ziel', () => {
    for (const zustand of IDENTITAETS_ZUSTAENDE) {
      const grund = hindernis(release, identitaet(zustand, { version: '1.0.0', commit: AUSGANG_COMMIT }));
      if (zustand === 'belegt') {
        assert.equal(grund, null, 'Gegenprobe: belegt und älter — ausrollbar');
      } else {
        assert.ok(grund, `Zustand „${zustand}": Rollout ohne belegten Ausgangsstand freigegeben`);
        assert.match(grund, /nicht belegen/, zustand);
        assert.ok(grund.includes(IDENTITAETS_NAMEN[zustand]), `${zustand}: der Grund nennt den Zustand nicht`);
      }
    }
  });

  it('„erfolgreich" nur mit belegtem Stand — auch wenn Commit und Version dem Ziel gleichen', () => {
    for (const zustand of IDENTITAETS_ZUSTAENDE) {
      const grund = zielNichtBelegt(auftrag, release, identitaet(zustand, { version: release.version, commit: ZIEL_COMMIT }));
      if (zustand === 'belegt') {
        assert.equal(grund, null, 'Gegenprobe: belegtes Ziel — erfolgreich');
      } else {
        assert.ok(grund, `Zustand „${zustand}": Erfolg ohne Beleg angenommen`);
        assert.ok(grund.includes(IDENTITAETS_NAMEN[zustand]), `${zustand}: der Grund nennt den Zustand nicht`);
      }
    }
  });

  it('„zurückgesetzt" nur mit belegtem Stand — auch wenn Ausgangsversion und fremder Commit passen', () => {
    for (const zustand of IDENTITAETS_ZUSTAENDE) {
      const grund = ausgangNichtBelegt(auftrag, release, identitaet(zustand, { version: auftrag.fromVersion, commit: AUSGANG_COMMIT }));
      if (zustand === 'belegt') {
        assert.equal(grund, null, 'Gegenprobe: belegter Ausgangsstand — zurückgesetzt');
      } else {
        assert.ok(grund, `Zustand „${zustand}": Rücksprung ohne Beleg angenommen`);
        assert.ok(grund.includes(IDENTITAETS_NAMEN[zustand]), `${zustand}: der Grund nennt den Zustand nicht`);
      }
    }
  });

  it('bei belegtem Stand: nur neuer, bestanden, vollständiger Commit und Prüfsumme werden ausgerollt', () => {
    const laufend = identitaet('belegt', { version: '1.0.0', commit: AUSGANG_COMMIT });
    const faelle: [string, Partial<ReleaseFuerRegeln>, RegExp][] = [
      ['gleiche Version', { version: '1.0.0' }, /nicht neuer/],
      ['ältere Version', { version: '0.9.9' }, /nicht neuer/],
      ['Vorabversion derselben Nummer', { version: '1.0.0-rc.1' }, /nicht neuer/],
      ['Prüfstufe rot', { ciStatus: 'FAILED' }, /Prüfstufe/],
      ['Prüfstufe offen', { ciStatus: 'PENDING' }, /Prüfstufe/],
      ['Commit-Kürzel', { commit: ZIEL_COMMIT.slice(0, 12) }, /vollständiger Commit/],
      ['ohne Commit', { commit: null }, /vollständiger Commit/],
      ['ohne Prüfsumme', { artifactSha256: null }, /Prüfsumme/],
    ];
    for (const [fall, ueber, grund] of faelle) {
      assert.match(hindernis({ ...release, ...ueber }, laufend) ?? '', grund, fall);
    }
  });

  it('bei belegtem Stand: „erfolgreich" verlangt Commit und Version des Ziels, „zurückgesetzt" die Ausgangsversion mit anderem Commit', () => {
    const fremderCommit = identitaet('belegt', { version: release.version, commit: 'd'.repeat(40) });
    assert.match(zielNichtBelegt(auftrag, release, fremderCommit) ?? '', /Commit/);
    const andereVersion = identitaet('belegt', { version: '2.0.1', commit: ZIEL_COMMIT });
    assert.match(zielNichtBelegt(auftrag, release, andereVersion) ?? '', /Version 2\.0\.1/);

    // Das Ziel läuft noch, auch wenn die Version zufällig der Ausgangsversion
    // gleicht: kein Rücksprung.
    const zielLaeuft = identitaet('belegt', { version: auftrag.fromVersion, commit: ZIEL_COMMIT });
    assert.match(ausgangNichtBelegt(auftrag, release, zielLaeuft) ?? '', /kein Rücksprung/);
    const dritteVersion = identitaet('belegt', { version: '1.5.0', commit: 'e'.repeat(40) });
    assert.match(ausgangNichtBelegt(auftrag, release, dritteVersion) ?? '', /Ausgangsversion 1\.0\.0/);
  });
});
