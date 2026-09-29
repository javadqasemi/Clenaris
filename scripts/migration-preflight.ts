/**
 * Migrations-Vorprüfung — lesend, vor `prisma migrate deploy`.
 *
 *   npx tsx scripts/migration-preflight.ts
 *
 * ---------------------------------------------------------------------------
 *  Die Frage, die hier beantwortet wird
 * ---------------------------------------------------------------------------
 *
 * Eine additive Migration ist harmlos — bis sie eine **Eindeutigkeit**
 * verlangt, die die vorhandenen Daten nicht erfüllen. Dann bricht
 * `migrate deploy` mittendrin ab: Ein Teil der Migration ist angewandt, der
 * Rest nicht, und die Anwendung läuft auf einem Schema, das es so nie geben
 * sollte. Der Rücksprung in `deploy.sh` stellt ausdrücklich nur die Anwendung
 * wieder her, nicht das Schema.
 *
 * Diese Vorprüfung stellt die Frage **vorher** und ausschliesslich lesend.
 *
 * **Der konkrete Anlass.** In der anstehenden Reihe steht
 *
 *     CREATE UNIQUE INDEX "file_assets_storedFileId_key"
 *       ON "file_assets"("storedFileId");
 *
 * und `file_assets` gibt es in der Produktion längst. Zwei Assets, die auf
 * dieselbe Ablagezeile zeigen, und die Auslieferung scheitert. Alle übrigen
 * Eindeutigkeiten der Reihe betreffen Tabellen, die dieselbe Reihe erst
 * anlegt — dort ist ein Konflikt strukturell ausgeschlossen.
 *
 * Genau diese Unterscheidung trifft das Skript selbst, statt sie zu
 * behaupten: Es liest die noch nicht angewandten Migrationen, sammelt jede
 * Eindeutigkeitsbedingung daraus ein und prüft **nur** die, deren Tabelle
 * heute schon existiert.
 *
 * ---------------------------------------------------------------------------
 *  Grenzen
 * ---------------------------------------------------------------------------
 *
 * Erkannt werden `CREATE UNIQUE INDEX` (auch als Teilindex mit `WHERE`) und
 * `ALTER TABLE … ADD CONSTRAINT … UNIQUE (…)`. Fremdschlüssel, Prüfregeln und
 * `NOT NULL` ohne Vorgabewert sind nicht abgedeckt; sie kommen in dieser
 * Reihe nicht vor, und eine halbe Deckung, die vollständig aussieht, wäre
 * schlechter als eine benannte Lücke. Wer eine solche Migration schreibt,
 * erweitert hier.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// eslint-disable-next-line no-restricted-imports
import { type PrismaClient } from '@prisma/client';
import { erzeugePrismaClient } from '../src/lib/prisma-client';

export interface Eindeutigkeit {
  migration: string;
  name: string;
  tabelle: string;
  spalten: string[];
  /** Teilindex: nur diese Zeilen müssen eindeutig sein. */
  bedingung: string | null;
}

// ---------------------------------------------------------------------------
//  Migrationen lesen
// ---------------------------------------------------------------------------

/** Alle Eindeutigkeitsbedingungen aus einer Migrationsdatei. */
export function eindeutigkeitenAus(migration: string, sql: string): Eindeutigkeit[] {
  const gefunden: Eindeutigkeit[] = [];
  // Kommentare entfernen, damit ein auskommentiertes Beispiel nicht zählt.
  const rein = sql.replace(/--[^\n]*/g, '');

  const index =
    /CREATE\s+UNIQUE\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"?([\w.]+)"?\s+ON\s+"?([\w.]+)"?\s*\(([^)]*)\)([^;]*);/gi;
  for (const t of rein.matchAll(index)) {
    const rest = (t[4] ?? '').trim();
    const where = /\bWHERE\b([\s\S]*)$/i.exec(rest);
    gefunden.push({
      migration,
      name: t[1]!,
      tabelle: t[2]!,
      spalten: spaltenAus(t[3]!),
      bedingung: where ? where[1]!.trim() : null,
    });
  }

  const constraint =
    /ALTER\s+TABLE\s+(?:ONLY\s+)?"?([\w.]+)"?\s+ADD\s+CONSTRAINT\s+"?([\w.]+)"?\s+UNIQUE\s*\(([^)]*)\)/gi;
  for (const t of rein.matchAll(constraint)) {
    gefunden.push({ migration, name: t[2]!, tabelle: t[1]!, spalten: spaltenAus(t[3]!), bedingung: null });
  }

  return gefunden;
}

/**
 * Die Spaltennamen aus einer Teilbedingung.
 *
 * Postgres verlangt in einer `WHERE`-Klausel keine Anführungszeichen; Prisma
 * und die von Hand geschriebenen Migrationen dieses Projekts setzen sie aber
 * durchgehend. Genommen wird deshalb genau das — alles in Anführungszeichen.
 * Ein unquotierter Name würde übersehen; dann meldet die Abfrage einen
 * Datenbankfehler, und das ist immer noch besser als eine stille Zusage.
 */
export function spaltenAusBedingung(bedingung: string | null): string[] {
  if (!bedingung) return [];
  return [...bedingung.matchAll(/"([A-Za-z_][\w]*)"/g)].map((t) => t[1]!);
}

function spaltenAus(liste: string): string[] {
  return liste
    .split(',')
    .map((s) => s.trim().replace(/^"|"$/g, '').replace(/\s+(ASC|DESC)$/i, ''))
    .filter((s) => s.length > 0);
}

/** Welche Migrationen liegen im Verzeichnis, welche sind schon angewandt? */
export async function offeneMigrationen(prisma: PrismaClient, verzeichnis: string): Promise<string[]> {
  const vorhanden = readdirSync(verzeichnis, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  let angewandt: string[] = [];
  try {
    const zeilen = await prisma.$queryRawUnsafe<{ migration_name: string }[]>(
      'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL',
    );
    angewandt = zeilen.map((z) => z.migration_name);
  } catch {
    // Keine Migrationstabelle: eine frische Datenbank. Dann sind alle offen —
    // und alle Tabellen entstehen erst, also gibt es nichts zu prüfen.
    angewandt = [];
  }

  return vorhanden.filter((n) => !angewandt.includes(n));
}

// ---------------------------------------------------------------------------
//  Prüfen
// ---------------------------------------------------------------------------

export interface Befund {
  bedingung: Eindeutigkeit;
  lage: 'tabelle-entsteht-erst' | 'spalte-fehlt' | 'frei' | 'konflikt';
  konflikte?: number;
  beispiele?: string[];
}

async function tabelleExistiert(prisma: PrismaClient, tabelle: string): Promise<boolean> {
  const z = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
    tabelle,
  );
  return (z[0]?.n ?? 0) > 0;
}

async function spaltenExistieren(prisma: PrismaClient, tabelle: string, spalten: string[]): Promise<boolean> {
  const z = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
    tabelle,
  );
  const vorhanden = new Set(z.map((r) => r.column_name));
  return spalten.every((s) => vorhanden.has(s));
}

export async function pruefen(prisma: PrismaClient, bedingungen: Eindeutigkeit[]): Promise<Befund[]> {
  const befunde: Befund[] = [];

  for (const b of bedingungen) {
    if (!(await tabelleExistiert(prisma, b.tabelle))) {
      befunde.push({ bedingung: b, lage: 'tabelle-entsteht-erst' });
      continue;
    }
    /**
     * Auch die Spalten der Teilbedingung zählen.
     *
     * `…_offene_abnahme_je_einsatz` indiziert `jobId` — das gibt es in
     * `signature_requests` seit Gate 4B. Die Bedingung dazu liest aber
     * `ceremonyMode`, und **die** Spalte kommt erst mit derselben Migration.
     * Ohne diese Zeile lief die Prüfabfrage gegen eine Spalte, die es noch
     * nicht gibt, und der Vorlauf brach mit einem Datenbankfehler ab statt
     * sauber „entsteht erst" zu melden. Beobachtet gegen `clenaris`.
     */
    const benoetigt = [...b.spalten, ...spaltenAusBedingung(b.bedingung)];
    if (!(await spaltenExistieren(prisma, b.tabelle, benoetigt))) {
      // Die Spalte kommt mit derselben Reihe — dann kann sie noch keine
      // verletzenden Werte tragen.
      befunde.push({ bedingung: b, lage: 'spalte-fehlt' });
      continue;
    }

    const spalten = b.spalten.map((s) => `"${s.replace(/"/g, '')}"`).join(', ');
    const wo = b.bedingung ? `WHERE ${b.bedingung}` : '';
    // Rein lesend. Der Tabellen- und Spaltenname stammt aus einer Datei im
    // Repository, nicht aus einer Anfrage, und ist oben auf Wortzeichen
    // geprüft; die Teilbedingung wird unverändert aus der Migration
    // übernommen, die ohnehin gleich ausgeführt werden soll.
    const sql =
      `SELECT ${spalten}, count(*)::int AS anzahl FROM "${b.tabelle.replace(/"/g, '')}" ` +
      `${wo} GROUP BY ${spalten} HAVING count(*) > 1 LIMIT 20`;

    try {
      const treffer = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(sql);
      if (treffer.length === 0) {
        befunde.push({ bedingung: b, lage: 'frei' });
      } else {
        befunde.push({
          bedingung: b,
          lage: 'konflikt',
          konflikte: treffer.length,
          beispiele: treffer.slice(0, 5).map((z) => JSON.stringify(z)),
        });
      }
    } catch (fehler) {
      throw new Error(
        `Die Vorprüfung für ${b.name} liess sich nicht ausführen: ` +
          `${fehler instanceof Error ? fehler.message.split('\n')[0] : String(fehler)}`,
      );
    }
  }

  return befunde;
}

// ---------------------------------------------------------------------------
//  Aufruf von der Befehlszeile
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const url = process.env.DIRECT_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error('❌  Keine Verbindungszeichenfolge (DIRECT_URL oder DATABASE_URL).');
    process.exit(1);
  }

  const verzeichnis = join(process.cwd(), 'prisma', 'migrations');
  const prisma = erzeugePrismaClient({ url });

  console.log('');
  console.log('  ── Migrations-Vorprüfung (nur lesend) ───────────────────────');

  try {
    const offen = await offeneMigrationen(prisma, verzeichnis);
    if (offen.length === 0) {
      console.log('  Keine offenen Migrationen — nichts zu prüfen.');
      console.log('');
      return;
    }
    console.log(`  Offene Migrationen   : ${offen.length}`);
    for (const m of offen) console.log(`    · ${m}`);

    const bedingungen = offen.flatMap((m) =>
      eindeutigkeitenAus(m, readFileSync(join(verzeichnis, m, 'migration.sql'), 'utf8')),
    );
    console.log(`  Eindeutigkeiten      : ${bedingungen.length}`);

    const befunde = await pruefen(prisma, bedingungen);
    const konflikte = befunde.filter((b) => b.lage === 'konflikt');

    for (const b of befunde) {
      const wie =
        b.lage === 'tabelle-entsteht-erst'
          ? 'Tabelle entsteht erst mit dieser Reihe'
          : b.lage === 'spalte-fehlt'
            ? 'Spalte entsteht erst mit dieser Reihe'
            : b.lage === 'frei'
              ? 'keine Verletzung in den vorhandenen Daten'
              : `${b.konflikte} verletzende Gruppe(n)`;
      const zeichen = b.lage === 'konflikt' ? '✗' : '·';
      console.log(`    ${zeichen} ${b.bedingung.name} auf ${b.bedingung.tabelle} — ${wie}`);
      if (b.lage === 'konflikt') for (const z of b.beispiele ?? []) console.log(`        ${z}`);
    }

    if (konflikte.length > 0) {
      console.error('');
      console.error(`  ❌  ${konflikte.length} Eindeutigkeit(en) würden an den vorhandenen Daten scheitern.`);
      console.error('      Keine Migration, keine automatische Bereinigung — das ist eine Entscheidung.');
      console.error('');
      process.exit(1);
    }

    console.log('  ✅  Keine Eindeutigkeit kollidiert mit den vorhandenen Daten.');
    console.log('');
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && /migration-preflight\.(ts|js)$/.test(process.argv[1])) {
  main().catch((fehler) => {
    console.error(`❌  ${fehler instanceof Error ? fehler.message : String(fehler)}`);
    process.exit(1);
  });
}
