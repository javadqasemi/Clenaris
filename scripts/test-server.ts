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
 * Neubau hier hätte die Prisma-DLL des laufenden Entwicklungsservers
 * getroffen (siehe CLAUDE.md).
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { config } from 'dotenv';

import { databaseNameOf, istTestdatenbank } from '../prisma/seed-guard';
import { PRUEF_RESEND_GEHEIMNIS, PRUEF_SICHERHEITSBERICHT_TOKEN, PRUEF_STRIPE_GEHEIMNIS } from '../tests/helpers/webhooks';

// `.env` nur, um `DATABASE_URL` abzuleiten — `next start` liest sie ohnehin selbst.
config();

function testUrlAus(entwicklungsUrl: string): string {
  const url = new URL(entwicklungsUrl);
  const name = url.pathname.replace(/^\//, '');
  if (name.endsWith('_test')) return entwicklungsUrl;
  url.pathname = `/${name}_test`;
  return url.toString();
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
  if (!existsSync(join(process.cwd(), '.next', 'BUILD_ID'))) {
    console.error('❌  Kein Produktionsbau in .next — zuerst `npm run build` (bei gestopptem Entwicklungsserver).');
    process.exit(1);
  }

  const port = process.env.PORT?.trim() || '3001';
  const cacheDir = process.env.CLENARIS_TEST_CACHE_DIR?.trim() || join(tmpdir(), 'clenaris-tests', 'cache');
  mkdirSync(cacheDir, { recursive: true });
  for (const datei of readdirSync(cacheDir)) rmSync(join(cacheDir, datei), { force: true, recursive: true });

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
    },
  });
  const beenden = () => kind.kill();
  process.on('SIGINT', beenden);
  process.on('SIGTERM', beenden);
  kind.on('exit', (code) => process.exit(code ?? 0));
}

main();
