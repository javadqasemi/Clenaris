import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { identitaetLesen } from '../../src/lib/release/identitaet';
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
