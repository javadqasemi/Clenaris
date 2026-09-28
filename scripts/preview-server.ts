/**
 * Den Vorschauserver starten — für die manuelle Sichtprüfung im Browser.
 *
 *   npm run preview:server            # 127.0.0.1:3000, Vorgabe
 *   PORT=3005 npm run preview:server
 *
 * ---------------------------------------------------------------------------
 *  Warum ein Skript und nicht `npm run start:built`
 * ---------------------------------------------------------------------------
 *
 * `next start` nimmt die Umgebung, die zufällig dasteht — also `.env` und
 * damit die Entwicklungsdatenbank. Für eine Vorschau ist das genau falsch:
 * Sie soll `clenaris_preview` bedienen und sonst nichts. Dieses Skript legt
 * deshalb fest, was der Server sieht, und weigert sich, wenn der Zielname
 * nicht auf das Zeichen genau stimmt — dieselbe Schranke wie in
 * `scripts/setup-preview-db.ts`.
 *
 * Vier Festlegungen, jede aus einem eigenen Grund:
 *
 *  • `DATABASE_URL`/`DIRECT_URL` → `clenaris_preview`. Die
 *    Entwicklungsdatenbank wird nicht einmal geöffnet.
 *  • **Bindung an 127.0.0.1.** `next start` lauscht sonst auf allen
 *    Schnittstellen. Eine Vorschau mit erfundenen Kundendaten und bekannten
 *    Passwörtern gehört nicht ins Netz, auch nicht ins eigene WLAN.
 *  • `TRUSTED_PROXY_MODE=NONE` — vor dem Vorschauserver steht kein Proxy,
 *    also tut die Anwendung auch nicht so.
 *  • `CLENARIS_TEST_CACHE_DIR` — der Postausgang. Ohne ihn verschwände die
 *    Offert-E-Mail in einem Protokolleintrag, und der öffentliche Offertlink
 *    wäre nicht erreichbar: Der rohe Token steht nur in der Nachricht, in der
 *    Datenbank liegt sein Hash. Ein Anbieter ist nie beteiligt — genau
 *    deshalb schreibt `src/lib/email/client.ts` die Nachricht als Datei.
 *
 * Es baut nicht. Fehlt `.next`, sagt es das und hört auf.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { config } from 'dotenv';

import { databaseNameOf } from '../prisma/seed-guard';
import { PREVIEW_DB, previewUrlAus } from './setup-preview-db';

// `.env` nur, um `DATABASE_URL` abzuleiten und die übrigen Schlüssel
// (JWT_SECRET, Firmendaten) an den Server durchzureichen.
config();

/** Wo der Postausgang der Vorschau liegt — getrennt von dem der Prüfreihe. */
export function previewCacheDir(): string {
  return process.env.CLENARIS_PREVIEW_CACHE_DIR?.trim() || join(tmpdir(), 'clenaris-preview', 'cache');
}

function main(): void {
  const entwicklung = process.env.DATABASE_URL;
  const previewUrl = process.env.PREVIEW_DATABASE_URL ?? (entwicklung ? previewUrlAus(entwicklung) : null);
  if (!previewUrl) {
    console.error('❌  Weder PREVIEW_DATABASE_URL noch DATABASE_URL gesetzt — keine Vorschauadresse ableitbar.');
    process.exit(1);
  }

  const name = databaseNameOf(previewUrl);
  if (name !== PREVIEW_DB) {
    console.error(`❌  Ziel ist „${name}", zulässig ist ausschliesslich „${PREVIEW_DB}". Abbruch.`);
    process.exit(1);
  }
  if (!existsSync(join(process.cwd(), '.next', 'BUILD_ID'))) {
    console.error('❌  Kein Produktionsbau in .next — zuerst `npm run build` (bei gestopptem Server).');
    process.exit(1);
  }

  const port = process.env.PORT?.trim() || '3000';
  const host = process.env.PREVIEW_HOST?.trim() || '127.0.0.1';
  const cacheDir = previewCacheDir();
  mkdirSync(cacheDir, { recursive: true });

  console.log('');
  console.log(`  Vorschaudatenbank    : ${name}`);
  console.log(`  Adresse              : http://${host}:${port}`);
  console.log('  Bindung              : nur Loopback — nicht im Netz erreichbar');
  console.log('  TRUSTED_PROXY_MODE   : NONE (kein Proxy vor dem Vorschauserver)');
  console.log(`  Postausgang          : ${cacheDir}\\mail`);
  console.log('');

  const kind = spawn(
    process.execPath,
    [join('node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-H', host, '-p', port],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_ENV: 'production',
        DATABASE_URL: previewUrl,
        DIRECT_URL: previewUrl,
        TRUSTED_PROXY_MODE: 'NONE',
        CLENARIS_TEST_CACHE_DIR: cacheDir,
        /**
         * Die Vorschau meldet sich mit `Preview#2026…` an — Passwörter aus dem
         * Repository, die ein Produktionsbau sonst abweist
         * (`src/lib/auth/oeffentliche-zugangsdaten.ts`). Zugelassen werden sie
         * nur mit dieser Angabe **und** gegen `clenaris_preview`; beides
         * steht nur hier.
         */
        CLENARIS_UMGEBUNG: 'preview',
      },
    },
  );
  const beenden = () => kind.kill();
  process.on('SIGINT', beenden);
  process.on('SIGTERM', beenden);
  kind.on('exit', (code) => process.exit(code ?? 0));
}

/**
 * Nur starten, wenn diese Datei auch aufgerufen wurde.
 *
 * `prisma/seed-preview.ts` importiert `previewCacheDir()`, um den Postausgang
 * zu finden. Ohne diese Schranke startete dieser Import einen zweiten Server —
 * dieselbe Vorsichtsmassnahme wie in `prisma/seed-guard.ts`.
 */
if (process.argv[1] && /preview-server\.(ts|js)$/.test(process.argv[1])) main();
