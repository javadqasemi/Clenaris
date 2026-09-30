/**
 * Der eine Prüfweg — örtlich und in CI derselbe (2026-09-27).
 *
 *   npm run verify:static     statisch       ohne Datenbank und Server
 *   npm run verify:tests      pruefreihen    gegen einen laufenden Server (TEST_BASE_URL)
 *   npm run verify:full       voll           statisch + Testdatenbank + Build + Server + Prüfreihen
 *   npm run verify:release         release         Kern + Stressreihe 5/5 — der Release-Nachweis
 *   npm run verify:release:core    release-kern    voll auf frischer Datenbank, aus sauberem Worktree des Commits
 *   npm run verify:release:stress  release-stress  Stressreihe gegen den vorhandenen Bau
 *
 * Nur `verify:release` meldet „RELEASE BESTANDEN“ (Exitcode 0) und schreibt
 * `test-results/release-nachweis.json`. Die beiden Teilwege enden mit
 * „TEILPRÜFUNG BESTANDEN — KEIN RELEASE-NACHWEIS“ und Exitcode **3** — die
 * Regel und ihre Begründung stehen in `scripts/security/pruefweg-abschluss.ts`.
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
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { config } from 'dotenv';

import { databaseNameOf, istTestdatenbank } from '../prisma/seed-guard';

import { abzugsbefundeSichern } from './security/befundsicherung';
import {
  abschluss,
  browserBerichtLesen,
  engineBilanzPruefen,
  engineZeilen,
  MODI,
  RELEASE_NACHWEIS_DATEI,
  releaseNachweisBauen,
  releaseNachweisSchreiben,
  STRESS_LAEUFE,
  type BrowserBilanz,
  type Laufbilanz,
  type Modus,
  type Stressbericht,
} from './security/pruefweg-abschluss';
import { bilanzPruefen, testbilanzLesen } from './security/testbilanz';

config();

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
 * Einen Schritt laufen lassen; scheitert er, bricht der Prüfweg ab. Die
 * Merkmalsprüfung hat eine eigene Funktion unten: Ihre Heuristiken melden nur,
 * ihr struktureller Teil blockiert.
 *
 * `exitcodes` erklärt einzelne Exitcodes in der Abbruchmeldung. Das ändert
 * nichts an der Regel — **jeder** Code ausser 0 bricht ab —, sagt aber, was
 * er heisst: Beim Datenbanktor ist 2 „nicht geprüft“, und wer nur
 * „Exitcode 2“ liest, hält das leicht für einen Befund oder, schlimmer, für
 * eine Nebensache.
 */
function schritt(
  name: string,
  befehl: string,
  optionen: { env?: Record<string, string>; cwd?: string; exitcodes?: Record<number, string> } = {},
): void {
  console.log(`\n━━ ${name}\n   $ ${befehl}`);
  const start = Date.now();
  const lauf = spawnSync(befehl, { shell: true, stdio: 'inherit', cwd: optionen.cwd ?? WURZEL, env: { ...process.env, ...optionen.env } });
  const ok = lauf.status === 0;
  const bedeutung = lauf.status !== null ? optionen.exitcodes?.[lauf.status] : undefined;
  ergebnisse.push({ schritt: name, ok, dauerMs: Date.now() - start, hinweis: ok ? undefined : bedeutung });
  if (!ok) abbrechen(`„${name}" ist gescheitert (Exitcode ${lauf.status ?? 'unbekannt'}${bedeutung ? `: ${bedeutung}` : ''}).`);
}

let server: ChildProcess | null = null;

/** Der aktuelle Modus — für die abgelegte Laufbilanz. */
let laufModus: Modus | null = null;

/** Die Browserbilanz des letzten Browserlaufs, je Engine — für die Laufbilanz. */
let letzteBrowserBilanz: BrowserBilanz | null = null;

function zusammenfassung(): void {
  console.log('\n━━ Zusammenfassung');
  for (const e of ergebnisse) console.log(`   ${e.ok ? '✓' : '✗'} ${e.schritt.padEnd(44)} ${zeit(e.dauerMs).padStart(10)}${e.hinweis ? `  (${e.hinweis})` : ''}`);
}

/**
 * Die Laufbilanz ablegen, wenn der Aufrufer danach fragt
 * (`CLENARIS_PRUEFWEG_BILANZ`, ein Dateipfad) — bestanden **und** gescheitert.
 *
 * Wozu: Der Release-Weg startet den vollen Prüfweg als eigenen Prozess im
 * Abzug und sah bis hierher nur dessen Exitcode. Für den Release-Nachweis
 * braucht er aber, *was* bestanden hat — jeden Schritt, die Browserbilanz je
 * Engine. Die Konsolenausgabe dafür wieder einzulesen wäre derselbe Fehler,
 * den die Stressreihe mit ihrem regulären Ausdruck gemacht hat. Die Datei
 * liegt ausserhalb von `test-results/`, weil Playwright dieses Verzeichnis zu
 * Beginn jedes Stresslaufs leert.
 */
function bilanzAblegen(ok: boolean): void {
  const ziel = process.env.CLENARIS_PRUEFWEG_BILANZ?.trim();
  if (!ziel || !laufModus) return;
  const bilanz: Laufbilanz = { modus: laufModus, ok, schritte: ergebnisse, browser: letzteBrowserBilanz };
  try {
    mkdirSync(dirname(ziel), { recursive: true });
    writeFileSync(ziel, `${JSON.stringify(bilanz, null, 2)}\n`, 'utf8');
  } catch (fehler) {
    // Kein Abbruch im Abbruch: Fehlt die Bilanz, weist der Release-Weg den
    // Nachweis ab („Keine Bilanz des Kerns“) — das ist die sichere Richtung.
    console.error(`   Laufbilanz nicht geschrieben (${ziel}): ${(fehler as Error).message}`);
  }
}

function abbrechen(grund: string): never {
  serverBeenden();
  zusammenfassung();
  bilanzAblegen(false);
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
  // Seit 2026-09-29 blockierend — aber nur, weil das Skript ohne `--streng`
  // ausschliesslich bei einem strukturellen Rückschritt mit 1 endet
  // (`strukturgrundlinie.ts`). Die Heuristiken bleiben Hinweise im Bericht.
  const ok = lauf.status === 0;
  ergebnisse.push({ schritt: 'Merkmalsprüfung (Struktur blockierend)', ok, dauerMs: Date.now() - start, hinweis: ok ? 'Heuristiken als Hinweis' : 'struktureller Rückschritt' });
  if (!ok) abbrechen('Merkmalsprüfung: struktureller Rückschritt gegenüber security/struktur-grundlinie.json.');
}

/**
 * Nutzereigene Berichte, die bewusst nie eingecheckt werden
 * (`.claude/rules/engineering.md`: „Nutzereigene, nicht eingecheckte Dateien
 * … werden weder geändert noch eingecheckt"). Nur genau diese Pfade — kein
 * Muster, damit ein neuer Bericht nicht still mit durchrutscht.
 */
const NUTZEREIGENE_DOKUMENTE = new Set(['docs/LAST_ENTERPRISE_MISSION_REPORT.md', 'docs/LAST_ENTERPRISE_MISSION_MATRIX.md']);

/**
 * Unverfolgte Dokumentation (2026-09-29, M3).
 *
 * `git diff` sieht nur Dateien, die git schon kennt. Ein neues Dokument unter
 * `docs/`, auf das Code, README oder ein anderes Dokument verweist, das aber
 * nie hinzugefügt wurde, bestand den Schritt darüber — und fehlte im Commit,
 * im Release-Abzug und in CI. Jetzt ist jede unverfolgte, nicht ignorierte
 * Datei unter `docs/` (ausser den ausdrücklich nutzereigenen) ein
 * Fehlschlag. In CI und im Release-Worktree ist die Liste immer leer; der
 * Schritt wirkt örtlich, vor dem Commit — dort, wo die Datei vergessen wird.
 */
function unverfolgteDokumentation(git: string): void {
  const start = Date.now();
  const lauf = spawnSync(`${git} ls-files --others --exclude-standard -- docs/ README.md`, { shell: true, cwd: WURZEL, encoding: 'utf8' });
  if (lauf.status !== 0) abbrechen('git ls-files ist gescheitert — unverfolgte Dokumentation lässt sich nicht prüfen.');
  const liste = lauf.stdout.split(/\r?\n/).map((z) => z.trim()).filter(Boolean);
  const offen = liste.filter((p) => !NUTZEREIGENE_DOKUMENTE.has(p));
  const nutzereigen = liste.length - offen.length;
  ergebnisse.push({
    schritt: 'Keine unverfolgte Dokumentation',
    ok: offen.length === 0,
    dauerMs: Date.now() - start,
    hinweis: offen.length ? offen.join(', ') : nutzereigen ? `${nutzereigen} nutzereigene ausgenommen` : undefined,
  });
  if (offen.length) abbrechen(`Unverfolgte Dokumentation — hinzufügen oder in .gitignore aufnehmen: ${offen.join(', ')}`);
}

function statisch(): void {
  schritt('React-Hydrationskorrektur angewendet', 'node scripts/react-hydrationskorrektur.mjs --pruefen');
  schritt('Next-Cachezeitkorrektur angewendet (RB-002)', 'node scripts/next-cachezeit-korrektur.mjs --pruefen');
  // Nur `critical` und nur Laufzeitabhängigkeiten; die übrigen Befunde sind
  // in docs/LIEFERKETTE.md einzeln bewertet und laufen in der
  // Sicherheitsprüfung gegen `security/akzeptierte-befunde.json`.
  schritt('Keine kritische Lücke in den Laufzeitabhängigkeiten', 'npm audit --omit=dev --audit-level=critical');
  schritt('Linter', 'npm run lint');
  schritt('TypeScript', 'npm run typecheck');
  schritt('Prisma-Schema gültig', 'npx prisma validate');
  schritt('Keine Geheimnisse im Repository', 'npm run security:secrets');
  schritt('Sicherheitsprüfung (statisch)', 'npm run security:check:static');
  /**
   * Seit 2026-09-30. Die Prüfung der Abdeckungsmatrizen gibt es seit
   * 2026-09-27 (5760e88), aber kein Tor rief sie — und so zeigten beide
   * Matrizen seit der Umbenennung vom 2026-09-28 (a9810a6) auf einen Fall,
   * den es nicht mehr gab („fünfzig gleichzeitige Erneuerungen: genau eine
   * gelingt …“). Eine Matrix, die niemand nachschlägt, ist eine Behauptung.
   * Ohne Datenbank und Server, also hier; CI erbt den Schritt über
   * `verify:static`. Ein Beleg muss einem ausgeführten Testtitel gleich sein,
   * eine Erwähnung im Kommentar zählt nicht (`scripts/security/testmatrix.ts`).
   */
  schritt('Testmatrix belegt', 'npx tsx scripts/testmatrix-pruefen.ts');
  // Das Prüfpaket für die Lohnfachprüfung ist aus dem Code erzeugt und muss
  // zu ihm passen (Sätze, Formeln, Musterfälle gegen Handrechnung) — sonst
  // prüft die Fachperson einen Stand, der nicht ausgeliefert wird (F-13).
  schritt('Lohn-Prüfpaket aktuell', 'npx tsx scripts/lohn-pruefpaket.ts --pruefen');
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
  unverfolgteDokumentation(git);
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

/**
 * Einen Testlauf ausführen, seine Ausgabe durchreichen **und** mitlesen, und
 * die Bilanz als Tor bewerten (N-08, 2026-09-27).
 *
 * `schritt` sah nur den Exitcode. `node:test` endet aber auch dann mit 0, wenn
 * Fälle sich mit `t.skip()` verabschieden — etwa weil die Testdatenbank nicht
 * erreichbar war oder der Postausgang fehlte. Der Prüfweg meldete dann
 * „bestanden" für Fälle, die nie liefen. Jetzt gilt „0 übersprungen" als
 * erzwungene Bedingung: Übersprungen, todo, abgebrochen oder eine fehlende
 * Schlusszusammenfassung sind ein Fehlschlag (`scripts/security/testbilanz.ts`,
 * dieselbe Regel wie in `security-check.ts`).
 *
 * Asynchron und mit durchgereichter Ausgabe statt `spawnSync` mit Puffer: Die
 * Reihe läuft mehrere Minuten, und wer zusieht, soll den Fortschritt sehen,
 * nicht erst am Ende einen Block.
 */
function schrittMitBilanz(name: string, befehl: string, optionen: { env?: Record<string, string> } = {}): Promise<void> {
  console.log(`\n━━ ${name}\n   $ ${befehl}`);
  const start = Date.now();
  return new Promise((fertig) => {
    const kind = spawn(befehl, { shell: true, stdio: ['inherit', 'pipe', 'inherit'], cwd: WURZEL, env: { ...process.env, ...optionen.env } });
    let ausgabe = '';
    kind.stdout!.on('data', (stueck: Buffer) => {
      process.stdout.write(stueck);
      ausgabe += stueck.toString('utf8');
    });
    kind.on('close', (code) => {
      const bilanz = testbilanzLesen(ausgabe);
      const gruende = bilanzPruefen(bilanz);
      const ok = code === 0 && gruende.length === 0;
      ergebnisse.push({
        schritt: name,
        ok,
        dauerMs: Date.now() - start,
        hinweis: bilanz.gefunden ? `${bilanz.bestanden} bestanden, ${bilanz.gescheitert} gescheitert, ${bilanz.uebersprungen} übersprungen` : 'keine Bilanz',
      });
      if (!ok) abbrechen(`„${name}" ist gescheitert (Exitcode ${code ?? 'unbekannt'}). ${gruende.join(' ')}`);
      fertig();
    });
  });
}

async function pruefreihen(basis: string, cacheDir: string | undefined, port: string): Promise<void> {
  const env = { TEST_BASE_URL: basis, ...(cacheDir ? { CLENARIS_TEST_CACHE_DIR: cacheDir } : {}) };
  // HTML je Seite (2026-09-29): vor den Reihen, solange der Bestand der
  // Demobestand ist — danach hängt die Grösse davon ab, was die Fälle
  // angelegt haben. Bytes statt Millisekunden, also auf jeder Maschine gleich.
  schritt('Leistungsbudget (HTML je Seite)', 'npx tsx scripts/leistungsbudget.ts --nur-html', { env });
  schritt('Sicherheitsreihen', 'npm run security:check:tests', { env });
  /*
    Der Bericht wird hier **nicht** erzwungen. `npm test -- --test-reporter=tap`
    stünde hinter dem Dateimuster, und ob `node --test` Optionen dort noch als
    Optionen liest, hängt von der Fassung ab; über `NODE_OPTIONS` erbten ihn
    die Kindprozesse je Testdatei, die mit dem Elternprozess über einen eigenen
    Bericht sprechen. Beides wäre ein Eingriff mit unklarer Wirkung. Die
    Ausgabe ist hier kein Terminal, also wählt Node 22 TAP; eine spätere
    Fassung mit Spec liest `testbilanzLesen` ebenso.
  */
  await schrittMitBilanz('Testreihe (vollständig, seriell, 0 übersprungen)', 'npm test', { env });
  browserreihe(env, port);
}

/**
 * Browser-Prüfreihe mit Bilanz (2026-09-27, Rest von N-08).
 *
 * Ohne Wiederholungen: Ein Browserfall, der nur im zweiten Anlauf grün wird,
 * ist rot (Definition of Done, Checkliste G). Und wie bei `npm test` zählt
 * nicht nur der Exitcode: Playwright endet mit 0, wenn Fälle sich per
 * `test.skip()` verabschieden — etwa ohne Testdatenbank oder ohne passende
 * Demodaten. Der JSON-Bericht (neben der gewohnten Liste) liefert die Zahlen;
 * übersprungen, wackelig (`flaky`) oder unerwartet ist ein Fehlschlag, und
 * ein fehlender Bericht ebenso — ohne Zahlen ist nichts bewiesen.
 *
 * Seit 2026-09-30 **je Engine** (`pruefweg-abschluss.ts`): Die Summe allein
 * sagte nicht, ob Firefox und WebKit überhaupt gefahren sind. Jede der drei
 * Engines braucht mindestens einen bestandenen Fall, und die Zahlen stehen
 * nach dem Lauf je Engine in der Ausgabe und in der Laufbilanz.
 *
 * Der Bericht liegt in `test-results/` statt in einem Temp-Verzeichnis: Dort
 * lädt CI ihn bei einem Fehlschlag zusammen mit den Spuren hoch, und im
 * Release-Abzug sichert `befundsicherung.ts` ihn. Playwright leert das
 * Verzeichnis zu **Beginn** eines Laufs und schreibt den Bericht an dessen
 * Ende — er überlebt also genau bis zum nächsten Lauf. Vorher wird er
 * gelöscht: Scheiterte Playwright, bevor es selbst aufräumt (kaputte
 * Konfiguration), läse dieser Schritt sonst den Bericht des vorigen Laufs.
 */
function browserreihe(env: Record<string, string>, port: string): void {
  const bericht = join(WURZEL, 'test-results', 'playwright-bericht.json');
  rmSync(bericht, { force: true });
  schritt('Browser-Prüfreihe (ohne Wiederholungen)', 'npx playwright test --retries=0 --reporter=list,json', {
    env: { ...env, E2E_PORT: port, PLAYWRIGHT_JSON_OUTPUT_NAME: bericht },
  });
  const start = Date.now();
  const bilanz = browserBerichtLesen(bericht);
  letzteBrowserBilanz = bilanz;
  const gruende = engineBilanzPruefen(bilanz, { jedeEngine: true });
  if (bilanz) {
    console.log('\n━━ Browser-Bilanz je Engine');
    for (const zeile of engineZeilen(bilanz)) console.log(`   ${zeile}`);
  }
  const g = bilanz?.gesamt;
  ergebnisse.push({
    schritt: 'Browser-Bilanz (je Engine, 0 übersprungen, 0 wackelig)',
    ok: gruende.length === 0,
    dauerMs: Date.now() - start,
    hinweis: g ? `${g.expected ?? 0} bestanden, ${g.skipped ?? 0} übersprungen, ${g.flaky ?? 0} wackelig; ${bilanz!.engines.join('/')}` : 'kein Bericht',
  });
  if (gruende.length) abbrechen(`Browser-Bilanz: ${gruende.join(' ')}`);
}

/**
 * Der volle Weg: statisch, Testdatenbank, Bau, Server, Prüfreihen.
 *
 * Reihenfolge seit 2026-09-30 — und warum sie so ist:
 *
 *  1. **Migrationen, dann das Datenbanktor** („Datenbankschranken (live)“,
 *     `scripts/datenbank-schranken.ts` gegen `security/datenbank-schranken.json`).
 *     Die Schranken — etwa Trigger, die das Prüfprotokoll nur anfügen
 *     lassen, Teilindizes, Prüfbedingungen — stehen in handgeschriebenem SQL
 *     der Migrationen, das `prisma migrate dev` nicht kennt und still
 *     verwerfen kann. Ob sie in der Datenbank auch *sind*, sagt keine
 *     Migration über sich selbst; das Tor fragt die Datenbank. Exit 2 („nicht geprüft“: keine Adresse, keine
 *     Verbindung) bricht genauso ab wie 1 („Befund“) — ein Tor, das bei
 *     fehlender Verbindung grün wird, prüft nur, ob es eine Verbindung gab.
 *  2. **Nur die Konfiguration** (`npm run db:seed`), dann Bau und
 *     Leistungsbudget. Vorher lief der Demo-Seed vor dem Bau, und die
 *     öffentlichen Seiten wurden mit erfundenen Bewertungen, Blogartikeln
 *     und Stellen vorgerendert. Ein Bau, der Demodaten in sein HTML
 *     geschrieben hat, ist kein Bau, der ausgeliefert werden darf — und der
 *     Prüfweg soll den Bau prüfen, der ausgeliefert würde.
 *  3. **Mit `--frisch` ein Probeartefakt** (`scripts/release-artefakt.ts
 *     --ohne-module --unsauber`, in ein Temp-Verzeichnis). Dessen
 *     Stolperdraht weist einen Bau mit Demo-Kennzeichen ab. Nur auf der
 *     frischen Datenbank beweist er etwas: Auf einer wiederverwendeten
 *     liegen Demodaten vom letzten Lauf, und der Draht schlüge an, ohne dass
 *     der Code etwas falsch gemacht hätte. `--ohne-module`, weil nur der Bau
 *     interessiert und `node_modules` Minuten kostet; `--unsauber`, weil
 *     örtlich mit ungesicherten Änderungen gearbeitet wird (im
 *     Release-Abzug ist der Baum ohnehin sauber). Das Probeartefakt ist nie
 *     auslieferbar und wird danach verworfen.
 *  4. **Dann die Demodaten** (`npm run db:seed:demo`, idempotent), weil die
 *     Prüfreihen die fünf Demokonten und einen Bestand brauchen.
 *
 * Folge für die Prüfreihen: Seiten mit Zwischenspeicherung (ISR) zeigen bis
 * zu ihrer Erneuerung den Stand des Baus, also ohne Demobestand. Das ist der
 * Zustand, den auch die Produktion nach einer Auslieferung hat.
 */
async function voll(optionen: { frisch: boolean }): Promise<void> {
  statisch();
  const datenbank = testdatenbank();
  const dbEnv = { DATABASE_URL: datenbank, DIRECT_URL: datenbank };
  if (optionen.frisch) {
    schritt('Testdatenbank frisch aufsetzen (nur Konfiguration)', 'npm run db:test:setup -- --frisch --ohne-demo', { env: { TEST_DATABASE_URL: datenbank } });
  }
  schritt('Migrationen auf die Testdatenbank', 'npx prisma migrate deploy', { env: dbEnv });
  schritt('Datenbankschranken (live)', 'npx tsx scripts/datenbank-schranken.ts', {
    env: dbEnv,
    exitcodes: { 1: 'Befund — eine Schranke fehlt oder weicht ab', 2: 'nicht geprüft — keine Adresse oder keine Verbindung; das ist kein Bestehen' },
  });
  schritt('Konfiguration ohne Demodaten', 'npm run db:seed', { env: dbEnv });
  schritt('Build', 'npm run build', { env: { ...dbEnv, NODE_ENV: 'production' } });
  // Seit 2026-09-28: JavaScript je Route gegen `scripts/leistungsbudget.json`.
  // Grössen statt Millisekunden — auf jeder Maschine dieselbe Zahl, also ein
  // Tor, das nicht zufällig rot wird (Begründung in `leistungsbudget.ts`).
  schritt('Leistungsbudget (JavaScript je Route)', 'npx tsx scripts/leistungsbudget.ts');
  if (optionen.frisch) {
    const probe = mkdtempSync(join(tmpdir(), 'clenaris-probeartefakt-'));
    // Über `exit` statt `finally`: Scheitert der Schritt, endet der Prozess in
    // `abbrechen` mit `process.exit`, und ein `finally` liefe nie.
    const probeEntfernen = () => rmSync(probe, { recursive: true, force: true });
    process.once('exit', probeEntfernen);
    schritt('Probeartefakt ohne Demo-Kennzeichen (Stolperdraht)', `npx tsx scripts/release-artefakt.ts --ausgabe "${probe}" --ohne-module --unsauber`);
    probeEntfernen();
  }
  schritt('Demodaten (idempotent)', 'npm run db:seed:demo', { env: dbEnv });
  const port = process.env.VERIFY_PORT?.trim() || '3001';
  const cacheDir = mkdtempSync(join(tmpdir(), 'clenaris-verify-'));
  try {
    await serverStarten(datenbank, port, cacheDir);
    await pruefreihen(`http://127.0.0.1:${port}`, cacheDir, port);
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
 *
 * **Worktree, nicht `git archive`** (2026-09-27). Der Abzug per Archiv hat
 * kein `.git`, und zwei Schritte des Prüfwegs fragen git: die
 * Geheimnissuche (`git ls-files` — sie prüft den *verfolgten* Bestand) und
 * der Vergleich „Dokumentation ist mitgeliefert" (`git diff`). Im Archiv
 * scheiterte der erste mit „not a git repository", der Release-Weg konnte
 * also nie grün werden. Ein losgelöster Worktree des aktuellen Commits ist
 * genauso sauber — nur eingecheckte Dateien, keine örtlichen Reste, kein
 * gemeinsamer `node_modules` oder `.next` —, und git funktioniert darin.
 * Er wird am Ende wieder entfernt, auch nach einem Fehlschlag.
 */
/**
 * Release in zwei Teilen (2026-09-29, M4):
 *
 *   verify:release:core    Kern — sauberer Abzug, frische Datenbank, voller Prüfweg
 *   verify:release:stress  Stressreihe (5 Browserläufe, je frischer Server) auf einem vorhandenen Bau
 *   verify:release         beides, im selben Abzug — nur das ist ein Release-Nachweis
 *
 * Vorher endete `verify:release` nach dem Kern mit „Alle blockierenden
 * Schritte bestanden", und die Stressreihe war ein getrennter, vergessbarer
 * Aufruf. Ein wackelnder Browserfall zeigt sich aber gerade nicht im einen
 * Lauf des Kerns. Seit 2026-09-30 enden die beiden Teile mit Exitcode 3 und
 * „TEILPRÜFUNG BESTANDEN — KEIN RELEASE-NACHWEIS“, und nur der Gesamtweg
 * meldet „RELEASE BESTANDEN“ und schreibt den Nachweis
 * (`pruefweg-abschluss.ts`).
 */

/**
 * Die Aufräumarbeit des Release-Abzugs, solange sie aussteht. Sie läuft
 * **vor** der Schlussmeldung (in `main`), damit die Aussage des Laufs die
 * letzte Zeile bleibt — und als Rückfall beim Prozessende, wenn ein Schritt
 * mit `process.exit` abbricht.
 */
let abzugAufraeumen: (() => void) | null = null;

async function release(modus: 'release' | 'release-kern'): Promise<void> {
  const git = gitBefehl();
  if (!git) abbrechen('git nicht gefunden — ohne Worktree kein sauberer Abzug.');
  const start = new Date();
  const ziel = mkdtempSync(join(tmpdir(), 'clenaris-release-'));
  const quelle = join(ziel, 'quelle');
  // `hydrationsbefunde/` ist nicht verfolgt — die Ablage stört weder den
  // Arbeitsbaum noch den nächsten Release-Lauf.
  const ablage = join(WURZEL, 'hydrationsbefunde', `release-${basename(ziel)}`);
  abzugAufraeumen = () => {
    abzugAufraeumen = null;
    // Erst sichern, dann entfernen (RC-20): Mit dem Abzug verschwanden die
    // Spur eines roten Laufs und das Protokoll, auf das die Ausgabe zeigt.
    // Seit 2026-09-30 liegt darunter auch der Release-Nachweis.
    const gesichert = abzugsbefundeSichern(quelle, ablage);
    if (gesichert.length > 0) console.log(`\n   Beweise des Release-Laufs gesichert: ${ablage}`);
    spawnSync(`${git} worktree remove --force "${quelle}"`, { shell: true, cwd: WURZEL, stdio: 'ignore' });
    rmSync(ziel, { recursive: true, force: true });
  };
  process.once('exit', () => abzugAufraeumen?.());
  schritt('Sauberer Abzug des aktuellen Commits (git worktree, losgelöst)', `${git} worktree add --detach "${quelle}" HEAD`);
  // Die `.env` gehört nicht ins Repository; die Testdatenbank wird ausdrücklich
  // übergeben, damit der Abzug dieselbe Datenbank ableitet wie der Arbeitsbaum.
  if (existsSync(join(WURZEL, '.env'))) cpSync(join(WURZEL, '.env'), join(quelle, '.env'));
  schritt('Abhängigkeiten aus der Sperrdatei (npm ci)', 'npm ci --no-audit --no-fund', { cwd: quelle });
  // Die Laufbilanz des Kerns liegt neben dem Abzug, nicht in seinem
  // `test-results/`: Das leert Playwright zu Beginn jedes Stresslaufs.
  const kernBilanz = join(ziel, 'kern-bilanz.json');
  schritt('Voller Prüfweg im Abzug, frische Testdatenbank', 'npx tsx scripts/verify.ts voll --frisch', {
    cwd: quelle,
    env: { TEST_DATABASE_URL: testdatenbank(), CLENARIS_PRUEFWEG_BILANZ: kernBilanz },
  });
  if (modus === 'release-kern') return;

  // Im selben Abzug und auf seinem Bau: Die Stressreihe prüft, was der Kern
  // gebaut hat. Ihr Bericht liegt in `test-results/` des Abzugs — nach dem
  // letzten Lauf geschrieben, also von keinem Playwright-Lauf mehr geleert —
  // und wird dort mitgesichert, auch wenn die Reihe rot endet.
  const stressBericht = join(quelle, 'test-results', 'stress-bericht.json');
  stressreihe(quelle, stressBericht);
  nachweisAblegen({ git, quelle, ablage, start, kernBilanz, stressBericht });
}

function stressreihe(cwd: string, bericht?: string): void {
  const datenbank = testdatenbank();
  schritt(
    `Stressreihe (${STRESS_LAEUFE} Browserläufe, je frischer Server, ohne Wiederholungen)`,
    `npx tsx scripts/e2e-stress.ts --laeufe ${STRESS_LAEUFE}${bericht ? ` --bericht "${bericht}"` : ''}`,
    { cwd, env: { TEST_DATABASE_URL: datenbank } },
  );
}

function jsonLesen<T>(pfad: string): T | null {
  try {
    return JSON.parse(readFileSync(pfad, 'utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * Den Release-Nachweis bauen und in `test-results/` des Abzugs schreiben
 * (2026-09-30). Von dort sichert ihn `abzugAufraeumen` mit den übrigen
 * Beweisen nach `hydrationsbefunde/release-…/test-results/`.
 *
 * Kann der Nachweis nicht gebaut werden — fehlt die Bilanz des Kerns, sind
 * es nicht fünf grüne Stressläufe, fehlt einer Engine jeder bestandene
 * Fall —, bricht der Release-Weg ab, obwohl jeder Schritt einzeln grün war:
 * Ein „RELEASE BESTANDEN“ ohne Datei, die es trägt, gibt es nicht.
 */
function nachweisAblegen(a: { git: string; quelle: string; ablage: string; start: Date; kernBilanz: string; stressBericht: string }): void {
  const beginn = Date.now();
  const commit = (spawnSync(`${a.git} rev-parse HEAD`, { shell: true, cwd: a.quelle, encoding: 'utf8' }).stdout ?? '').trim();
  const dist = process.env.NEXT_DIST_DIR?.trim() || '.next';
  const buildIdDatei = join(a.quelle, dist, 'BUILD_ID');
  const buildId = existsSync(buildIdDatei) ? readFileSync(buildIdDatei, 'utf8').trim() : null;
  const ergebnis = releaseNachweisBauen({
    commit,
    buildId,
    start: a.start,
    ende: new Date(),
    kern: jsonLesen<Laufbilanz>(a.kernBilanz),
    stress: jsonLesen<Stressbericht>(a.stressBericht),
  });
  if (!ergebnis.nachweis) {
    ergebnisse.push({ schritt: 'Release-Nachweis', ok: false, dauerMs: Date.now() - beginn, hinweis: 'nicht belegt' });
    abbrechen(`Release-Nachweis nicht belegt: ${ergebnis.gruende.join(' ')}`);
  }
  const pfad = releaseNachweisSchreiben('release', join(a.quelle, 'test-results'), ergebnis.nachweis);
  if (!pfad) abbrechen('Release-Nachweis nicht geschrieben.');
  ergebnisse.push({
    schritt: 'Release-Nachweis',
    ok: true,
    dauerMs: Date.now() - beginn,
    hinweis: `${commit.slice(0, 12)}, ${join(a.ablage, 'test-results', RELEASE_NACHWEIS_DATEI)}`,
  });
}

async function main(): Promise<void> {
  const eingabe = process.argv[2];
  if (!eingabe || !(MODI as readonly string[]).includes(eingabe)) {
    console.error(`Aufruf: tsx scripts/verify.ts ${MODI.join(' | ')}   (voll auch mit --frisch)`);
    process.exit(2);
  }
  const modus = eingabe as Modus;
  laufModus = modus;
  const frisch = process.argv.includes('--frisch');
  process.on('SIGINT', () => abbrechen('Abgebrochen.'));

  switch (modus) {
    case 'statisch':
      statisch();
      break;
    case 'pruefreihen': {
      const basis = process.env.TEST_BASE_URL?.trim();
      if (!basis) abbrechen('TEST_BASE_URL fehlt — `pruefreihen` läuft gegen einen bereits gestarteten Server.');
      await pruefreihen(basis, process.env.CLENARIS_TEST_CACHE_DIR, new URL(basis).port || '80');
      break;
    }
    case 'browser': {
      // `npm run verify:e2e` (2026-09-27): dieselbe Browserreihe mit Bilanz wie
      // im vollen Weg, gegen einen bereits laufenden Server. Vorher war das ein
      // blosses `playwright test --retries=0`, das nur den Exitcode sah.
      const basis = process.env.TEST_BASE_URL?.trim();
      if (!basis) abbrechen('TEST_BASE_URL fehlt — `browser` läuft gegen einen bereits gestarteten Server.');
      browserreihe({ TEST_BASE_URL: basis }, new URL(basis).port || '80');
      break;
    }
    case 'voll':
      await voll({ frisch });
      break;
    case 'release':
    case 'release-kern':
      await release(modus);
      break;
    case 'release-stress':
      // Gegen den Bau im Arbeitsbaum (`.next`); `e2e-stress.ts` bricht ohne ab.
      stressreihe(WURZEL);
      break;
  }
  // Erst die Beweise des Abzugs sichern (samt Nachweis), dann die
  // Zusammenfassung und als letzte Zeile die Aussage des Laufs.
  abzugAufraeumen?.();
  zusammenfassung();
  bilanzAblegen(true);
  const ende = abschluss(modus);
  console.log(`\n${ende.text}`);
  // `exitCode` statt `process.exit`: Der Prozess endet von selbst, und die
  // Ausgabe darüber wird vorher vollständig geschrieben — auch in eine Pipe.
  process.exitCode = ende.code;
}

void main();
