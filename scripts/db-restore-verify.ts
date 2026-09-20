/**
 * Eine Sicherung zurückspielen — in eine Wegwerfdatenbank, nur zum Beweis.
 *
 *   npx tsx scripts/db-restore-verify.ts --datei <pfad.dump>
 *
 * ---------------------------------------------------------------------------
 *  Warum das ein eigenes Skript ist
 * ---------------------------------------------------------------------------
 *
 * „Eine Sicherung, die nie zurückgespielt wurde, ist eine Vermutung, keine
 * Sicherung" — der Satz steht seit Monaten in `DEPLOYMENT.md`, und bis hierher
 * war er eine Absichtserklärung. Dieses Skript macht ihn nachprüfbar:
 * Es legt eine frische Datenbank an, spielt das Archiv hinein, zählt die
 * Zeilen der fachlich wichtigen Tabellen gegen die Quelle und wirft die
 * Wegwerfdatenbank wieder weg.
 *
 * **Es läuft ausdrücklich nicht im Auslieferungsweg.** Ein zweites
 * vollständiges Zurückspielen bei jeder Auslieferung bräuchte Platz und Zeit
 * einer zweiten Produktionsdatenbank; dafür gibt es keine getrennte
 * Infrastruktur. Der Mechanismus wird hier bewiesen, und ein eigener
 * Wiederherstellungslauf kann später folgen.
 *
 * ---------------------------------------------------------------------------
 *  Der Schutzschalter
 * ---------------------------------------------------------------------------
 *
 * Ein Skript, das `DROP DATABASE` ausführt, braucht eine Schranke, die nicht
 * vom Aufrufer abhängt. Der Zielname wird deshalb **hier** erzeugt, nicht
 * entgegengenommen, und muss dem Muster `clenaris_restore_verify_<Zahl>`
 * entsprechen. Angelegt und gelöscht wird nur, was dieses Muster erfüllt —
 * `clenaris`, `clenaris_preview`, `clenaris_test` und jede Produktionsadresse
 * können es gar nicht erfüllen.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';

// eslint-disable-next-line no-restricted-imports
import { PrismaClient } from '@prisma/client';

import { verbindungAus, werkzeugPfad, type Verbindung } from './db-backup';

/** Nur dieses Muster darf angelegt und gelöscht werden. */
const ZIELMUSTER = /^clenaris_restore_verify_\d{10,}$/;

/** Namen, die auch bei einem Programmfehler nie getroffen werden dürfen. */
const NIEMALS = ['clenaris', 'clenaris_preview', 'clenaris_test', 'postgres', 'template0', 'template1'];

function pgUmgebung(v: Verbindung, datenbank = v.database): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PGHOST: v.host,
    PGPORT: v.port,
    PGUSER: v.user,
    PGPASSWORD: v.password,
    PGDATABASE: datenbank,
  };
}

/** Die Tabellen, deren Zeilenzahl etwas aussagt. */
const TABELLEN = [
  '_prisma_migrations',
  'organizations',
  'users',
  'employees',
  'customers',
  'properties',
  'quotes',
  'jobs',
  'managed_documents',
  'document_versions',
  'signature_requests',
  'device_handoff_sessions',
  'stored_files',
  'file_assets',
];

async function zaehlen(url: string): Promise<Record<string, number | string>> {
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const ergebnis: Record<string, number | string> = {};
  try {
    for (const t of TABELLEN) {
      try {
        const z = await prisma.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM "${t}"`,
        );
        ergebnis[t] = z[0]?.n ?? 0;
      } catch {
        ergebnis[t] = 'Tabelle fehlt';
      }
    }
  } finally {
    await prisma.$disconnect();
  }
  return ergebnis;
}

function argument(name: string, vorgabe = ''): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : vorgabe;
}

async function main(): Promise<void> {
  const datei = argument('datei');
  if (!datei || !existsSync(datei)) {
    console.error('❌  --datei <pfad.dump> fehlt oder zeigt auf nichts.');
    process.exit(1);
  }

  const quelleUrl =
    process.env.BACKUP_DATABASE_URL?.trim() || process.env.DIRECT_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (!quelleUrl) {
    console.error('❌  Keine Verbindungszeichenfolge für den Vergleich.');
    process.exit(1);
  }

  const quelle = verbindungAus(quelleUrl);
  const ziel = `clenaris_restore_verify_${Date.now()}`;

  if (!ZIELMUSTER.test(ziel) || NIEMALS.includes(ziel)) {
    console.error(`❌  Zielname „${ziel}" ist nicht zulässig. Abbruch.`);
    process.exit(1);
  }

  const zielUrl = (() => {
    const u = new URL(quelleUrl);
    u.pathname = `/${ziel}`;
    u.search = '';
    return u.toString();
  })();

  const psql = werkzeugPfad('psql');
  const pgRestore = werkzeugPfad('pg_restore');

  console.log('');
  console.log('  ── Wiederherstellung prüfen ─────────────────────────────────');
  console.log(`  Archiv               : ${datei}`);
  console.log(`  Grösse               : ${statSync(datei).size} Bytes`);
  console.log(`  Quelle               : ${quelle.beschreibung}`);
  console.log(`  Wegwerfdatenbank     : ${ziel}`);

  let angelegt = false;
  try {
    execFileSync(psql, ['-v', 'ON_ERROR_STOP=1', '-Atqc', `CREATE DATABASE "${ziel}"`], {
      env: pgUmgebung(quelle, 'postgres'),
      encoding: 'utf8',
      timeout: 60_000,
    });
    angelegt = true;
    console.log('  Angelegt             : ja');

    /**
     * `--no-owner` und `--no-privileges`: Die Wegwerfdatenbank gehört dem
     * Benutzer, der sie anlegt. Ohne die beiden Schalter scheitert das
     * Zurückspielen an Rollen, die es hier nicht gibt — und das wäre ein
     * Fehlschlag des Prüfaufbaus, nicht der Sicherung.
     */
    const lauf = spawnSync(
      pgRestore,
      ['--no-owner', '--no-privileges', '--exit-on-error', '--dbname', ziel, datei],
      { env: pgUmgebung(quelle, ziel), encoding: 'utf8', timeout: 30 * 60_000 },
    );
    if (lauf.status !== 0) {
      throw new Error(`pg_restore ist fehlgeschlagen: ${(lauf.stderr || '').trim().slice(0, 500)}`);
    }
    console.log('  Zurückgespielt       : ja');

    const [ausQuelle, ausZiel] = await Promise.all([zaehlen(quelleUrl), zaehlen(zielUrl)]);

    console.log('');
    console.log('  Tabelle                      Quelle   Wiederhergestellt');
    let abweichungen = 0;
    for (const t of TABELLEN) {
      const a = ausQuelle[t];
      const b = ausZiel[t];
      const gleich = String(a) === String(b);
      if (!gleich) abweichungen++;
      console.log(`  ${gleich ? ' ' : '✗'} ${t.padEnd(26)} ${String(a).padStart(7)}   ${String(b).padStart(7)}`);
    }

    if (abweichungen > 0) {
      throw new Error(`${abweichungen} Tabelle(n) weichen ab — die Sicherung ist nicht vollständig.`);
    }

    console.log('');
    console.log('  ✅  Wiederherstellung geprüft: alle Zeilenzahlen stimmen überein.');
    console.log('');
  } finally {
    if (angelegt) {
      // `WITH (FORCE)`: Prisma hält kurz nach dem Zählen noch Verbindungen.
      const weg = spawnSync(psql, ['-Atqc', `DROP DATABASE IF EXISTS "${ziel}" WITH (FORCE)`], {
        env: pgUmgebung(quelle, 'postgres'),
        encoding: 'utf8',
        timeout: 60_000,
      });
      console.log(weg.status === 0 ? `  Wegwerfdatenbank entfernt: ${ziel}` : `  ⚠ ${ziel} konnte nicht entfernt werden.`);
    }
  }
}

if (process.argv[1] && /db-restore-verify\.(ts|js)$/.test(process.argv[1])) {
  main().catch((fehler) => {
    console.error('');
    console.error(`❌  ${fehler instanceof Error ? fehler.message : String(fehler)}`);
    console.error('');
    process.exit(1);
  });
}
