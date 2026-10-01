import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  PLATZHALTER,
  baeumeVergleichen,
  inhaltNormalisieren,
  pfadNormalisieren,
  verzeichnisQuelle,
} from '../../scripts/release/bau-vergleich-regeln';

/**
 * Der Bauvergleich (`scripts/bau-vergleich.ts`), geprüft an zwei kleinen,
 * nachgebauten Bauverzeichnissen (2026-09-30).
 *
 * **Warum nachgebaut.** Zwei echte Bauten brauchen zweimal `next build` —
 * Minuten, eine Datenbank und mehr Speicher, als ein Prüflauf haben soll. Die
 * Bäume hier enthalten genau die Dateien, in denen Next je Bau würfelt
 * (`BUILD_ID`, `static/<id>`, Vorschau- und Aktionsschlüssel, Spurdateien),
 * dazu Dateien, die sich nicht unterscheiden dürfen. Geprüft wird beides:
 * Das Erwartete bleibt still, und alles andere wird gemeldet — auch ein Datum
 * im HTML, der Fall, für den das Werkzeug gebaut ist.
 *
 * **Woher die Form stammt.** Nachgemessen am 2026-10-01 an zwei echten
 * Bauten dieses Repositories (Next 15.5): Die vier zufälligen Werte stehen in
 * genau drei Dateien — `prerender-manifest.json` (`preview`),
 * `server/server-reference-manifest.json` (`encryptionKey`) und
 * `server/middleware-manifest.json` (`env` der Middleware, alle vier). Die
 * erste Fassung dieser Prüfung kannte die Middleware nicht und setzte dafür
 * in `server-reference-manifest.js` einen echten Schlüssel ein, wo Next nur
 * den Platzhalter `process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` schreibt.
 * Sie war grün, während zwei echte Bauten desselben Commits jedes Mal mit
 * Ausgang 1 endeten. Ein nachgebauter Baum ist nur so gut wie seine Treue zum
 * Original — deshalb steht hier, wo er herkommt.
 *
 * Diese Datei braucht weder Server noch Datenbank.
 */

const WURZEL = process.cwd();
const TSX = join(WURZEL, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const SKRIPT = join(WURZEL, 'scripts', 'bau-vergleich.ts');

const zwischen: string[] = [];
function neuesVerzeichnis(): string {
  const d = mkdtempSync(join(tmpdir(), 'clenaris-bauvergleich-probe-'));
  zwischen.push(d);
  return d;
}
after(() => {
  for (const d of zwischen) rmSync(d, { recursive: true, force: true });
});

const zufall = (bytes: number) => randomBytes(bytes).toString('hex');
/** Wie Next: 21 Zeichen aus dem URL-Alphabet. */
const neueBuildId = () => randomBytes(16).toString('base64url').slice(0, 21);

/** Die Schlüssel eines Baus — wie Next sie würfelt: Kennung und Schlüssel als Hex, Aktionsschlüssel als Base64. */
interface Schluessel {
  vorschauId: string;
  vorschau: string;
  vorschauVerschluesselung: string;
  aktion: string;
}

/**
 * `server/middleware-manifest.json` in der Form von Next 15.5 (Werte aus
 * einem echten Bau, Schlüssel neu gewürfelt): Die Middleware bekommt Build-ID
 * und alle vier Schlüssel unter `env`, und Next schreibt die Datei mit zwei
 * Leerzeichen eingerückt.
 */
function middlewareManifest(buildId: string, s: Schluessel, matcher: string): string {
  return JSON.stringify(
    {
      version: 3,
      middleware: {
        '/': {
          files: ['server/edge-runtime-webpack.js', 'server/src/middleware.js'],
          name: 'src/middleware',
          page: '/',
          matchers: [{ regexp: `^(?:\\/(_next\\/data\\/[^/]{1,}))?\\/admin(?:\\/((?:[^\\/#\\?]+?)(?:\\/(?:[^\\/#\\?]+?))*))?(\\.json)?[\\/#\\?]?$`, originalSource: matcher }],
          wasm: [],
          assets: [],
          env: {
            __NEXT_BUILD_ID: buildId,
            NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: s.aktion,
            __NEXT_PREVIEW_MODE_ID: s.vorschauId,
            __NEXT_PREVIEW_MODE_SIGNING_KEY: s.vorschau,
            __NEXT_PREVIEW_MODE_ENCRYPTION_KEY: s.vorschauVerschluesselung,
          },
        },
      },
      functions: {},
      sortedMiddleware: ['/'],
    },
    null,
    2,
  );
}

/**
 * Ein Bauverzeichnis, wie Next 15.5 es schreibt — soweit es für den Vergleich
 * zählt. Jeder Aufruf würfelt Build-ID und Schlüssel neu, genau wie ein Bau,
 * und legt dieselben Schlüssel in alle Manifeste, in denen Next sie ablegt.
 * `anders` überschreibt oder ergänzt Dateien (Pfad → Inhalt, `null` entfernt);
 * `matcher` setzt den Pfad, den die Middleware abdeckt.
 */
function bau(
  anders: Record<string, string | Buffer | null> = {},
  { matcher = '/admin/:path*' }: { matcher?: string } = {},
): { verzeichnis: string; buildId: string; schluessel: Schluessel } {
  const verzeichnis = neuesVerzeichnis();
  const buildId = neueBuildId();
  const schluessel: Schluessel = {
    vorschauId: zufall(16),
    vorschau: zufall(32),
    vorschauVerschluesselung: zufall(32),
    aktion: randomBytes(32).toString('base64'),
  };
  const dateien: Record<string, string | Buffer | null> = {
    BUILD_ID: buildId,
    trace: JSON.stringify([{ name: 'generate-buildid', duration: Math.random() * 1000, timestamp: Date.now() }]),
    'server/app/index.html': `<!DOCTYPE html><script src="/_next/static/${buildId}/_buildManifest.js" async=""></script><h1>Clenaris</h1>`,
    'server/app/index.rsc': `0:{"b":"${buildId}","p":"","c":["",""]}`,
    'server/app/bewertungen.html': '<h1>Bewertungen</h1><footer>Reinigung in Bern</footer>',
    [`static/${buildId}/_buildManifest.js`]: 'self.__BUILD_MANIFEST={"__rewrites":{"afterFiles":[]}};self.__BUILD_MANIFEST_CB&&self.__BUILD_MANIFEST_CB()',
    [`static/${buildId}/_ssgManifest.js`]: 'self.__SSG_MANIFEST=new Set;self.__SSG_MANIFEST_CB&&self.__SSG_MANIFEST_CB()',
    'static/chunks/main-app-5e1f6c2a.js': '(self.webpackChunk=self.webpackChunk||[]).push([[1],{}]);',
    'build-manifest.json': JSON.stringify({ lowPriorityFiles: [`static/${buildId}/_buildManifest.js`, `static/${buildId}/_ssgManifest.js`] }, null, 2),
    'prerender-manifest.json': JSON.stringify(
      {
        version: 4,
        routes: { '/': { initialRevalidateSeconds: 3600, srcRoute: '/', dataRoute: '/index.rsc' } },
        dynamicRoutes: {},
        notFoundRoutes: [],
        preview: {
          previewModeId: schluessel.vorschauId,
          previewModeSigningKey: schluessel.vorschau,
          previewModeEncryptionKey: schluessel.vorschauVerschluesselung,
        },
      },
      null,
      2,
    ),
    'server/middleware-manifest.json': middlewareManifest(buildId, schluessel, matcher),
    'server/server-reference-manifest.json': JSON.stringify(
      { node: { '7f3a': { workers: {}, layer: {} } }, edge: {}, encryptionKey: schluessel.aktion },
      null,
      2,
    ),
    // Next 15.5 schreibt hier nur den Platzhalter, nicht den Schlüssel — die Datei ist in zwei Bauten bytegleich.
    'server/server-reference-manifest.js': `self.__RSC_SERVER_MANIFEST=${JSON.stringify(
      JSON.stringify({ node: {}, edge: {}, encryptionKey: 'process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY' }),
    )}`,
    'server/app/page.js.nft.json': JSON.stringify({ version: 1, files: ['../a.js', '../b.js'] }),
    'required-server-files.json': JSON.stringify({ version: 1, appDir: '/home/runner/work/clenaris/clenaris', config: { distDir: '.next' } }),
    'media/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]),
    // Der Zwischenspeicher ist in jedem Bau anders — und gehört nicht ins Artefakt.
    'cache/webpack/server-production/0.pack': randomBytes(64),
    ...anders,
  };
  for (const [pfad, inhalt] of Object.entries(dateien)) {
    if (inhalt === null) continue;
    mkdirSync(dirname(join(verzeichnis, pfad)), { recursive: true });
    writeFileSync(join(verzeichnis, pfad), inhalt);
  }
  return { verzeichnis, buildId, schluessel };
}

/** Alle Schlüssel beider Bauten — keiner davon darf in einem Bericht oder in der Ausgabe stehen. */
const alleSchluessel = (...baeume: { schluessel: Schluessel }[]) => baeume.flatMap((b) => Object.values(b.schluessel));

function vergleichLaufen(a: string, b: string, bericht: string) {
  return spawnSync(process.execPath, [TSX, SKRIPT, a, b, '--bericht', bericht], { cwd: WURZEL, encoding: 'utf8' });
}

describe('Bauvergleich', () => {
  it('Build-ID, Vorschau- und Aktionsschlüssel sind erwartete Unterschiede', () => {
    const a = bau();
    // Die Dateiliste der Node-Dateiverfolgung in anderer Reihenfolge — wie bei parallelem Bau.
    const b = bau({ 'server/app/page.js.nft.json': JSON.stringify({ version: 1, files: ['../b.js', '../a.js'] }) });
    assert.notEqual(a.buildId, b.buildId, 'zwei Bauten, zwei Build-IDs');

    const befund = baeumeVergleichen(verzeichnisQuelle(a.verzeichnis), verzeichnisQuelle(b.verzeichnis));
    assert.deepEqual(befund.unerwartet, [], 'nichts Unerwartetes');
    const erwartet = Object.fromEntries(befund.erwartet.map((e) => [e.pfad, e.abweichungen]));
    assert.deepEqual(erwartet, {
      BUILD_ID: ['build-id'],
      'build-manifest.json': ['build-id'],
      'prerender-manifest.json': ['vorschau-schluessel'],
      'server/app/index.html': ['build-id'],
      'server/app/index.rsc': ['build-id'],
      // Build-ID und alle vier Schlüssel unter `env` der Middleware — bis 2026-10-01 der Grund für Ausgang 1 bei jedem echten Bau.
      'server/middleware-manifest.json': ['aktionsschluessel', 'build-id', 'vorschau-schluessel'],
      'server/server-reference-manifest.json': ['aktionsschluessel'],
      [`static/${PLATZHALTER.buildId}/_buildManifest.js`]: ['build-id-verzeichnis'],
      [`static/${PLATZHALTER.buildId}/_ssgManifest.js`]: ['build-id-verzeichnis'],
      trace: ['spurdatei'],
      'server/app/page.js.nft.json': ['spurdatei'],
    });
    assert.ok(befund.gleich >= 5, 'Bündel, Bild, statische Seite und Serverdateien sind gleich');
    assert.ok(!befund.erwartet.some((e) => e.pfad.startsWith('cache/')), 'der Zwischenspeicher wird nicht verglichen');

    // Der Platzhalter in server-reference-manifest.js ist kein Unterschied; trüge
    // eine spätere Fassung dort den Schlüssel, wäre er erwartet, nicht gemeldet.
    const mitSchluessel = (schluessel: string) =>
      Buffer.from(`self.__RSC_SERVER_MANIFEST=${JSON.stringify(JSON.stringify({ node: {}, edge: {}, encryptionKey: schluessel }))}`);
    const jsA = inhaltNormalisieren('server/server-reference-manifest.js', mitSchluessel(a.schluessel.aktion), a.buildId);
    const jsB = inhaltNormalisieren('server/server-reference-manifest.js', mitSchluessel(b.schluessel.aktion), b.buildId);
    assert.equal(jsA.text, jsB.text);
    assert.deepEqual(jsA.abweichungen, ['aktionsschluessel']);

    // Über die Kommandozeile: Ausgang 0 und ein Bericht, der dasselbe sagt.
    const bericht = join(neuesVerzeichnis(), 'bericht.json');
    const lauf = vergleichLaufen(a.verzeichnis, b.verzeichnis, bericht);
    assert.equal(lauf.status, 0, `${lauf.stdout}\n${lauf.stderr}`);
    assert.match(lauf.stdout, /ERGEBNIS: nur erwartete Unterschiede/);
    const text = readFileSync(bericht, 'utf8');
    const inhalt = JSON.parse(text) as { ergebnis: string; unerwartet: unknown[]; buildIdA: string; buildIdB: string };
    assert.equal(inhalt.ergebnis, 'nur-erwartete-unterschiede');
    assert.deepEqual(inhalt.unerwartet, []);
    assert.equal(inhalt.buildIdA, a.buildId);
    // Kein Schlüssel eines Baus im Bericht — der Vorschauschlüssel öffnet den Entwurfsmodus der Website.
    assert.deepEqual(
      alleSchluessel(a, b).filter((s) => text.includes(s) || lauf.stdout.includes(s)),
      [],
      'kein Schlüssel steht im Bericht oder in der Ausgabe',
    );

    // Die Normalisierung einzeln: Pfad und Inhalt.
    assert.equal(pfadNormalisieren(`static/${a.buildId}/x.js`, a.buildId), `static/${PLATZHALTER.buildId}/x.js`);
    assert.equal(pfadNormalisieren(`server/${a.buildId}/x.js`, a.buildId), `server/${a.buildId}/x.js`, 'nur static/<id>');
    const normiert = inhaltNormalisieren('server/app/index.html', Buffer.from(`/_next/static/${a.buildId}/_buildManifest.js`), a.buildId);
    assert.equal(normiert.text, `/_next/static/${PLATZHALTER.buildId}/_buildManifest.js`);
    assert.deepEqual(normiert.abweichungen, ['build-id']);
  });

  it('jeder andere Unterschied wird gemeldet', () => {
    const a = bau({ 'server/app/bewertungen.html': '<h1>Bewertungen</h1><footer>Stand: 30.09.2026 15:29</footer>' });
    // Zweites Argument: Die Schlüssel der Middleware werden normalisiert, ein anderer Pfadbereich nicht.
    const b = bau({
      // Das Baudatum im HTML — der Fall, für den der Vergleich gebaut ist.
      'server/app/bewertungen.html': '<h1>Bewertungen</h1><footer>Stand: 30.09.2026 15:31</footer>',
      // Ein anderes Bündel (anderer Inhalt, anderer Hash im Namen).
      'static/chunks/main-app-5e1f6c2a.js': null,
      'static/chunks/main-app-9b0c77d1.js': '(self.webpackChunk=self.webpackChunk||[]).push([[2],{}]);',
      // Eine Seite, die nur in einem Bau existiert.
      'server/app/neu.html': '<h1>Neu</h1>',
      // Vorschauschlüssel werden normalisiert, eine andere Revalidierung nicht.
      'prerender-manifest.json': JSON.stringify({
        version: 4,
        routes: { '/': { initialRevalidateSeconds: 60, srcRoute: '/', dataRoute: '/index.rsc' } },
        dynamicRoutes: {},
        notFoundRoutes: [],
        preview: { previewModeId: zufall(16), previewModeSigningKey: zufall(32), previewModeEncryptionKey: zufall(32) },
      }),
      // encryptionKey wird normalisiert, eine andere Aktion nicht.
      'server/server-reference-manifest.json': JSON.stringify({ node: { '9c1d': { workers: {}, layer: {} } }, edge: {}, encryptionKey: zufall(32) }),
      // Ein anderer Projektpfad: der Versuchsaufbau stimmt nicht — gemeldet, nicht geraten.
      'required-server-files.json': JSON.stringify({ version: 1, appDir: '/tmp/anderswo', config: { distDir: '.next' } }),
      // Ein Byte anders, beide ungültiges UTF-8: als UTF-8 gelesen wären beide „�" und gleich.
      'media/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xfe, 0x00]),
    }, { matcher: '/konto/:path*' });

    const befund = baeumeVergleichen(verzeichnisQuelle(a.verzeichnis), verzeichnisQuelle(b.verzeichnis));
    const gemeldet = Object.fromEntries(befund.unerwartet.map((u) => [u.pfad, u.art]));
    assert.deepEqual(gemeldet, {
      'media/logo.png': 'inhalt',
      'prerender-manifest.json': 'inhalt',
      'required-server-files.json': 'inhalt',
      'server/app/bewertungen.html': 'inhalt',
      'server/app/neu.html': 'nur-in-b',
      'server/middleware-manifest.json': 'inhalt',
      'server/server-reference-manifest.json': 'inhalt',
      'static/chunks/main-app-5e1f6c2a.js': 'nur-in-a',
      'static/chunks/main-app-9b0c77d1.js': 'nur-in-b',
    });
    // Das Erwartete bleibt trotzdem erwartet — ein Befund verdeckt den anderen nicht.
    assert.ok(befund.erwartet.some((e) => e.pfad === 'BUILD_ID'));
    const datum = befund.unerwartet.find((u) => u.pfad === 'server/app/bewertungen.html');
    assert.match(datum?.auszugA ?? '', /15:29/);
    assert.match(datum?.auszugB ?? '', /15:31/);

    // Eine Zeichenkette, die wie eine Build-ID aussieht, aber keine ist, wird nicht weggeräumt.
    const fremd = neueBuildId();
    const ohneFremd = inhaltNormalisieren('server/app/x.html', Buffer.from(`<p>${fremd}</p>`), a.buildId);
    assert.equal(ohneFremd.text, `<p>${fremd}</p>`);
    assert.deepEqual(ohneFremd.abweichungen, []);

    // Über die Kommandozeile: Ausgang 1, Bericht mit allen Befunden.
    const bericht = join(neuesVerzeichnis(), 'unterordner', 'bericht.json');
    const lauf = vergleichLaufen(a.verzeichnis, b.verzeichnis, bericht);
    assert.equal(lauf.status, 1, `${lauf.stdout}\n${lauf.stderr}`);
    assert.match(lauf.stdout, /ERGEBNIS: unerwartete Unterschiede/);
    assert.match(lauf.stdout, /server\/app\/bewertungen\.html — Inhalt ab Byte/);
    const inhalt = JSON.parse(readFileSync(bericht, 'utf8')) as { ergebnis: string; unerwartet: { pfad: string }[] };
    assert.equal(inhalt.ergebnis, 'unerwartete-unterschiede');
    assert.equal(inhalt.unerwartet.length, 9);
  });

  it('ein Aufruf, der nichts vergleichen kann, scheitert', () => {
    const a = bau();
    const ohneBau = neuesVerzeichnis();
    const bericht = join(neuesVerzeichnis(), 'bericht.json');
    const lauf = (...args: string[]) => spawnSync(process.execPath, [TSX, SKRIPT, ...args], { cwd: WURZEL, encoding: 'utf8' });

    assert.equal(lauf(a.verzeichnis).status, 1, 'nur ein Verzeichnis');
    assert.equal(lauf(a.verzeichnis, ohneBau, '--bericht', bericht).status, 1, 'ohne BUILD_ID');
    assert.match(lauf(a.verzeichnis, ohneBau).stderr, /keine BUILD_ID/);
    assert.equal(lauf(a.verzeichnis, a.verzeichnis).status, 1, 'ein Verzeichnis mit sich selbst beweist nichts');
    assert.equal(lauf(a.verzeichnis, join(ohneBau, 'fehlt')).status, 1, 'ein fehlendes Verzeichnis');
    assert.equal(lauf(a.verzeichnis, bau().verzeichnis, '--bericht').status, 1, '--bericht ohne Datei');
  });
});
