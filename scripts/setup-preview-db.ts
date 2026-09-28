/**
 * Die Vorschaudatenbank einrichten — für die manuelle Sichtprüfung im Browser.
 *
 *   npm run db:preview:setup
 *   npm run db:preview:setup -- --frisch   # bestehende Vorschau vorher verwerfen
 *
 * ---------------------------------------------------------------------------
 *  Warum es eine dritte Datenbank gibt
 * ---------------------------------------------------------------------------
 *
 * Bisher gab es zwei: `clenaris` für das örtliche Arbeiten und `clenaris_test`
 * für die Prüfreihe. Für eine Sichtprüfung taugt beides nicht.
 *
 * Die **Entwicklungsdatenbank** nicht, weil sie der Arbeitsstand ist. Sie mit
 * erfundener Kundschaft, Offerten und Einsätzen zu füllen, damit man einmal
 * durchklicken kann, macht aus einem Arbeitsstand einen Demobestand — und die
 * Belegnummern, die dabei verbraucht werden, kommen nicht zurück.
 *
 * Die **Testdatenbank** nicht, weil die Prüfreihe dort schreibt, ändert und
 * Rollen kurzzeitig herabsetzt. Wer daneben im Browser prüft, sieht Zustände,
 * die er nicht erzeugt hat.
 *
 * Also eine dritte, die genau einen Zweck hat und jederzeit weggeworfen werden
 * darf: `clenaris_preview`.
 *
 * ---------------------------------------------------------------------------
 *  Was dieses Skript tut — und was ausdrücklich nicht
 * ---------------------------------------------------------------------------
 *
 *  1. Leitet die Adresse aus `DATABASE_URL` ab: derselbe Server, derselbe
 *     Benutzer, Name `clenaris_preview`. `PREVIEW_DATABASE_URL` übersteuert.
 *  2. **Verlangt den Namen `clenaris_preview` auf das Zeichen genau.** Nicht
 *     „enthält preview", nicht „sieht nach Vorschau aus" — gleich. Ein
 *     Musterabgleich hätte `clenaris` durchgelassen, sobald jemand die
 *     Adresse einmal anders schreibt.
 *  3. Legt die Datenbank an, falls sie fehlt. Eine bestehende wird **nicht**
 *     angefasst; ihr Zustand wird gemeldet.
 *  4. Spielt alle Migrationen ein (`prisma migrate deploy`) — nie
 *     `migrate dev`, das einen Reset vorschlagen kann, und nie `migrate reset`.
 *  5. Seedet die Konfiguration (`prisma/seed.ts`) mit **eigenen
 *     Vorschau-Zugangsdaten**, nicht mit denen aus `.env`. Die
 *     Entwicklungszugänge werden dabei weder gelesen noch verändert.
 *
 * Die Datenbank aus `DATABASE_URL` wird zu keinem Zeitpunkt beschrieben. Das
 * Skript liest sie nur, um Host, Benutzer und Namen abzuleiten.
 */

import { execFileSync } from 'node:child_process';

import { PrismaClient } from '@prisma/client';

import { databaseNameOf } from '../prisma/seed-guard';

/** Der einzige zulässige Zielname. Auf das Zeichen genau. */
export const PREVIEW_DB = 'clenaris_preview';

/**
 * Die Zugangsdaten der Vorschau.
 *
 * Fest verdrahtet und **nicht** aus `.env` gelesen: Die Vorschau soll auf
 * jeder Maschine gleich aussehen, und die Startpasswörter der Entwicklung
 * haben hier nichts verloren — weder gelesen noch kopiert. Sie gelten
 * ausschliesslich in `clenaris_preview`.
 */
export const PREVIEW_ZUGAENGE = {
  SEED_ADMIN_EMAIL: 'admin@preview.clenaris.local',
  SEED_ADMIN_PASSWORD: 'Preview#2026Admin',
  SEED_SUPERADMIN_EMAIL: 'system@preview.clenaris.local',
  SEED_SUPERADMIN_PASSWORD: 'Preview#2026System',
} as const;

export function previewUrlAus(entwicklungsUrl: string): string {
  const url = new URL(entwicklungsUrl);
  url.pathname = `/${PREVIEW_DB}`;
  return url.toString();
}

function wartungsUrl(url: string): string {
  const u = new URL(url);
  u.pathname = '/postgres';
  u.search = '';
  return u.toString();
}

async function datenbankAnlegen(previewUrl: string, frisch: boolean): Promise<'angelegt' | 'vorhanden'> {
  const client = new PrismaClient({ datasources: { db: { url: wartungsUrl(previewUrl) } } });
  try {
    if (frisch) {
      console.log(`   … bestehende Vorschaudatenbank „${PREVIEW_DB}" wird verworfen (--frisch)`);
      await client.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${PREVIEW_DB}" WITH (FORCE)`);
    }

    const vorhanden = await client.$queryRawUnsafe<{ count: bigint }[]>(
      'SELECT count(*)::bigint AS count FROM pg_database WHERE datname = $1',
      PREVIEW_DB,
    );
    if (Number(vorhanden[0]?.count ?? 0) > 0) {
      console.log(`   … „${PREVIEW_DB}" gibt es bereits — wird weiterverwendet`);
      return 'vorhanden';
    }

    await client.$executeRawUnsafe(`CREATE DATABASE "${PREVIEW_DB}"`);
    console.log(`   ✓ „${PREVIEW_DB}" angelegt`);
    return 'angelegt';
  } finally {
    await client.$disconnect();
  }
}

function lauf(befehl: string, argumente: string[], url: string, zusatz: Record<string, string> = {}): void {
  execFileSync(befehl, argumente, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      DATABASE_URL: url,
      // Prisma Migrate braucht eine Direktverbindung. Stünde hier die
      // Direktverbindung der Entwicklungsdatenbank, liefen die Migrationen in
      // die falsche Datenbank — der teuerste denkbare Fehler dieses Skripts.
      DIRECT_URL: url,
      ...zusatz,
    },
  });
}

async function main(): Promise<void> {
  const frisch = process.argv.includes('--frisch');

  const entwicklung = process.env.DATABASE_URL;
  if (!entwicklung) {
    console.error('❌  DATABASE_URL fehlt. Ohne sie lässt sich die Vorschauadresse nicht ableiten.');
    process.exit(1);
  }

  const previewUrl = process.env.PREVIEW_DATABASE_URL ?? previewUrlAus(entwicklung);
  const zielName = databaseNameOf(previewUrl);
  const entwicklungName = databaseNameOf(entwicklung);

  console.log('');
  console.log(`  Entwicklungsdatenbank (wird nicht verändert) : ${entwicklungName ?? '?'}`);
  console.log(`  Vorschaudatenbank (Ziel)                     : ${zielName ?? '?'}`);
  console.log('');

  if (zielName !== PREVIEW_DB) {
    console.error(
      [
        `❌  Ziel ist „${zielName ?? '(nicht lesbar)'}", zulässig ist ausschliesslich „${PREVIEW_DB}".`,
        '',
        '    Dieses Skript legt an, migriert und seedet. Es akzeptiert deshalb',
        '    keinen ähnlichen Namen, sondern genau diesen einen.',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }
  if (zielName === entwicklungName) {
    console.error('❌  Vorschau- und Entwicklungsdatenbank wären dieselbe. Abbruch.');
    process.exit(1);
  }

  const zustand = await datenbankAnlegen(previewUrl, frisch);

  console.log('\n▸ Migrationen (deploy — kein dev, kein reset)\n');
  lauf('npx', ['prisma', 'migrate', 'deploy'], previewUrl);

  console.log('\n▸ Konfiguration (Firma, Leistungen, Preise, Einsatzgebiet, Team)\n');
  lauf('npx', ['tsx', 'prisma/seed.ts'], previewUrl, PREVIEW_ZUGAENGE);

  console.log('');
  console.log(`  ✅  Vorschaudatenbank bereit (${zustand}).`);
  console.log('');
  console.log('  Weiter:');
  console.log('');
  console.log('      npm run db:preview:seed    # Vorschaubestand (braucht den laufenden Server)');
  console.log('');
}

/**
 * Nur ausführen, wenn diese Datei auch aufgerufen wurde.
 *
 * `prisma/seed-preview.ts` und `scripts/preview-server.ts` importieren von
 * hier den Zielnamen und die Adressableitung. Ohne diese Schranke legte jeder
 * dieser Importe eine Datenbank an und spielte Migrationen ein — dieselbe
 * Vorsichtsmassnahme wie in `prisma/seed-guard.ts`.
 */
if (process.argv[1] && /setup-preview-db\.(ts|js)$/.test(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
