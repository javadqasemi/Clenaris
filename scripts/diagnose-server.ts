/**
 * Den **Diagnoseserver** starten — Entwicklungsbau, gegen die Testdatenbank.
 *
 *   npm run diagnose:server          # Port 3002, Bauverzeichnis .next-diagnose
 *
 * ---------------------------------------------------------------------------
 *  Wozu ein zweiter Server
 * ---------------------------------------------------------------------------
 *
 * Die Browserreihe fährt bewusst gegen den **Produktionsbau** (`test-server.ts`,
 * Port 3001). Das ist richtig so: Nur dort gilt dieselbe Minifizierung,
 * dieselbe Bündelung und dasselbe React wie im Betrieb, und genau dort ist der
 * zeitweise Hydrationsfehler aufgetreten.
 *
 * Nur sagt der Produktionsbau nicht, **was** nicht zusammenpasste. React
 * verdichtet die Meldung zu „Minified React error #418" mit einem einzigen
 * Argument („HTML" oder „text"). Welche Stelle im Baum auseinanderlief,
 * welches Element der Server geschrieben und welches der Browser erwartet hat
 * — das steht ausschliesslich im Entwicklungsbau, der die vollständige
 * Gegenüberstellung ausgibt.
 *
 * Bis hierher war dieser Weg versperrt: `next dev` schreibt in dasselbe
 * `.next`, in dem der Produktionsbau liegt. Wer die Ursache suchte, zerstörte
 * die Umgebung, in der der Fehler auftrat. Seit `next.config.ts` das
 * Bauverzeichnis aus `NEXT_DIST_DIR` liest, laufen beide nebeneinander.
 *
 * **Dieser Server ersetzt die Produktionsreihe nicht.** Er ist ein
 * Untersuchungswerkzeug: Ein Befund von hier wird am Produktionsbau
 * nachgewiesen, nicht umgekehrt. Ein Fehler, der nur hier auftritt, kann eine
 * Eigenheit des Entwicklungsbaus sein (React prüft dort strenger, `StrictMode`
 * rendert doppelt); einer, der nur dort auftritt, ist der ernstere Fall.
 *
 * ---------------------------------------------------------------------------
 *  Was festgelegt wird
 * ---------------------------------------------------------------------------
 *
 * Dieselbe Umgebung wie `test-server.ts` — Testdatenbank mit Namensprüfung,
 * `TRUSTED_PROXY_MODE=NONE`, dateibasierte Rate-Limit-Zähler —, damit ein
 * Befund vergleichbar bleibt. Zwei Unterschiede, beide mit Absicht:
 *
 *  • **Eigener Port (3002).** Der Produktionstestserver darf weiterlaufen;
 *    man will beide nacheinander gegen denselben Fall fahren können.
 *  • **Eigenes Zählerverzeichnis.** Sonst leerte ein Diagnoselauf die
 *    Rate-Limit-Zähler des laufenden Produktionstestservers — und die
 *    Produktionsreihe hätte plötzlich eine Umgebung, die jemand anders
 *    angefasst hat.
 *
 * `next dev` baut beim ersten Aufruf je Seite; der erste Seitenaufruf dauert
 * deshalb spürbar länger. Das ist kein Fehler, sondern der Preis dafür, dass
 * die Meldung lesbar ist.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { config } from 'dotenv';

import { databaseNameOf, istTestdatenbank } from '../prisma/seed-guard';
import { DIAGNOSE_CACHE_DIR, DIAGNOSE_DIST_DIR, DIAGNOSE_PORT } from './diagnose-umgebung';

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

  const port = process.env.PORT?.trim() || DIAGNOSE_PORT;
  const distDir = process.env.NEXT_DIST_DIR?.trim() || DIAGNOSE_DIST_DIR;
  if (distDir === '.next') {
    // Der ganze Zweck dieses Skripts ist, den Produktionsbau stehen zu lassen.
    console.error('❌  NEXT_DIST_DIR darf für den Diagnoseserver nicht `.next` sein — das ist der Produktionsbau.');
    process.exit(1);
  }
  const cacheDir = process.env.CLENARIS_TEST_CACHE_DIR?.trim() || DIAGNOSE_CACHE_DIR;
  mkdirSync(cacheDir, { recursive: true });
  for (const datei of readdirSync(cacheDir)) rmSync(join(cacheDir, datei), { force: true, recursive: true });

  console.log('');
  console.log('  Diagnoseserver (Entwicklungsbau — unminifizierte React-Meldungen)');
  console.log(`  Testdatenbank        : ${name}`);
  console.log(`  Port                 : ${port}`);
  console.log(`  Bauverzeichnis       : ${distDir} (der Produktionsbau in .next bleibt unberührt)`);
  console.log('  TRUSTED_PROXY_MODE   : NONE');
  console.log(`  Rate-Limit-Zähler    : ${cacheDir} (geleert)`);
  console.log('');

  const kind = spawn(
    process.execPath,
    [join('node_modules', 'next', 'dist', 'bin', 'next'), 'dev', '-p', port],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_ENV: 'development',
        NEXT_DIST_DIR: distDir,
        DATABASE_URL: testUrl,
        DIRECT_URL: testUrl,
        TRUSTED_PROXY_MODE: 'NONE',
        CLENARIS_TEST_CACHE_DIR: cacheDir,
        // Wie `scripts/test-server.ts`: Die eigene Besuchsmessung ist seit
        // 2026-09-30 ohne ausdrückliches „an" aus. Der Diagnoseserver fährt
        // dieselbe Browserreihe — ohne den Schalter scheiterten die Fälle der
        // Besuchsmessung hier, obwohl sie gegen den Prüfserver grün sind.
        CLENARIS_BESUCHSMESSUNG: 'an',
      },
    },
  );
  const beenden = () => kind.kill();
  process.on('SIGINT', beenden);
  process.on('SIGTERM', beenden);
  kind.on('exit', (code) => process.exit(code ?? 0));
}

main();

