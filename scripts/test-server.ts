/**
 * Den Testserver starten — deterministisch, gegen die Testdatenbank.
 *
 *   npm run test:server            # Port 3001, Vorgabe
 *   PORT=3002 npm run test:server
 *
 * ---------------------------------------------------------------------------
 *  Warum ein Skript und nicht drei Zeilen in der README
 * ---------------------------------------------------------------------------
 *
 * Bis hierher stand in `tests/README.md` eine Handfolge: Adresse ableiten,
 * zwei Variablen setzen, `next start -p 3001`. Was dort *nicht* stand — und
 * deshalb von Maschine zu Maschine verschieden war —, war die Umgebung, in
 * der die Prüfreihe die Anwendung sieht: Welchem Proxy-Kopf glaubt sie? Wo
 * liegen die Rate-Limit-Zähler? Eine Reihe, deren Ergebnis von der
 * persönlichen `.env` abhängt, ist keine Prüfung, sondern eine Beobachtung.
 *
 * Dieses Skript legt die Umgebung fest:
 *
 *  • `DATABASE_URL`/`DIRECT_URL` → die Testdatenbank (abgeleitet wie in
 *    `setup-test-db.ts`; `TEST_DATABASE_URL` übersteuert). Ein Name, der
 *    nicht als Testdatenbank erkennbar ist, wird verweigert.
 *  • `TRUSTED_PROXY_MODE=NONE` — vor dem Testserver steht kein Proxy, also
 *    tut die Anwendung auch nicht so. Alle Aufrufer teilen sich damit den
 *    Schlüssel „unbekannt"; genau deshalb braucht es den nächsten Punkt.
 *  • `CLENARIS_TEST_CACHE_DIR` — die Rate-Limit-Zähler liegen als Dateien
 *    im Temp-Verzeichnis, und `tests/helpers/rate-limit.ts` leert sie
 *    zwischen den Dateien. Das Verzeichnis wird beim Start geleert.
 *
 * Es baut nicht. Fehlt `.next`, sagt es das und hört auf — ein stiller
 * Neubau hier schriebe in das Bauverzeichnis, aus dem womöglich gerade ein
 * anderer Server läuft, und zerstörte ihn.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { config } from 'dotenv';

import { databaseNameOf, istTestdatenbank } from '../prisma/seed-guard';
import { artefaktManifestSchema, MANIFEST_FORMAT } from '../src/lib/release/manifest';
import {
  PRUEF_AUSFUEHRER_SCHLUESSEL,
  PRUEF_AUSFUEHRER_TOKEN,
  PRUEF_IDENTITAET_COMMIT,
  PRUEF_RESEND_GEHEIMNIS,
  PRUEF_SICHERHEITSBERICHT_TOKEN,
  PRUEF_STRIPE_GEHEIMNIS,
} from '../tests/helpers/webhooks';

// `.env` nur, um `DATABASE_URL` abzuleiten — `next start` liest sie ohnehin selbst.
config();

function testUrlAus(entwicklungsUrl: string): string {
  const url = new URL(entwicklungsUrl);
  const name = url.pathname.replace(/^\//, '');
  if (name.endsWith('_test')) return entwicklungsUrl;
  url.pathname = `/${name}_test`;
  return url.toString();
}

/**
 * Das Prüfmanifest schreiben (2026-09-30) und seinen Pfad liefern.
 *
 * Eine Instanz belegt ihre Identität aus `RELEASE.json` und `BUILD_ID` in
 * ihrem Verzeichnis. Ein Prüfbau ist kein gepacktes Artefakt und hat kein
 * `RELEASE.json` — ohne dieses Manifest liefe die Prüfreihe gegen eine
 * Instanz, die sich nicht ausweisen kann, und jede Prüfung des
 * Release-Vertrags („erfolgreich nur, wenn die Instanz das Ziel belegt")
 * wäre nicht erreichbar.
 *
 * Die `BUILD_ID` ist die echte des Baus: Der Abgleich Manifest ↔ Bau läuft
 * also auch in der Prüfreihe, nur Commit und Herkunft sind festgelegt. Das
 * Manifest wird gegen denselben Vertrag geparst wie ein echtes, damit eine
 * Formänderung hier auffällt und nicht erst auf dem Server. `auslieferbar`
 * ist fest `false`: Ein Prüfmanifest beschreibt nie etwas Auslieferbares.
 */
function pruefManifestSchreiben(cacheDir: string, dist: string): string {
  const wurzel = process.cwd();
  const paket = JSON.parse(readFileSync(join(wurzel, 'package.json'), 'utf8')) as { version: string };
  const next = JSON.parse(readFileSync(join(wurzel, 'node_modules', 'next', 'package.json'), 'utf8')) as { version: string };
  const migrationen = readdirSync(join(wurzel, 'prisma', 'migrations'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(wurzel, 'prisma', 'migrations', e.name, 'migration.sql')))
    .map((e) => e.name)
    .sort();
  const manifest = artefaktManifestSchema.parse({
    format: MANIFEST_FORMAT,
    anwendung: 'clenaris',
    version: paket.version,
    commit: PRUEF_IDENTITAET_COMMIT,
    unsauber: false,
    buildId: readFileSync(join(wurzel, dist, 'BUILD_ID'), 'utf8').trim(),
    distDir: dist,
    quelleZeitUtc: '2026-01-01T00:00:00.000Z',
    node: process.version,
    npm: 'pruefreihe',
    plattform: `${process.platform}-${process.arch}`,
    next: next.version,
    sperrdateiSha256: createHash('sha256').update(readFileSync(join(wurzel, 'package-lock.json'))).digest('hex'),
    seitenUrl: null,
    reactKorrektur: 'geprueft',
    mitModulen: true,
    migrationen,
    ci: null,
    auslieferbar: false,
  });
  const pfad = join(cacheDir, 'pruef-release.json');
  writeFileSync(pfad, `${JSON.stringify(manifest, null, 2)}\n`);
  return pfad;
}

function main(): void {
  const entwicklung = process.env.DATABASE_URL;
  const testUrl = process.env.TEST_DATABASE_URL ?? (entwicklung ? testUrlAus(entwicklung) : null);
  if (!testUrl) {
    console.error('❌  Weder TEST_DATABASE_URL noch DATABASE_URL gesetzt — keine Testadresse ableitbar.');
    process.exit(1);
  }
  const name = databaseNameOf(testUrl);
  if (!istTestdatenbank(name)) {
    console.error(`❌  „${name}" ist nicht als Testdatenbank erkennbar. Abbruch.`);
    process.exit(1);
  }
  /**
   * Der Bau liegt in `NEXT_DIST_DIR` (sonst `.next`), und er ist erst fertig,
   * wenn alle drei Dateien da sind (2026-09-27). Vorher prüfte diese Stelle
   * fest `.next/BUILD_ID`: Mit `NEXT_DIST_DIR` sah sie das falsche
   * Verzeichnis, und `BUILD_ID` allein entsteht früh im Bau — ein halber Bau
   * galt als vorhanden (CLAUDE.md, „Don't treat .next/BUILD_ID as build finished").
   */
  const dist = process.env.NEXT_DIST_DIR?.trim() || '.next';
  const fehlend = ['BUILD_ID', 'routes-manifest.json', 'prerender-manifest.json'].filter((d) => !existsSync(join(process.cwd(), dist, d)));
  if (fehlend.length > 0) {
    console.error(`❌  Kein vollständiger Produktionsbau in ${dist} (fehlt: ${fehlend.join(', ')}) — zuerst \`npm run build\` (bei gestopptem Entwicklungsserver).`);
    process.exit(1);
  }

  const port = process.env.PORT?.trim() || '3001';
  const cacheDir = process.env.CLENARIS_TEST_CACHE_DIR?.trim() || join(tmpdir(), 'clenaris-tests', 'cache');
  mkdirSync(cacheDir, { recursive: true });
  for (const datei of readdirSync(cacheDir)) rmSync(join(cacheDir, datei), { force: true, recursive: true });
  const pruefManifest = pruefManifestSchreiben(cacheDir, dist);

  console.log('');
  console.log(`  Testdatenbank        : ${name}`);
  console.log(`  Port                 : ${port}`);
  console.log('  TRUSTED_PROXY_MODE   : NONE (kein Proxy vor dem Testserver)');
  console.log(`  Rate-Limit-Zähler    : ${cacheDir} (geleert)`);
  console.log('');
  console.log(`  Prüfungen:  $env:TEST_BASE_URL = 'http://127.0.0.1:${port}'; npm test`);
  console.log('');

  const kind = spawn(process.execPath, [join('node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', port], {
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      DATABASE_URL: testUrl,
      DIRECT_URL: testUrl,
      TRUSTED_PROXY_MODE: 'NONE',
      CLENARIS_TEST_CACHE_DIR: cacheDir,
      /**
       * Ein festes Webhook-Geheimnis nur für die Prüfreihe (Wave 14): So lässt
       * sich die Signaturprüfung von `/api/webhooks/resend` mit einer echten,
       * gültigen Signatur prüfen — und mit einer falschen. Dasselbe Geheimnis
       * steht in `tests/helpers/webhooks.ts`. Es verlässt die Testumgebung nie.
       */
      RESEND_WEBHOOK_SECRET: PRUEF_RESEND_GEHEIMNIS,
      /** Berichtseingang der Sicherheitszentrale (`sicherheitsberichte.test.ts`). */
      SECURITY_REPORT_TOKEN: PRUEF_SICHERHEITSBERICHT_TOKEN,
      /**
       * Stripe-Ereignisse mit echter Signatur (`zahlungsbuch.test.ts`). Nur
       * das Webhook-Geheimnis, **kein** API-Schlüssel: Die Zahlungsstrecke
       * bleibt für alle anderen Prüfungen abgeschaltet, wie bisher.
       */
      STRIPE_WEBHOOK_SECRET: PRUEF_STRIPE_GEHEIMNIS,
      /**
       * Schnittstelle des Release-Ausführers (`release-center.test.ts`). Die
       * Instanz heisst `test` — ein Ausführer, der „production" verlangt,
       * wird abgewiesen, und genau das prüft die Reihe.
       */
      RELEASE_EXECUTOR_TOKEN: PRUEF_AUSFUEHRER_TOKEN,
      RELEASE_EXECUTOR_SIGNING_KEY: PRUEF_AUSFUEHRER_SCHLUESSEL,
      CLENARIS_UMGEBUNG: 'test',
      /**
       * Identität der Instanz (2026-09-30): siehe `pruefManifestSchreiben`.
       * Wirkt nur, weil `CLENARIS_UMGEBUNG` hier `test` ist.
       */
      CLENARIS_PRUEF_RELEASE_MANIFEST: pruefManifest,
      /**
       * Die eigene Besuchsmessung ist seit 2026-09-30 ohne ausdrückliches
       * „an" aus — in der Produktion bis zur rechtlichen Prüfung der
       * Datenschutzerklärung (TA-02). Die Prüfreihe misst, was die Messung
       * tut, also schaltet sie sie ein; den ausgeschalteten Zustand prüft
       * `laufzeit-konfiguration.test.ts` an einer eigenen Instanz.
       */
      CLENARIS_BESUCHSMESSUNG: 'an',
    },
  });
  const beenden = () => kind.kill();
  process.on('SIGINT', beenden);
  process.on('SIGTERM', beenden);
  kind.on('exit', (code) => process.exit(code ?? 0));
}

main();
