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

import { verbindungAus, werkzeugPfad, type Verbindung } from './db-backup';
import { melden } from './security/melden';
import { erzeugePrismaClient } from '../src/lib/prisma-client';

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
  /*
    Seit Wave 21: die Belege, die das Gesetz aufbewahren lässt (Art. 958f OR,
    zehn Jahre), und die Tabellen, die per Trigger nur anwachsen dürfen. Genau
    bei ihnen wäre ein stilles Fehlen am teuersten — und die Trigger machen
    das Zurückspielen erst interessant: `pg_restore` muss die Daten laden,
    *bevor* es die Sperrtrigger anlegt, sonst scheitert es an ihnen. Die
    Liste davor stammte aus Gate 4 und kannte weder Finanzen noch Lohn.
  */
  'invoices',
  'invoice_items',
  'payments',
  'credit_notes',
  'payslips',
  'payslip_lines',
  'salary_certificates',
  'contracts',
  'contract_versions',
  'complaints',
  'stock_movements',
  'equipment_maintenances',
  'site_visits',
  'signature_events',
  'audit_logs',
];

async function zaehlen(url: string): Promise<Record<string, number | string>> {
  const prisma = erzeugePrismaClient({ url });
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
    /*
      Gleiche Zeilen beweisen nicht, dass die *Schranken* mitgekommen sind:
      die Sperrtrigger (Finanzbelege, Lohn, Signaturereignisse) und die
      Teilindizes (eine offene Annahme je Offerte, …) stehen in handgeschriebenem
      SQL der Migrationen, nicht im Prisma-Schema. Eine Wiederherstellung ohne
      sie liefe — und nähme stillschweigend Änderungen an, die sonst die
      Datenbank verweigert. Deshalb werden sie mitgezählt, mit Namen gebildet,
      damit eine Abweichung nicht nur eine Zahl ist.
    */
    const trigger = await prisma.$queryRawUnsafe<{ n: number; namen: string }[]>(
      `SELECT count(*)::int AS n, coalesce(md5(string_agg(tgname, ',' ORDER BY tgname)), '') AS namen
         FROM pg_trigger WHERE NOT tgisinternal`,
    );
    ergebnis['(Trigger)'] = `${trigger[0]?.n ?? 0}/${(trigger[0]?.namen ?? '').slice(0, 8)}`;
    const teilindizes = await prisma.$queryRawUnsafe<{ n: number; namen: string }[]>(
      `SELECT count(*)::int AS n, coalesce(md5(string_agg(indexname, ',' ORDER BY indexname)), '') AS namen
         FROM pg_indexes WHERE schemaname = 'public' AND indexdef ILIKE '% WHERE %'`,
    );
    ergebnis['(Teilindizes)'] = `${teilindizes[0]?.n ?? 0}/${(teilindizes[0]?.namen ?? '').slice(0, 8)}`;
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
    for (const t of [...TABELLEN, '(Trigger)', '(Teilindizes)']) {
      const a = ausQuelle[t];
      const b = ausZiel[t];
      const gleich = String(a) === String(b);
      if (!gleich) abweichungen++;
      console.log(`  ${gleich ? ' ' : '✗'} ${t.padEnd(26)} ${String(a).padStart(11)}   ${String(b).padStart(11)}`);
    }

    if (abweichungen > 0) {
      throw new Error(`${abweichungen} Tabelle(n) weichen ab — die Sicherung ist nicht vollständig.`);
    }

    console.log('');
    console.log('  ✅  Wiederherstellung geprüft: alle Zeilenzahlen stimmen überein.');
    console.log('');
    await melden(
      {
        quelle: 'BACKUP',
        status: 'OK',
        erstelltAm: new Date().toISOString(),
        zusammenfassung: `Wiederherstellungsprobe bestanden: ${TABELLEN.length} Tabellen, Trigger und Teilindizes gleich.`,
        kennzahlen: { wiederherstellungGeprueftAm: new Date().toISOString().slice(0, 10), wiederherstellungErgebnis: 'bestanden' },
      },
      (z) => console.log(`  ${z}`),
    );
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
  main().catch(async (fehler) => {
    const meldung = fehler instanceof Error ? fehler.message : String(fehler);
    console.error('');
    console.error(`❌  ${meldung}`);
    console.error('');
    await melden(
      {
        quelle: 'BACKUP',
        status: 'KRITISCH',
        erstelltAm: new Date().toISOString(),
        zusammenfassung: 'Wiederherstellungsprobe gescheitert — die Sicherung ist nicht nachweislich verwendbar.',
        befunde: [{ titel: 'Wiederherstellungsprobe gescheitert', schwere: 'kritisch', details: meldung.slice(0, 1000) }],
        kennzahlen: { wiederherstellungGeprueftAm: new Date().toISOString().slice(0, 10), wiederherstellungErgebnis: 'gescheitert' },
      },
      (z) => console.error(`  ${z}`),
    );
    process.exit(1);
  });
}
