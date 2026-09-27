/**
 * Der eine Prüfweg — örtlich und in CI derselbe (2026-09-27).
 *
 *   npm run verify:static     statisch       ohne Datenbank und Server
 *   npm run verify:tests      pruefreihen    gegen einen laufenden Server (TEST_BASE_URL)
 *   npm run verify:full       voll           statisch + Testdatenbank + Build + Server + Prüfreihen
 *   npm run verify:release    release        voll auf frischer Datenbank, aus sauberem `git archive`
 *
 * ---------------------------------------------------------------------------
 *  Warum ein Skript
 * ---------------------------------------------------------------------------
 *
 * `docs/ENGINEERING_DEFINITION_OF_DONE.md` zählt auf, was vor einer
 * Auslieferung geprüft sein muss. Eine Liste allein wird übersprungen, sobald
 * es eilt; und eine CI, die ihre Schritte selbst aufzählt, läuft neben der
 * örtlichen Prüfung auseinander — ein Schritt kommt dort dazu und fehlt hier.
 * Deshalb stehen die Schritte **hier**, jeder als ein bestehendes
 * npm-Skript, und `.github/workflows/deploy.yml` ruft `verify:static` und
 * `verify:tests` auf statt einer eigenen Folge.
 *
 * Was CI-eigen bleibt, steht dort: Dienste (PostgreSQL), Zwischenspeicher,
 * Artefakte, Stückliste. Das sind Rahmen, keine Prüfungen.
 *
 * ---------------------------------------------------------------------------
 *  Was es nie tut
 * ---------------------------------------------------------------------------
 *
 * Es berührt nur die **Testdatenbank** (Namensschutz aus `prisma/seed-guard`,
 * wie `test-server.ts`), nie die Entwicklungs- oder Produktionsdatenbank, und
 * es liefert nichts aus. Ein laufender Entwicklungsserver bleibt unberührt;
 * unter Windows hält er allerdings die Prisma-DLL, und der Build scheitert
 * dann mit EPERM (CLAUDE.md) — das Skript sagt es, statt ihn zu beenden.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { config } from 'dotenv';

import { databaseNameOf, istTestdatenbank } from '../prisma/seed-guard';

config();

type Modus = 'statisch' | 'pruefreihen' | 'voll' | 'release';

const WURZEL = resolve(__dirname, '..');
const WINDOWS = process.platform === 'win32';

interface Ergebnis {
  schritt: string;
  ok: boolean;
  dauerMs: number;
  hinweis?: string;
}

const ergebnisse: Ergebnis[] = [];

function zeit(ms: number): string {
  return ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

/**
 * Einen Schritt laufen lassen; scheitert er, bricht der Prüfweg ab. Die eine
 * Ausnahme ist die Merkmalsprüfung (eigene Funktion unten), eine Heuristik mit
 * bekannten Fehlalarmen — Begründung in `deploy.yml`.
 */
function schritt(name: string, befehl: string, optionen: { env?: Record<string, string>; cwd?: string } = {}): void {
  console.log(`\n━━ ${name}\n   $ ${befehl}`);
  const start = Date.now();
  const lauf = spawnSync(befehl, { shell: true, stdio: 'inherit', cwd: optionen.cwd ?? WURZEL, env: { ...process.env, ...optionen.env } });
  const ok = lauf.status === 0;
  ergebnisse.push({ schritt: name, ok, dauerMs: Date.now() - start });
  if (!ok) abbrechen(`„${name}" ist gescheitert (Exitcode ${lauf.status ?? 'unbekannt'}).`);
}

let server: ChildProcess | null = null;

function zusammenfassung(): void {
  console.log('\n━━ Zusammenfassung');
  for (const e of ergebnisse) console.log(`   ${e.ok ? '✓' : '✗'} ${e.schritt.padEnd(44)} ${zeit(e.dauerMs).padStart(10)}${e.hinweis ? `  (${e.hinweis})` : ''}`);
}

function abbrechen(grund: string): never {
  serverBeenden();
  zusammenfassung();
  console.error(`\n❌  ${grund}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
//  Testdatenbank und git
// ---------------------------------------------------------------------------

/** Dieselbe Ableitung wie `scripts/test-server.ts` — und derselbe Namensschutz. */
function testdatenbank(): string {
  const roh = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!roh) abbrechen('Weder TEST_DATABASE_URL noch DATABASE_URL gesetzt — keine Testdatenbank ableitbar.');
  const url = new URL(roh);
  const name = url.pathname.replace(/^\//, '');
  if (!process.env.TEST_DATABASE_URL && !name.endsWith('_test')) url.pathname = `/${name}_test`;
  const adresse = process.env.TEST_DATABASE_URL ?? url.toString();
  if (!istTestdatenbank(databaseNameOf(adresse))) abbrechen(`„${databaseNameOf(adresse)}" ist nicht als Testdatenbank erkennbar. Abbruch.`);
  return adresse;
}

/**
 * `git` finden. In CI liegt es im Pfad; auf dem Entwicklungsrechner dieses
 * Projekts nicht, dort bringt GitHub Desktop eines mit (CLAUDE.md).
 */
function gitBefehl(): string | null {
  if (spawnSync('git', ['--version'], { shell: WINDOWS }).status === 0) return 'git';
  const basis = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'GitHubDesktop') : null;
  if (basis && existsSync(basis)) {
    const fassungen = readdirSync(basis).filter((d) => d.startsWith('app-')).sort();
    for (const f of fassungen.reverse()) {
      const kandidat = join(basis, f, 'resources', 'app', 'git', 'cmd', 'git.exe');
      if (existsSync(kandidat)) return `"${kandidat}"`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
//  Stufen
// ---------------------------------------------------------------------------

/**
 * Die Merkmalsprüfung, zusätzlich in die Zusammenfassung des CI-Laufs
 * geschrieben, wenn es eine gibt (`GITHUB_STEP_SUMMARY`) — dort las man ihr
 * Ergebnis bisher, und das soll so bleiben.
 */
function merkmalspruefung(): void {
  console.log('\n━━ Merkmalsprüfung\n   $ npx tsx scripts/feature-integrity.ts');
  const start = Date.now();
  const lauf = spawnSync('npx tsx scripts/feature-integrity.ts', { shell: true, cwd: WURZEL, encoding: 'utf8' });
  const ausgabe = `${lauf.stdout ?? ''}${lauf.stderr ?? ''}`;
  process.stdout.write(ausgabe);
  const zusammenfassungsDatei = process.env.GITHUB_STEP_SUMMARY;
  if (zusammenfassungsDatei) appendFileSync(zusammenfassungsDatei, `### Merkmalsprüfung\n\`\`\`\n${ausgabe}\n\`\`\`\n`);
  ergebnisse.push({ schritt: 'Merkmalsprüfung', ok: lauf.status === 0, dauerMs: Date.now() - start, hinweis: lauf.status === 0 ? undefined : 'nicht blockierend' });
}

function statisch(): void {
  schritt('React-Hydrationskorrektur angewendet', 'node scripts/react-hydrationskorrektur.mjs --pruefen');
  // Nur `critical` und nur Laufzeitabhängigkeiten; die übrigen Befunde sind
  // in docs/LIEFERKETTE.md einzeln bewertet und laufen in der
  // Sicherheitsprüfung gegen `security/akzeptierte-befunde.json`.
  schritt('Keine kritische Lücke in den Laufzeitabhängigkeiten', 'npm audit --omit=dev --audit-level=critical');
  schritt('Linter', 'npm run lint');
  schritt('TypeScript', 'npm run typecheck');
  schritt('Prisma-Schema gültig', 'npx prisma validate');
  schritt('Keine Geheimnisse im Repository', 'npm run security:secrets');
  schritt('Sicherheitsprüfung (statisch)', 'npm run security:check:static');
  schritt('Dokumentation erzeugen (OpenAPI, ERD)', 'npm run docs');
  /**
   * `npm run docs` bricht bei einer undokumentierten Route ab; der Vergleich
   * fängt den anderen Fall — dokumentiert, aber die erzeugte Datei nicht
   * mitgeliefert. Ohne `git` lässt sich das nicht prüfen, und dann ist es ein
   * Fehlschlag, kein stilles Überspringen.
   */
  const git = gitBefehl();
  if (!git) abbrechen('git nicht gefunden — „Dokumentation aktuell" lässt sich nicht prüfen.');
  // README gehört dazu, seit ihre Umfangszahlen erzeugt werden (scripts/kennzahlen.ts, 2026-09-27).
  schritt('Dokumentation ist mitgeliefert (kein Unterschied in docs/ und README.md)', `${git} diff --exit-code --stat -- docs/ README.md`);
  merkmalspruefung();
}

async function serverStarten(datenbank: string, port: string, cacheDir: string): Promise<void> {
  console.log(`\n━━ Testserver starten (Port ${port})`);
  const start = Date.now();
  server = spawn(process.execPath, [join(WURZEL, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(WURZEL, 'scripts', 'test-server.ts')], {
    cwd: WURZEL,
    stdio: 'inherit',
    env: { ...process.env, PORT: port, TEST_DATABASE_URL: datenbank, CLENARIS_TEST_CACHE_DIR: cacheDir },
  });
  const bis = Date.now() + 120_000;
  while (Date.now() < bis) {
    if (server.exitCode !== null) abbrechen(`Der Testserver ist beendet (Exitcode ${server.exitCode}), bevor er antwortete.`);
    try {
      const antwort = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (antwort.ok) {
        ergebnisse.push({ schritt: 'Testserver antwortet', ok: true, dauerMs: Date.now() - start });
        return;
      }
    } catch {
      /* noch nicht bereit */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  abbrechen('Der Testserver hat nach 120 s nicht geantwortet.');
}

function serverBeenden(): void {
  if (!server || server.exitCode !== null) return;
  // `test-server.ts` beendet auf SIGTERM sein `next start`; unter Windows gibt
  // es kein Signal an Kindprozesse, dort räumt `taskkill /T` den Baum.
  if (WINDOWS && server.pid) spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
  else server.kill('SIGTERM');
  server = null;
}

function pruefreihen(basis: string, cacheDir: string | undefined, port: string): void {
  const env = { TEST_BASE_URL: basis, ...(cacheDir ? { CLENARIS_TEST_CACHE_DIR: cacheDir } : {}) };
  schritt('Sicherheitsreihen', 'npm run security:check:tests', { env });
  schritt('Testreihe (vollständig, seriell)', 'npm test', { env });
  // Ohne Wiederholungen: Ein Browserfall, der nur im zweiten Anlauf grün
  // wird, ist rot (Definition of Done, Checkliste G).
  schritt('Browser-Prüfreihe (ohne Wiederholungen)', 'npx playwright test --retries=0', { env: { ...env, E2E_PORT: port } });
}

async function voll(optionen: { frisch: boolean }): Promise<void> {
  statisch();
  const datenbank = testdatenbank();
  const dbEnv = { DATABASE_URL: datenbank, DIRECT_URL: datenbank };
  if (optionen.frisch) schritt('Testdatenbank frisch aufsetzen', 'npm run db:test:setup -- --frisch', { env: { TEST_DATABASE_URL: datenbank } });
  schritt('Migrationen auf die Testdatenbank', 'npx prisma migrate deploy', { env: dbEnv });
  schritt('Demodaten (idempotent)', 'npm run db:seed:demo', { env: dbEnv });
  schritt('Build', 'npm run build', { env: { ...dbEnv, NODE_ENV: 'production' } });
  const port = process.env.VERIFY_PORT?.trim() || '3001';
  const cacheDir = mkdtempSync(join(tmpdir(), 'clenaris-verify-'));
  try {
    await serverStarten(datenbank, port, cacheDir);
    pruefreihen(`http://127.0.0.1:${port}`, cacheDir, port);
  } finally {
    serverBeenden();
    rmSync(cacheDir, { recursive: true, force: true });
  }
}

/**
 * Release: derselbe volle Weg, aber aus einem sauberen Abzug des aktuellen
 * Commits und auf einer frischen Testdatenbank. Ein Bau, der nur im
 * Arbeitsbaum gelingt — wegen einer nicht eingecheckten Datei, eines
 * örtlichen Zwischenspeichers, eines nachträglich gepatchten Moduls —, fällt
 * hier auf.
 */
async function release(): Promise<void> {
  const git = gitBefehl();
  if (!git) abbrechen('git nicht gefunden — ohne `git archive` kein sauberer Abzug.');
  const ziel = mkdtempSync(join(tmpdir(), 'clenaris-release-'));
  const archiv = join(ziel, 'quelle.tar');
  schritt('Sauberer Abzug des aktuellen Commits (git archive)', `${git} archive --format=tar -o "${archiv}" HEAD`);
  const quelle = join(ziel, 'quelle');
  mkdirSync(quelle);
  schritt('Abzug entpacken', `tar -xf "${archiv}" -C "${quelle}"`);
  // Die `.env` gehört nicht ins Repository; die Testdatenbank wird ausdrücklich
  // übergeben, damit der Abzug dieselbe Datenbank ableitet wie der Arbeitsbaum.
  if (existsSync(join(WURZEL, '.env'))) cpSync(join(WURZEL, '.env'), join(quelle, '.env'));
  schritt('Abhängigkeiten aus der Sperrdatei (npm ci)', 'npm ci --no-audit --no-fund', { cwd: quelle });
  schritt('Voller Prüfweg im Abzug, frische Testdatenbank', 'npx tsx scripts/verify.ts voll --frisch', { cwd: quelle, env: { TEST_DATABASE_URL: testdatenbank() } });
  rmSync(ziel, { recursive: true, force: true });
}

async function main(): Promise<void> {
  const modus = process.argv[2] as Modus | undefined;
  const frisch = process.argv.includes('--frisch');
  process.on('SIGINT', () => abbrechen('Abgebrochen.'));

  switch (modus) {
    case 'statisch':
      statisch();
      break;
    case 'pruefreihen': {
      const basis = process.env.TEST_BASE_URL?.trim();
      if (!basis) abbrechen('TEST_BASE_URL fehlt — `pruefreihen` läuft gegen einen bereits gestarteten Server.');
      pruefreihen(basis, process.env.CLENARIS_TEST_CACHE_DIR, new URL(basis).port || '80');
      break;
    }
    case 'voll':
      await voll({ frisch });
      break;
    case 'release':
      await release();
      break;
    default:
      console.error('Aufruf: tsx scripts/verify.ts statisch | pruefreihen | voll [--frisch] | release');
      process.exit(2);
  }
  zusammenfassung();
  console.log('\n✅  Alle blockierenden Schritte bestanden.');
}

void main();
