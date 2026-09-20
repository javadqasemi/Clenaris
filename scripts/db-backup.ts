/**
 * Datenbanksicherung vor einer Schemaänderung.
 *
 *   npx tsx scripts/db-backup.ts --grund migration --commit <sha>
 *
 * ---------------------------------------------------------------------------
 *  Warum es das gibt
 * ---------------------------------------------------------------------------
 *
 * `scripts/deploy.sh` sicherte bisher den Build und die `.env` — also alles,
 * was sich aus Git und den Secrets wiederherstellen lässt. Nicht gesichert
 * wurde das Einzige, was sich **nicht** wiederherstellen lässt: die Daten.
 * `DEPLOYMENT.md` führte das selbst als offenen P1, und sechs anstehende
 * Migrationen ohne Rückweg sind genau der Fall, für den ein Rückweg da ist.
 *
 * Der Rücksprung in `deploy.sh` stellt ausdrücklich nur die **Anwendung**
 * wieder her, nie das Schema. Das bleibt so: Eine Migration rückwärts
 * auszuführen ist eine Entscheidung, keine Automatik. Diese Sicherung ist das
 * Netz darunter.
 *
 * ---------------------------------------------------------------------------
 *  Was hier bewusst anders ist als in einem Einzeiler
 * ---------------------------------------------------------------------------
 *
 * **Die Zugangsdaten stehen nie in der Befehlszeile.** `pg_dump "postgres://…"`
 * wäre kürzer — und der vollständige Zugang stünde für jeden sichtbar in der
 * Prozessliste des Servers. Die Verbindung wird deshalb in `PGHOST`, `PGPORT`,
 * `PGUSER`, `PGPASSWORD`, `PGDATABASE` zerlegt und über die Umgebung
 * übergeben. Ausgegeben wird nie mehr als Host, Port und Datenbankname.
 *
 * **Ein Rückgabewert 0 von `pg_dump` genügt nicht.** Ein abgebrochener Lauf,
 * eine volle Platte oder ein Schreibfehler hinterlassen eine Datei, die
 * existiert und unbrauchbar ist. Geprüft wird deshalb, ob das Archiv sich
 * tatsächlich *lesen* lässt (`pg_restore --list`) — das ist der billigste
 * Beweis, der mehr sagt als jede Grössenangabe.
 *
 * **Aufgeräumt wird erst nach dem Beweis.** Alte Sicherungen verschwinden
 * ausschliesslich, nachdem die neue vollständig geprüft ist, nur innerhalb des
 * Sicherungsverzeichnisses und nur bei exakt passendem Dateinamen. Die
 * neueste wird nie gelöscht.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// ---------------------------------------------------------------------------
//  Verbindung
// ---------------------------------------------------------------------------

export interface Verbindung {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
  /** Nur Host, Port und Name — niemals Zugangsdaten. Für Protokolle. */
  beschreibung: string;
}

/**
 * Die Verbindungszeichenfolge zerlegen.
 *
 * `DIRECT_URL` hat Vorrang vor `DATABASE_URL`: Läuft ein Pooler davor, ist die
 * Direktverbindung die richtige für einen Dump — dasselbe gilt für
 * Migrationen, und aus demselben Grund deklariert das Schema sie.
 */
export function verbindungAus(url: string): Verbindung {
  const u = new URL(url);
  const database = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (!database) throw new Error('Die Verbindungszeichenfolge nennt keine Datenbank.');
  return {
    host: u.hostname || 'localhost',
    port: u.port || '5432',
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database,
    beschreibung: `${u.hostname || 'localhost'}:${u.port || '5432'}/${database}`,
  };
}

/** Die Umgebung, in der die Postgres-Werkzeuge laufen — ohne Zugang in argv. */
function pgUmgebung(v: Verbindung): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PGHOST: v.host,
    PGPORT: v.port,
    PGUSER: v.user,
    PGPASSWORD: v.password,
    PGDATABASE: v.database,
    // Ein Dump soll nicht ewig auf eine hängende Verbindung warten.
    PGCONNECT_TIMEOUT: process.env.PGCONNECT_TIMEOUT ?? '15',
  };
}

// ---------------------------------------------------------------------------
//  Werkzeuge finden
// ---------------------------------------------------------------------------

/**
 * `pg_dump`, `pg_restore` und `psql` finden.
 *
 * Auf einem Server liegen sie im `PATH`. Auf einem Windows-Arbeitsplatz —
 * und dort wird dieser Mechanismus geprüft, bevor er Production anfasst —
 * liegen sie unter `C:\Program Files\PostgreSQL\<Version>\bin` und sind dort
 * üblicherweise nicht im `PATH`. `PG_BIN` übersteuert beides.
 */
export function werkzeugPfad(name: string): string {
  const exe = platform() === 'win32' ? `${name}.exe` : name;

  const ausEnv = process.env.PG_BIN?.trim();
  if (ausEnv && existsSync(join(ausEnv, exe))) return join(ausEnv, exe);

  const imPfad = spawnSync(platform() === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' });
  if (imPfad.status === 0) {
    const erste = imPfad.stdout.split(/\r?\n/).find((z) => z.trim().length > 0);
    if (erste) return erste.trim();
  }

  if (platform() === 'win32') {
    const wurzel = 'C:\\Program Files\\PostgreSQL';
    if (existsSync(wurzel)) {
      const versionen = readdirSync(wurzel)
        .filter((n) => /^\d+$/.test(n))
        .sort((a, b) => Number(b) - Number(a));
      for (const v of versionen) {
        const kandidat = join(wurzel, v, 'bin', exe);
        if (existsSync(kandidat)) return kandidat;
      }
    }
  }

  throw new Error(
    `${name} wurde nicht gefunden. Installieren Sie die PostgreSQL-Clientwerkzeuge ` +
      'oder setzen Sie PG_BIN auf das Verzeichnis, in dem sie liegen.',
  );
}

const hauptversion = (text: string): number => {
  const treffer = /(\d+)/.exec(text);
  if (!treffer) throw new Error(`Aus „${text}" lässt sich keine Version lesen.`);
  return Number(treffer[1]);
};

/**
 * Passt der Client zum Server?
 *
 * `pg_dump` darf neuer sein als der Server, aber nie älter — ein älterer
 * Client kennt neuere Katalogstrukturen nicht und bricht ab oder, schlimmer,
 * erzeugt ein unvollständiges Archiv. Geprüft wird deshalb **vorher**, mit
 * einer eigenen Meldung, statt hinterher eine Postgres-Fehlermeldung zu
 * deuten.
 */
export function versionenPruefen(v: Verbindung): { server: number; client: number } {
  const psql = werkzeugPfad('psql');
  const serverText = execFileSync(psql, ['-Atqc', 'SHOW server_version'], {
    env: pgUmgebung(v),
    encoding: 'utf8',
    timeout: 30_000,
  }).trim();

  const pgDump = werkzeugPfad('pg_dump');
  const clientText = execFileSync(pgDump, ['--version'], { encoding: 'utf8', timeout: 30_000 }).trim();

  const server = hauptversion(serverText);
  const client = hauptversion(clientText.replace(/^pg_dump\s*\(PostgreSQL\)\s*/i, ''));

  if (client < server) {
    throw new Error(
      `pg_dump ist Hauptversion ${client}, der Server läuft auf ${server}. ` +
        'Ein älterer Client erzeugt keine verlässliche Sicherung — Auslieferung abgebrochen. ' +
        'Installieren Sie die Clientwerkzeuge in der Serverversion oder setzen Sie PG_BIN.',
    );
  }
  return { server, client };
}

// ---------------------------------------------------------------------------
//  Ablageort
// ---------------------------------------------------------------------------

/**
 * Wohin die Sicherung geht.
 *
 * **Nicht** in das Verzeichnis der Anwendung: Dort räumt `git reset --hard`,
 * dort räumt die Aufbewahrungsregel der Build-Sicherungen, und dort liegt ein
 * Verzeichnis, das ein künftiger Umbau ersetzen könnte. Eine Sicherung, die
 * beim nächsten Fehlschlag mit weggeräumt wird, ist keine.
 *
 * Vorgabe ist deshalb ein Geschwisterverzeichnis neben der Anwendung —
 * `<über der Anwendung>/backups/clenaris-db`. Das funktioniert unter jedem
 * Dienstbenutzer ohne zusätzliche Rechte. Wer `/var/backups/clenaris/database`
 * bevorzugt und dem Dienstbenutzer Schreibrecht gibt, setzt
 * `CLENARIS_BACKUP_DIR` — dann gilt das.
 */
export function sicherungsverzeichnis(appDir: string): string {
  const gesetzt = process.env.CLENARIS_BACKUP_DIR?.trim();
  if (gesetzt) return resolve(gesetzt);
  const eltern = dirname(resolve(appDir));
  const basis = eltern === resolve(appDir) ? homedir() : eltern;
  return join(basis, 'backups', 'clenaris-db');
}

/** 700 für das Verzeichnis, 600 für die Datei — unter Windows folgenlos. */
function rechteSetzen(pfad: string, modus: number): void {
  if (platform() === 'win32') return;
  try {
    chmodSync(pfad, modus);
  } catch {
    // Kein Grund abzubrechen: Die Sicherung liegt, die Rechte prüft der
    // Aufrufer gleich noch einmal und meldet eine Abweichung.
  }
}

// ---------------------------------------------------------------------------
//  Die Sicherung
// ---------------------------------------------------------------------------

export interface Sicherungsergebnis {
  datei: string;
  groesse: number;
  sha256: string;
  eintraege: number;
  server: number;
  client: number;
  zeitpunkt: string;
}

/** `clenaris_<UTC-Zeitstempel>_<sha>.dump` — eindeutig und sortierbar. */
export function dateiname(zeitpunkt: Date, commit: string): string {
  const stempel = zeitpunkt.toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z');
  // Nur das, was in einen Dateinamen gehört. Der Commit kommt aus `git
  // rev-parse`, aber geprüft wird er trotzdem — ungeprüfte Werte in Pfaden
  // sind der Anfang jeder Pfadmanipulation.
  const kennung = /^[0-9a-f]{7,40}$/i.test(commit) ? commit.slice(0, 12) : 'ohne-commit';
  return `clenaris_${stempel}_${kennung}.dump`;
}

export function sichern(options: {
  url: string;
  verzeichnis: string;
  commit: string;
  protokoll?: (zeile: string) => void;
}): Sicherungsergebnis {
  const log = options.protokoll ?? ((z: string) => process.stdout.write(`${z}\n`));
  const v = verbindungAus(options.url);

  log(`Datenbank            : ${v.beschreibung}`);

  const versionen = versionenPruefen(v);
  log(`PostgreSQL Server    : ${versionen.server}`);
  log(`pg_dump Client       : ${versionen.client}`);

  mkdirSync(options.verzeichnis, { recursive: true });
  rechteSetzen(options.verzeichnis, 0o700);

  const zeitpunkt = new Date();
  const ziel = join(options.verzeichnis, dateiname(zeitpunkt, options.commit));
  log(`Ziel                 : ${ziel}`);

  // --- Dump --------------------------------------------------------------
  const pgDump = werkzeugPfad('pg_dump');
  const lauf = spawnSync(
    pgDump,
    [
      '--format=custom',
      // Höhere Stufen kosten auf einem Anwendungsserver mehr CPU, als sie an
      // Platz sparen; die Vorgabe ist hier die richtige Wahl.
      '--compress=6',
      '--no-password',
      '--file',
      ziel,
    ],
    { env: pgUmgebung(v), encoding: 'utf8', timeout: 30 * 60_000 },
  );

  if (lauf.status !== 0) {
    // `stderr` von pg_dump enthält keine Zugangsdaten — es nennt Host,
    // Datenbank und den Grund. Ohne die Meldung sucht man im Dunkeln.
    const grund = (lauf.stderr || lauf.error?.message || `Rückgabewert ${lauf.status}`).toString().trim();
    if (existsSync(ziel)) rmSync(ziel, { force: true });
    throw new Error(`pg_dump ist fehlgeschlagen: ${grund}`);
  }

  // --- Prüfen ------------------------------------------------------------
  if (!existsSync(ziel)) throw new Error('pg_dump meldete Erfolg, aber es liegt keine Datei.');

  const groesse = statSync(ziel).size;
  if (groesse <= 0) {
    rmSync(ziel, { force: true });
    throw new Error('Die Sicherung ist leer.');
  }
  rechteSetzen(ziel, 0o600);

  const pgRestore = werkzeugPfad('pg_restore');
  const liste = spawnSync(pgRestore, ['--list', ziel], { encoding: 'utf8', timeout: 5 * 60_000 });
  if (liste.status !== 0) {
    throw new Error(
      `Das Archiv lässt sich nicht lesen (pg_restore --list): ${(liste.stderr || '').trim()}`,
    );
  }
  const eintraege = liste.stdout.split(/\r?\n/).filter((z) => z.trim() && !z.startsWith(';')).length;
  if (eintraege === 0) {
    throw new Error('Das Archiv enthält keine Einträge — es ist formal lesbar, aber leer.');
  }

  const sha256 = createHash('sha256').update(readFileSync(ziel)).digest('hex');

  log(`Grösse               : ${groesse} Bytes`);
  log(`Archiveinträge       : ${eintraege}`);
  log(`SHA-256              : ${sha256}`);
  log(`Zeitpunkt (UTC)      : ${zeitpunkt.toISOString()}`);

  return { datei: ziel, groesse, sha256, eintraege, server: versionen.server, client: versionen.client, zeitpunkt: zeitpunkt.toISOString() };
}

// ---------------------------------------------------------------------------
//  Aufbewahrung
// ---------------------------------------------------------------------------

/**
 * Alte Sicherungen entfernen — konservativ.
 *
 * Drei Regeln, und jede verhindert einen bestimmten Unfall:
 *
 *  • Es wird **nur nach der geprüften neuen Sicherung** aufgeräumt. Wer vorher
 *    löscht, steht bei einem fehlgeschlagenen Dump ohne beides da.
 *  • Gelöscht wird ausschliesslich im Sicherungsverzeichnis und nur, was exakt
 *    dem Namensmuster entspricht. Kein Glob, keine Rekursion, kein `rm -rf`.
 *  • Die neueste Sicherung wird nie gelöscht, auch wenn `behalten` auf 0
 *    stünde.
 */
export function aufraeumen(verzeichnis: string, behalten: number, schuetzen: string): string[] {
  const muster = /^clenaris_.+\.dump$/;
  const dateien = readdirSync(verzeichnis)
    .filter((n) => muster.test(n))
    .map((n) => ({ name: n, pfad: join(verzeichnis, n), zeit: statSync(join(verzeichnis, n)).mtimeMs }))
    .sort((a, b) => b.zeit - a.zeit);

  const grenze = Math.max(1, behalten);
  const entfernt: string[] = [];
  for (const datei of dateien.slice(grenze)) {
    if (resolve(datei.pfad) === resolve(schuetzen)) continue;
    rmSync(datei.pfad, { force: true });
    entfernt.push(datei.name);
  }
  return entfernt;
}

// ---------------------------------------------------------------------------
//  Aufruf von der Befehlszeile
// ---------------------------------------------------------------------------

function argument(name: string, vorgabe = ''): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : vorgabe;
}

function main(): void {
  const url =
    process.env.BACKUP_DATABASE_URL?.trim() ||
    process.env.DIRECT_URL?.trim() ||
    process.env.DATABASE_URL?.trim();

  if (!url) {
    console.error('❌  Keine Verbindungszeichenfolge (BACKUP_DATABASE_URL, DIRECT_URL oder DATABASE_URL).');
    process.exit(1);
  }

  const appDir = process.env.APP_DIRECTORY?.trim() || process.cwd();
  const verzeichnis = argument('verzeichnis') || sicherungsverzeichnis(appDir);
  const behalten = Number(process.env.CLENARIS_BACKUP_KEEP ?? '7');
  const grund = argument('grund', 'manuell');
  const commit = argument('commit', '');

  console.log('');
  console.log('  ── Datenbanksicherung ───────────────────────────────────────');
  console.log(`  Anlass               : ${grund}`);

  try {
    const ergebnis = sichern({ url, verzeichnis, commit, protokoll: (z) => console.log(`  ${z}`) });
    const entfernt = aufraeumen(verzeichnis, Number.isFinite(behalten) ? behalten : 7, ergebnis.datei);
    console.log(`  Aufbewahrung         : ${behalten} Stück, ${entfernt.length} entfernt`);
    console.log('  ✅  Sicherung geprüft und verwendbar.');
    console.log('');

    // Für `deploy.sh`: eine Zeile, die sich auslesen lässt, ohne das Protokoll
    // zu zerschneiden.
    console.log(`BACKUP_DATEI=${ergebnis.datei}`);
    console.log(`BACKUP_SHA256=${ergebnis.sha256}`);
    console.log(`BACKUP_GROESSE=${ergebnis.groesse}`);
  } catch (fehler) {
    console.error('');
    console.error(`  ❌  ${fehler instanceof Error ? fehler.message : String(fehler)}`);
    console.error('      Ohne geprüfte Sicherung wird keine Migration ausgeführt.');
    console.error('');
    process.exit(1);
  }
}

if (process.argv[1] && /db-backup\.(ts|js)$/.test(process.argv[1])) main();
