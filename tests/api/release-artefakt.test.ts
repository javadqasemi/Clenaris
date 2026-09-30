import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { DEMO_BLOGBEITRAEGE, DEMO_KENNZEICHEN, DEMO_KUNDSCHAFT } from '../../prisma/demo-kennzeichen';
import { archivPacken, bauPruefen } from '../../scripts/release-artefakt';
import {
  INHALT,
  MANIFEST_DATEI,
  ausschlussGrund,
  beilageBauen,
  ciHerkunftAusUmgebung,
  commitBestimmen,
  demodatenMeldung,
  demodatenSuchen,
  eintraegeSammeln,
  manifestBauen,
  migrationenAuflisten,
  quelleZeit,
  tarArtErkennen,
  tarAufruf,
  umgebungsdateienImArchiv,
  unsauberePfade,
  vollstaendig,
  vollstaendigkeitPruefen,
  type ManifestFelder,
} from '../../scripts/release/artefakt-regeln';
import { artefaktBeilageSchema, artefaktManifestSchema, type CiHerkunft } from '../../src/lib/release/manifest';

/**
 * Das Release-Artefakt, geprüft ohne Bau (2026-09-30).
 *
 * **Warum ohne Bau.** Ein echtes Artefakt entsteht nur in der CI: nach
 * `next build` gegen eine Datenbank, mit `node_modules` unter Linux, einige
 * hundert Megabyte gross. Genau deshalb wurden die Regeln des Packskripts nie
 * geprüft — und drei Fehler lebten darin, bis sie jemand las (unverankerte
 * Ausschlüsse, Sauberkeit ohne unverfolgte Dateien, `prisma.config.ts`
 * fehlte). Hier laufen die Regeln aus `scripts/release/artefakt-regeln.ts`
 * gegen kleine Bäume in einem Zwischenverzeichnis, und der echte
 * `tar`-Aufruf packt einen davon — mit der tar-Fassung, die auf dem
 * Prüfrechner liegt (GNU tar in der CI, bsdtar unter Windows).
 *
 * Diese Datei braucht weder Server noch Datenbank.
 */

const COMMIT = 'a'.repeat(40);
const SUMME = 'b'.repeat(64);
const WURZEL = process.cwd();

function ci(ereignis: string, ref: string): CiHerkunft {
  const herkunft = ciHerkunftAusUmgebung({
    GITHUB_RUN_ID: '18000000001',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_EVENT_NAME: ereignis,
    GITHUB_REF: ref,
    GITHUB_REPOSITORY: 'javadqasemi/clenaris',
  });
  assert.ok(herkunft, 'mit GITHUB_RUN_ID gibt es eine Herkunft');
  return herkunft;
}

function felder(anders: Partial<ManifestFelder> = {}): ManifestFelder {
  return {
    version: '1.0.0',
    commit: COMMIT,
    unsauber: false,
    buildId: 'Bau-4711',
    distDir: '.next',
    quelleZeitUtc: '2026-09-30T13:29:03.000Z',
    node: 'v22.20.0',
    npm: '10.9.3',
    plattform: 'linux-x64',
    next: '15.5.26',
    sperrdateiSha256: SUMME,
    seitenUrl: 'https://clenaris.ch',
    mitModulen: true,
    migrationen: ['20260904090000_init', '20260905100000_performance_indexes'],
    ci: ci('push', 'refs/heads/main'),
    ...anders,
  };
}

/** Einen kleinen Baum anlegen: Pfad → Inhalt; ein Pfad mit `/` am Ende wird ein leeres Verzeichnis. */
function baum(wurzel: string, dateien: Record<string, string>): void {
  for (const [pfad, inhalt] of Object.entries(dateien)) {
    if (pfad.endsWith('/')) {
      mkdirSync(join(wurzel, pfad), { recursive: true });
      continue;
    }
    mkdirSync(dirname(join(wurzel, pfad)), { recursive: true });
    writeFileSync(join(wurzel, pfad), inhalt);
  }
}

/**
 * Jede Prüfung arbeitet in eigenen, frisch angelegten Verzeichnissen und
 * räumt nur diese weg. Ein Aufräumen „aller Reste mit diesem Präfix" vorab
 * träfe die Verzeichnisse eines gleichzeitig laufenden zweiten Arbeitsbaums —
 * ein Rest aus einem abgebrochenen Lauf stört dagegen nicht, weil kein Lauf
 * ein fremdes Verzeichnis wiederverwendet.
 */
const zwischen: string[] = [];
function neuesVerzeichnis(): string {
  const d = mkdtempSync(join(tmpdir(), 'clenaris-artefakt-probe-'));
  zwischen.push(d);
  return d;
}

after(() => {
  for (const d of zwischen) rmSync(d, { recursive: true, force: true });
});

describe('Release-Artefakt: Herkunft und Manifest', () => {
  it('auslieferbar nur aus einem Push-Lauf auf main — Pull Request und örtlicher Bau sind Proben', () => {
    assert.equal(manifestBauen(felder()).auslieferbar, true, 'Push auf main, sauber, mit Modulen, aus .next');

    // Ein Pull-Request-Lauf baut den Zusammenführungs-Commit, der nie auf main stand.
    assert.equal(manifestBauen(felder({ ci: ci('pull_request', 'refs/pull/9/merge') })).auslieferbar, false, 'Pull Request');
    // Örtlich: keine GITHUB_RUN_ID, keine Herkunft.
    const oertlich = ciHerkunftAusUmgebung({ GITHUB_SHA: COMMIT });
    assert.equal(oertlich, null, 'ohne GITHUB_RUN_ID gibt es keine CI-Herkunft');
    assert.equal(manifestBauen(felder({ ci: oertlich })).auslieferbar, false, 'örtlicher Bau');
    // Ein Push auf einen anderen Zweig ist geprüft, aber nicht freigegeben.
    assert.equal(manifestBauen(felder({ ci: ci('push', 'refs/heads/haertung/strom-b') })).auslieferbar, false, 'anderer Zweig');

    // Auch aus main bleibt eine Probe eine Probe.
    assert.equal(manifestBauen(felder({ unsauber: true })).auslieferbar, false, 'unsauberer Baum');
    assert.equal(manifestBauen(felder({ mitModulen: false })).auslieferbar, false, 'ohne Module');
    assert.equal(manifestBauen(felder({ distDir: '.next-probe' })).auslieferbar, false, 'umgeleitetes Bauverzeichnis');
  });

  /**
   * Der gemeinsame Vertrag (`auslieferbarNach`) lässt neben dem Push auch einen
   * von Hand gestarteten Lauf **auf main** zu — der Weg, ein Release nach
   * einem roten Nebenschritt neu zu bauen, ohne einen leeren Commit zu
   * schieben. Hier festgehalten, damit die Ausnahme sichtbar bleibt und nicht
   * auf andere Zweige übergreift.
   */
  it('ein von Hand gestarteter Lauf auf main gilt wie ein Push — auf einem anderen Zweig nicht', () => {
    assert.equal(manifestBauen(felder({ ci: ci('workflow_dispatch', 'refs/heads/main') })).auslieferbar, true);
    assert.equal(manifestBauen(felder({ ci: ci('workflow_dispatch', 'refs/heads/release/rc') })).auslieferbar, false);
    assert.equal(manifestBauen(felder({ ci: ci('schedule', 'refs/heads/main') })).auslieferbar, false, 'ein Zeitplan ist keine Freigabe');
  });

  it('eine halb gesetzte CI-Herkunft hält an, statt still zur Probe zu werden', () => {
    assert.throws(
      () => ciHerkunftAusUmgebung({ GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1', GITHUB_EVENT_NAME: 'push', GITHUB_REPOSITORY: 'a/b' }),
      /GITHUB_REF/,
    );
    assert.throws(
      () => ciHerkunftAusUmgebung({ GITHUB_RUN_ID: 'x1', GITHUB_RUN_ATTEMPT: '1', GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'a/b' }),
      /GITHUB_RUN_ID/,
    );
  });

  it('das Manifest nennt Version, Commit, Build-ID, CI-Lauf und Migrationen', () => {
    const migrationen = migrationenAuflisten(join(WURZEL, 'prisma', 'migrations'));
    // Die Liste ist sortiert, vollständig und enthält nur Verzeichnisse mit migration.sql.
    const aufPlatte = readdirSync(join(WURZEL, 'prisma', 'migrations'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(WURZEL, 'prisma', 'migrations', e.name, 'migration.sql')))
      .map((e) => e.name)
      .sort();
    assert.deepEqual(migrationen, aufPlatte);
    assert.ok(migrationen.length > 50, 'die Migrationen des Repositories sind alle dabei');
    assert.ok(!migrationen.includes('migration_lock.toml'));

    const zeit = quelleZeit('2026-09-30T15:29:03+02:00');
    assert.deepEqual(zeit, { utc: '2026-09-30T13:29:03.000Z', epoche: Date.UTC(2026, 8, 30, 13, 29, 3) / 1000 });

    const manifest = manifestBauen(felder({ migrationen, quelleZeitUtc: zeit.utc }));
    // Gegen den Vertrag, den Aktivierung, Vorprüfung, Ausführer und Instanz lesen.
    assert.deepEqual(artefaktManifestSchema.parse(JSON.parse(JSON.stringify(manifest))), manifest);
    assert.equal(manifest.format, 2);
    assert.equal(manifest.version, '1.0.0');
    assert.equal(manifest.commit, COMMIT);
    assert.equal(manifest.buildId, 'Bau-4711');
    assert.equal(manifest.quelleZeitUtc, '2026-09-30T13:29:03.000Z');
    assert.equal(manifest.reactKorrektur, 'geprueft');
    assert.deepEqual(manifest.ci, {
      lauf: '18000000001',
      versuch: '1',
      ereignis: 'push',
      ref: 'refs/heads/main',
      repository: 'javadqasemi/clenaris',
    });
    assert.deepEqual(manifest.migrationen, migrationen);
    // Schlüssel in der Reihenfolge des Vertrags: zwei Manifeste desselben Stands sind auch als Text gleich.
    assert.deepEqual(Object.keys(manifest), Object.keys(artefaktManifestSchema.shape));
    assert.equal(JSON.stringify(manifestBauen(felder({ migrationen }))), JSON.stringify(manifestBauen(felder({ migrationen }))));

    const beilage = beilageBauen(manifest, {
      archivSha256: SUMME,
      archivGroesseBytes: 123_456,
      erstelltUtc: '2026-09-30T14:00:00.000Z',
      archivNormalisiert: true,
    });
    assert.deepEqual(artefaktBeilageSchema.parse(beilage), beilage);
    assert.equal(beilage.commit, COMMIT);
    assert.equal(beilage.archivSha256, SUMME);

    // Was den Vertrag verletzt, wird nicht geschrieben.
    assert.throws(() => manifestBauen(felder({ commit: 'abc1234' })), /verletzt den Vertrag.*commit/);
    assert.throws(() => manifestBauen(felder({ version: 'v1.0' })), /verletzt den Vertrag.*version/);
    assert.throws(() => manifestBauen(felder({ quelleZeitUtc: '2026-09-30T15:29:03+02:00' })), /quelleZeitUtc/);
    assert.throws(() => beilageBauen(manifest, { archivSha256: 'kurz', archivGroesseBytes: 1, erstelltUtc: zeit.utc, archivNormalisiert: false }), /Beiblatt/);
  });

  it('eine Migration ausserhalb des Musters hält mit Namen an; ein Verzeichnis ohne migration.sql zählt nicht', () => {
    const d = neuesVerzeichnis();
    baum(d, {
      '20260101000000_eins/migration.sql': 'SELECT 1;',
      '20260102000000_leer/': '',
      'migration_lock.toml': 'provider = "postgresql"',
    });
    assert.deepEqual(migrationenAuflisten(d), ['20260101000000_eins']);
    baum(d, { '20260103000000_Gross/migration.sql': 'SELECT 1;' });
    assert.throws(() => migrationenAuflisten(d), /20260103000000_Gross/);
  });

  it('GITHUB_SHA muss der ausgecheckte Commit sein', () => {
    assert.equal(commitBestimmen(undefined, `${COMMIT}\n`), COMMIT);
    assert.equal(commitBestimmen(COMMIT, COMMIT), COMMIT);
    assert.throws(() => commitBestimmen('c'.repeat(40), COMMIT), /nicht der ausgecheckte Commit/);
    assert.throws(() => commitBestimmen(undefined, 'abc1234'), /HEAD ist kein vollständiger Commit/);
  });

  /**
   * Bis 2026-09-30 lief die Prüfung mit `--untracked-files=no`: Eine nie
   * eingecheckte Datei unter `src/` reiste ins Artefakt, und das Manifest
   * nannte den Baum trotzdem sauber.
   */
  it('Sauberkeit: unverfolgte Dateien im Inhalt zählen, ausserhalb nicht', () => {
    const status = [
      ' M docs/ABLAUF.md', // verfolgt, geändert — zählt überall
      '?? src/lib/neu.ts', // unverfolgt im Inhalt — zählt
      '?? prisma.config.ts', // unverfolgt, oberster Eintrag selbst — zählt
      '?? docs/eigener-bericht.md', // unverfolgt ausserhalb — zählt nicht
      '?? source-notes.txt', // ähnlicher Name, aber nicht `src/` — zählt nicht
      'R  src/neu-benannt.ts',
      'src/alt-benannt.ts', // Herkunft der Umbenennung, eigener Eintrag bei -z
      '!! .next/BUILD_ID',
      '',
    ].join('\0');
    assert.deepEqual(unsauberePfade(status, ['package.json', 'prisma.config.ts', 'src', '.next']), [
      'docs/ABLAUF.md',
      'src/lib/neu.ts',
      'prisma.config.ts',
      'src/neu-benannt.ts',
    ]);
    assert.deepEqual(unsauberePfade('', ['src']), [], 'ein sauberer Baum');
  });
});

describe('Release-Artefakt: Inhalt, Ausschlüsse, Vollständigkeit', () => {
  /**
   * Bis 2026-09-30 fehlte `prisma.config.ts` im Artefakt. Seit Prisma 7 kennt
   * die Kommandozeile die Datenbank nur daraus — die Aktivierung ruft im
   * entpackten Release `npx prisma migrate status/deploy` und wäre bei der
   * ersten offenen Migration gescheitert. Geprüft wird deshalb gegen das,
   * was die Aktivierung tatsächlich aufruft, nicht gegen eine zweite Liste.
   */
  it('das Artefakt enthält, was die Aktivierung im entpackten Release aufruft', () => {
    const liegtImArtefakt = (pfad: string) => INHALT.some((e) => pfad === e || pfad.startsWith(`${e}/`));
    for (const datei of ['package.json', 'package-lock.json', 'next.config.ts', 'prisma.config.ts', 'ecosystem.config.js', 'tsconfig.json']) {
      assert.ok(liegtImArtefakt(datei), `${datei} gehört ins Artefakt`);
    }
    // Prisma liest Schema und Migrationen über prisma.config.ts — beide Pfade müssen mitreisen.
    const prismaKonfiguration = readFileSync(join(WURZEL, 'prisma.config.ts'), 'utf8');
    for (const [, pfad] of prismaKonfiguration.matchAll(/(?:schema|path):\s*'([^']+)'/g)) {
      assert.ok(liegtImArtefakt(pfad!), `${pfad} (aus prisma.config.ts) gehört ins Artefakt`);
      assert.ok(existsSync(join(WURZEL, pfad!)), `${pfad} existiert`);
    }
    // Jedes Skript, das die Aktivierung im Release startet, liegt im Artefakt.
    const aktivierung = readFileSync(join(WURZEL, 'deploy', 'v2', 'release-aktivieren.sh'), 'utf8');
    const skripte = [...new Set([...aktivierung.matchAll(/\b(scripts\/[\w./-]+\.(?:ts|mjs|js|sh))\b/g)].map((t) => t[1]!))];
    assert.ok(skripte.length > 0, 'die Aktivierung ruft Skripte aus dem Release auf');
    for (const skript of skripte) {
      assert.ok(liegtImArtefakt(skript), `${skript} gehört ins Artefakt`);
      assert.ok(existsSync(join(WURZEL, skript)), `${skript} existiert`);
    }
    assert.ok(aktivierung.includes(MANIFEST_DATEI), 'die Aktivierung liest das Manifest unter demselben Namen');
  });

  it('Ausschlüsse sind verankert — ein Paketordner namens cache bleibt drin', () => {
    const grund = (eintrag: string, pfad: string) => ausschlussGrund({ eintrag, pfad, distDir: '.next' });
    assert.equal(grund('.next', '.next/cache'), 'bau-zwischenspeicher');
    assert.equal(grund('.next', '.next/cache/webpack/server.pack'), 'bau-zwischenspeicher');
    assert.equal(grund('node_modules', 'node_modules/paket/cache'), null, 'Paketordner cache');
    assert.equal(grund('node_modules', 'node_modules/paket/cache/index.js'), null);
    assert.equal(grund('.next', '.next/server/cache'), null, 'nur <distDir>/cache selbst');
    assert.equal(grund('src', 'src/cache'), null);
    // Umgebungsdateien und TypeScript-Zwischenstände nur direkt unter einem obersten Eintrag.
    assert.equal(grund('prisma', 'prisma/.env'), 'umgebungsdatei');
    assert.equal(grund('scripts', 'scripts/.env.local'), 'umgebungsdatei');
    assert.equal(grund('scripts', 'scripts/.envrc'), null, '.envrc ist keine .env-Datei');
    assert.equal(grund('src', 'src/lib/.env'), null, 'tiefer: kein stiller Ausschluss — die Gegenprobe am Archiv verweigert');
    assert.equal(grund('src', 'src/tsconfig.tsbuildinfo'), 'typescript-zwischenstand');
    assert.equal(
      grund('node_modules', 'node_modules/@supabase/auth-js/dist/tsconfig.tsbuildinfo'),
      null,
      'ein Paket behält, was es mitbringt',
    );
    // Ein umgeleitetes Bauverzeichnis hat seinen eigenen Zwischenspeicher.
    assert.equal(ausschlussGrund({ eintrag: '.next-probe', pfad: '.next-probe/cache', distDir: '.next-probe' }), 'bau-zwischenspeicher');
    assert.equal(ausschlussGrund({ eintrag: '.next', pfad: '.next/cache', distDir: '.next-probe' }), null);

    const d = neuesVerzeichnis();
    baum(d, {
      '.next/BUILD_ID': 'Bau-1',
      '.next/cache/webpack/x.pack': 'x',
      'node_modules/paket/cache/index.js': 'module.exports = 1;',
      'node_modules/paket/.env': 'PAKET=1',
      'src/.env.local': 'GEHEIM=1',
      'src/app/page.tsx': 'export default 1;',
      'src/leer/': '',
    });
    const aufnahme = eintraegeSammeln(d, ['src', '.next', 'node_modules'], '.next');
    assert.deepEqual(aufnahme.eintraege, [
      'src',
      'src/app',
      'src/app/page.tsx',
      'src/leer',
      '.next',
      '.next/BUILD_ID',
      'node_modules',
      'node_modules/paket',
      'node_modules/paket/.env',
      'node_modules/paket/cache',
      'node_modules/paket/cache/index.js',
    ]);
    assert.deepEqual(aufnahme.ausgeschlossen, [
      { pfad: 'src/.env.local', grund: 'umgebungsdatei' },
      { pfad: '.next/cache', grund: 'bau-zwischenspeicher' },
    ]);
    // Ein fehlender oberster Eintrag wird nicht still übergangen.
    assert.throws(() => eintraegeSammeln(d, ['src', 'ecosystem.config.js'], '.next'), /ecosystem\.config\.js fehlt/);
  });

  it('Vollständigkeit: fehlt im Archiv eine Datei ausser den Ausschlüssen, scheitert das Packen', async () => {
    // Der Abgleich selbst.
    const erwartet = ['src', 'src/a.ts', 'src/b.ts', MANIFEST_DATEI];
    assert.ok(vollstaendig(vollstaendigkeitPruefen(erwartet, [...erwartet])));
    const ohneB = vollstaendigkeitPruefen(erwartet, ['src', 'src/a.ts', MANIFEST_DATEI]);
    assert.deepEqual(ohneB.fehlend, ['src/b.ts']);
    assert.equal(vollstaendig(ohneB), false);
    assert.deepEqual(vollstaendigkeitPruefen(erwartet, [...erwartet, 'src/.env']).ueberzaehlig, ['src/.env']);
    assert.deepEqual(vollstaendigkeitPruefen(erwartet, [...erwartet, 'src/a.ts']).doppelt, ['src/a.ts']);

    // Umgebungsdateien im fertigen Archiv — ausserhalb von node_modules verweigert.
    assert.deepEqual(
      umgebungsdateienImArchiv(['src/lib/.env.local', 'node_modules/paket/.env', 'src/lib/envelope.ts', 'deploy/.env']),
      ['src/lib/.env.local', 'deploy/.env'],
    );

    // Der echte Weg: gesammelt, gepackt, aufgelistet, abgeglichen.
    const d = neuesVerzeichnis();
    baum(d, {
      'package.json': '{"name":"probe","version":"1.0.0"}',
      'src/app/page.tsx': 'export default 1;',
      'src/.env': 'GEHEIM=1',
      '.next/BUILD_ID': 'Bau-1',
      '.next/cache/x.pack': 'x',
      'node_modules/paket/cache/index.js': 'module.exports = 1;',
    });
    const ausgabe = neuesVerzeichnis();
    const aufnahme = eintraegeSammeln(d, ['package.json', 'src', '.next', 'node_modules'], '.next');
    const manifest = manifestBauen(felder());
    const archiv = join(ausgabe, 'probe.tar.gz');
    const gepackt = await archivPacken({ wurzel: d, archiv, eintraege: aufnahme.eintraege, manifest, quelleEpoche: 1_759_238_943 });
    assert.deepEqual([...gepackt.gelistet].sort(), [...aufnahme.eintraege, MANIFEST_DATEI].sort());
    assert.ok(gepackt.gelistet.includes('node_modules/paket/cache/index.js'), 'der Paketordner cache ist im Archiv');
    assert.ok(!gepackt.gelistet.some((e) => e.startsWith('.next/cache')), 'der Bau-Zwischenspeicher nicht');
    assert.ok(!gepackt.gelistet.includes('src/.env'), 'die Umgebungsdatei nicht');
    // Das Manifest im Archiv ist das gebaute — `release-aktivieren.sh` liest es genau so.
    // Relativ aus dem Ausgabeverzeichnis: GNU tar hielte `C:\…` für einen entfernten Rechner „C".
    const imArchiv = spawnSync('tar', ['-xzOf', 'probe.tar.gz', MANIFEST_DATEI], { cwd: ausgabe, encoding: 'utf8' });
    assert.equal(imArchiv.status, 0, imArchiv.stderr);
    assert.deepEqual(JSON.parse(imArchiv.stdout), manifest);
    assert.ok(!existsSync(join(d, MANIFEST_DATEI)), 'das Manifest wird nie in die Wurzel geschrieben');

    // Verschwindet eine gesammelte Datei vor dem Packen, scheitert das Packen — und es bleibt kein halbes Archiv liegen.
    rmSync(join(d, 'src', 'app', 'page.tsx'));
    const kaputt = join(ausgabe, 'kaputt.tar.gz');
    await assert.rejects(
      archivPacken({ wurzel: d, archiv: kaputt, eintraege: aufnahme.eintraege, manifest, quelleEpoche: 1_759_238_943 }),
      /src\/app\/page\.tsx|Packen fehlgeschlagen|entspricht nicht/,
    );
    assert.ok(!existsSync(kaputt), 'ein gescheitertes Archiv wird entfernt');

    // Eine Umgebungsdatei tief im Inhalt: gepackt würde sie — also wird verweigert.
    baum(d, { 'src/app/page.tsx': 'export default 1;', 'src/lib/.env.local': 'GEHEIM=2' });
    const mitGeheimnis = eintraegeSammeln(d, ['package.json', 'src'], '.next');
    const geheimArchiv = join(ausgabe, 'geheim.tar.gz');
    await assert.rejects(
      archivPacken({ wurzel: d, archiv: geheimArchiv, eintraege: mitGeheimnis.eintraege, manifest, quelleEpoche: 1_759_238_943 }),
      /Umgebungsdateien ausserhalb von node_modules/,
    );
    assert.ok(!existsSync(geheimArchiv));
  });

  it('GNU tar: Argumente für ein reproduzierbares Archiv', async () => {
    assert.equal(tarArtErkennen('tar (GNU tar) 1.35\nCopyright (C) 2023 Free Software Foundation, Inc.'), 'gnu');
    assert.equal(tarArtErkennen('bsdtar 3.8.8 - libarchive 3.8.8 zlib/1.2.13.1-motley'), 'bsd');
    assert.equal(tarArtErkennen('tar (busybox) 1.36.1'), null, 'eine unbekannte Fassung wird abgewiesen, nicht erraten');

    const eintraege = ['src', 'src/a.ts'];
    const gnu = tarAufruf({ art: 'gnu', archiv: '/aus/a.tar.gz', listenDatei: '/zw/liste', manifestVerzeichnis: '/zw', eintraege, quelleEpoche: 1_759_238_943 });
    for (const pflicht of [
      '--format=posix',
      '--pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime',
      '--sort=name',
      '--mtime=@1759238943',
      '--owner=0',
      '--group=0',
      '--numeric-owner',
      '--no-recursion',
      '--null',
      '--verbatim-files-from',
    ]) {
      assert.ok(gnu.argumente.includes(pflicht), `GNU tar braucht ${pflicht}`);
    }
    // Die Liste vor dem Wechsel ins Zwischenverzeichnis, das Manifest als Letztes.
    assert.deepEqual(gnu.argumente.slice(-7), ['-cf', '-', '-T', '/zw/liste', '-C', '/zw', MANIFEST_DATEI]);
    assert.deepEqual(gnu.gzip, ['-n'], 'gzip ohne Namen und Zeit im Kopf');
    assert.equal(gnu.normalisiert, true);
    assert.equal(gnu.liste, 'src\0src/a.ts\0');
    assert.deepEqual(gnu.auflisten, ['--force-local', '--quoting-style=literal', '-tzf', '/aus/a.tar.gz']);

    const bsd = tarAufruf({ art: 'bsd', archiv: 'a.tar.gz', listenDatei: 'liste', manifestVerzeichnis: 'C:\\zw', eintraege, quelleEpoche: 1 });
    assert.equal(bsd.normalisiert, false, 'bsdtar normalisiert nicht — das Beiblatt sagt es');
    assert.equal(bsd.gzip, null);
    assert.equal(bsd.liste, `src\nsrc/a.ts\n-C\nC:\\zw\n${MANIFEST_DATEI}\n`);
    assert.ok(!bsd.argumente.includes('--sort=name'));
    assert.throws(() => tarAufruf({ art: 'gnu', archiv: 'a', listenDatei: 'l', manifestVerzeichnis: 'z', eintraege, quelleEpoche: -1 }), /Commitzeit/);

    // Echt gepackt, zweimal: Wo das Archiv als normalisiert gilt, muss es
    // bytegleich sein — sonst wäre die Behauptung im Beiblatt falsch. Auf dem
    // CI-Rechner (GNU tar) wird das hier bewiesen; bsdtar behauptet es nicht.
    const d = neuesVerzeichnis();
    baum(d, { 'src/a.ts': 'export const a = 1;', 'src/b/c.ts': 'export const c = 2;' });
    const aufnahme = eintraegeSammeln(d, ['src'], '.next');
    const ausgabe = neuesVerzeichnis();
    const manifest = manifestBauen(felder());
    const summe = (pfad: string) => createHash('sha256').update(readFileSync(pfad)).digest('hex');
    const erstes = await archivPacken({ wurzel: d, archiv: join(ausgabe, 'eins.tar.gz'), eintraege: aufnahme.eintraege, manifest, quelleEpoche: 1_759_238_943 });
    // Zwischen den Läufen ändert sich die Änderungszeit der Dateien — die Normalisierung muss das auffangen.
    writeFileSync(join(d, 'src', 'a.ts'), 'export const a = 1;');
    const zweites = await archivPacken({ wurzel: d, archiv: join(ausgabe, 'zwei.tar.gz'), eintraege: aufnahme.eintraege, manifest, quelleEpoche: 1_759_238_943 });
    assert.equal(erstes.normalisiert, erstes.art === 'gnu');
    assert.equal(zweites.normalisiert, erstes.normalisiert);
    if (erstes.normalisiert) {
      assert.equal(summe(join(ausgabe, 'eins.tar.gz')), summe(join(ausgabe, 'zwei.tar.gz')), 'dasselbe Archiv aus demselben Stand');
    }
  });
});

describe('Release-Artefakt: Stolperfalle Demodaten', () => {
  it('Demodaten im Bau: Packen verweigert', () => {
    const d = neuesVerzeichnis();
    const sauber = {
      '.next/BUILD_ID': 'Bau-1',
      '.next/routes-manifest.json': '{}',
      '.next/prerender-manifest.json': '{"routes":{"/":{}}}',
      '.next/server/app/index.html': '<h1>Clenaris</h1><p>Anna Keller, Teamleiterin Reinigung</p>',
      // Code darf Demoadressen kennen (Sperrliste veröffentlichter Zugangsdaten) — `.js` wird nicht durchsucht.
      '.next/server/chunks/123.js': `const gesperrt = ['${DEMO_KUNDSCHAFT.wyss.email}'];`,
    };
    baum(d, sauber);
    assert.equal(bauPruefen(d, '.next'), 'Bau-1', 'ein Bau ohne Demodaten ist packbar');

    baum(d, {
      // React trennt benachbarte Ausdrücke mit `<!-- -->`, und aus „&" wird `&amp;`.
      '.next/server/app/bewertungen.html': `<ul><li>${DEMO_KUNDSCHAFT.wyss.vorname}<!-- --> <!-- -->${DEMO_KUNDSCHAFT.wyss.nachname}</li></ul>`,
      '.next/server/app/sitemap.xml.body': `<url><loc>https://clenaris.ch/blog/${DEMO_BLOGBEITRAEGE.kalk.slug}</loc></url>`,
      '.next/server/app/blog.rsc': `2:["$","h2",null,{"children":"${DEMO_BLOGBEITRAEGE.buero.titel.replace('ü', '\\u00fc')}"}]`,
    });
    const treffer = demodatenSuchen(d, '.next');
    assert.deepEqual(treffer, [
      { datei: '.next/server/app/bewertungen.html', arten: ['Demokundschaft'] },
      { datei: '.next/server/app/blog.rsc', arten: ['Demo-Blogbeitrag'] },
      { datei: '.next/server/app/sitemap.xml.body', arten: ['Demo-Blogbeitrag'] },
    ]);
    assert.throws(
      () => bauPruefen(d, '.next'),
      (fehler: unknown) => {
        assert.ok(fehler instanceof Error);
        assert.match(fehler.message, /^Demodaten im Bau — Packen verweigert/);
        assert.match(fehler.message, /\.next\/server\/app\/bewertungen\.html \(Demokundschaft\)/);
        assert.match(fehler.message, /\.next\/server\/app\/sitemap\.xml\.body/);
        // Die Meldung nennt die Datei, nicht den Wert — sie steht im öffentlichen CI-Protokoll.
        const verraten = DEMO_KENNZEICHEN.filter((k) => fehler.message.includes(k.text)).map((k) => k.text);
        assert.deepEqual(verraten, []);
        return true;
      },
    );

    // Schon der Pfad verrät einen vorgerenderten Beitrag, auch ohne Inhalt.
    const pfadAllein = neuesVerzeichnis();
    baum(pfadAllein, { [`.next/server/app/blog/${DEMO_BLOGBEITRAEGE.uebergabe.slug}.meta`]: '{"status":200}' });
    assert.deepEqual(demodatenSuchen(pfadAllein, '.next').map((t) => t.arten), [['Demo-Blogbeitrag']]);

    // Eine erzeugte Sitemap unter public/ zählt mit.
    const oeffentlich = neuesVerzeichnis();
    baum(oeffentlich, { 'public/sitemap-0.xml': `<loc>/blog/${DEMO_BLOGBEITRAEGE.uebergabe.slug}</loc>`, 'public/bild.svg': DEMO_KUNDSCHAFT.roth.firma });
    assert.deepEqual(demodatenSuchen(oeffentlich, '.next').map((t) => t.datei), ['public/sitemap-0.xml']);

    // Die Meldung kürzt lange Listen.
    const viele = Array.from({ length: 25 }, (_, i) => ({ datei: `.next/server/app/s${i}.html`, arten: ['Demo-Bewertung'] }));
    assert.match(demodatenMeldung(viele), /… und 5 weitere/);
  });

  it('die Demokennzeichen treffen keine Konfigurationsdaten', () => {
    // Der Konfigurations-Seed legt an, was ein echter Betrieb hat: Firma,
    // Leistungen, Preise, Gebiete, Team. Ein Kennzeichen, das dort vorkommt,
    // meldete jeden sauberen Bau als verseucht. Dasselbe gilt für die
    // Vorgabetexte der Website (CMS-Register) — sie stehen auf jeder Seite.
    const konfiguration = {
      'prisma/seed.ts': readFileSync(join(WURZEL, 'prisma', 'seed.ts'), 'utf8'),
      'src/lib/cms/registry.ts': readFileSync(join(WURZEL, 'src', 'lib', 'cms', 'registry.ts'), 'utf8'),
    };
    const treffer: string[] = [];
    for (const [datei, text] of Object.entries(konfiguration)) {
      for (const k of DEMO_KENNZEICHEN) if (text.includes(k.text)) treffer.push(`${datei}: ${k.art} ${JSON.stringify(k.text)}`);
    }
    assert.deepEqual(treffer, []);
    assert.ok(DEMO_KENNZEICHEN.length >= 40, 'Kundschaft, Anfragen, Bewertungen, Galerie, Blog und Maildomain');
    assert.ok(DEMO_KENNZEICHEN.every((k) => k.text.trim().length >= 5), 'kein Kennzeichen so kurz, dass es zufällig trifft');
    // Der Lieferant des Konfigurations-Seeds liegt unter hygienecenter.example.ch — die Maildomain trifft ihn nicht.
    assert.match(konfiguration['prisma/seed.ts'], /hygienecenter\.example\.ch/);
  });

  it('der Demo-Seed hat keine eigene Fassung der Kennzeichen', () => {
    // Stünde ein Kennzeichen im Seed noch als Literal, suchte die Stolperfalle
    // nach einem Umbenennen den alten Wert — und schwiege.
    const seed = readFileSync(join(WURZEL, 'prisma', 'seed-demo.ts'), 'utf8');
    assert.match(seed, /from '\.\/demo-kennzeichen'/);
    const literale = DEMO_KENNZEICHEN.filter((k) => seed.includes(`'${k.text}'`)).map((k) => k.text);
    assert.deepEqual(literale, []);

    // Das Modul hat keine Nebenwirkung: kein Import, keine Umgebung, keine Datenbank.
    const modul = readFileSync(join(WURZEL, 'prisma', 'demo-kennzeichen.ts'), 'utf8');
    assert.doesNotMatch(modul, /^import /m);
    assert.doesNotMatch(modul, /process\.|require\(|PrismaClient|erzeugePrismaClient/);
  });
});
