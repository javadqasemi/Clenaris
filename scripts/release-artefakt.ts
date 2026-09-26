/**
 * Ein unveränderliches Release-Artefakt packen (Production V2, Wave 22).
 *
 *   npm ci
 *   node scripts/react-hydrationskorrektur.mjs --pruefen
 *   npm run build            # und die Prüfreihen gegen genau diesen Bau
 *   npx tsx scripts/release-artefakt.ts --ausgabe release/
 *
 * ---------------------------------------------------------------------------
 *  Warum
 * ---------------------------------------------------------------------------
 *
 * Heute baut `scripts/deploy.sh` **auf dem Server**: `git reset --hard`,
 * `npm ci`, `next build`. Die Pipeline prüft also einen Bau, und ausgeliefert
 * wird ein anderer — aus demselben Commit, aber mit einem eigenen `npm ci`,
 * einer eigenen Anwendung der React-Korrektur und einem eigenen `next build`.
 * Meistens ist das dasselbe. Wenn nicht, merkt es niemand, denn geprüft wurde
 * das Original.
 *
 * Das Artefakt schliesst diese Lücke: Gepackt wird **genau** der Baum, gegen
 * den die Prüfreihen liefen — `.next`, `node_modules` mit angewandter
 * Korrektur, Migrationen —, mit einem Manifest und einer SHA-256. Der Server
 * baut nichts mehr; er prüft die Summe, entpackt und startet mit
 * `start:built`. Was lief, ist, was geprüft wurde.
 *
 * ---------------------------------------------------------------------------
 *  Was das Skript verweigert
 * ---------------------------------------------------------------------------
 *
 *  • einen unvollständigen Bau — `BUILD_ID` allein reicht nicht, er wird früh
 *    geschrieben; verlangt werden auch `routes-manifest.json` und
 *    `prerender-manifest.json` (dieselbe Falle wie bei `test:server`);
 *  • einen Baum ohne React-Korrektur (`--pruefen` muss grün sein);
 *  • jede `.env*` ausser `.env.example` im Artefakt — Geheimnisse gehören auf
 *    den Server, nicht in ein Archiv, das in CI liegt;
 *  • einen Commit mit ungesicherten Änderungen, ausser mit `--unsauber` (für
 *    eine örtliche Probe; das Manifest vermerkt es).
 *
 * `node_modules` gehört hinein, obwohl es gross ist: Die Korrektur ist eine
 * Veränderung *in* `node_modules`, und ein `npm ci` auf dem Server wäre genau
 * der zweite, ungeprüfte Baum, den das Artefakt abschaffen soll. Gebaut wird
 * deshalb auf demselben Betriebssystem wie der Server (Linux), sonst passt
 * die Prisma-Engine nicht. `--ohne-module` lässt es für eine örtliche Probe
 * weg und schreibt das ins Manifest; ein solches Artefakt ist nicht
 * auslieferbar, und `deploy/v2/release-aktivieren.sh` weist es ab.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { loadEnvConfig } from '@next/env';

const WURZEL = resolve(__dirname, '..');

// Dieselben `.env`-Dateien in derselben Reihenfolge wie `next build` — sonst
// hielte das Manifest eine andere `seitenUrl` fest, als im Bündel steht.
loadEnvConfig(WURZEL, false);

function argument(name: string, vorgabe = ''): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : vorgabe;
}
const schalter = (name: string) => process.argv.includes(`--${name}`);

/**
 * Was ins Artefakt gehört. Bewusst eine Liste von Einschlüssen statt
 * Ausschlüssen: Was neu im Repository auftaucht, landet nicht zufällig in der
 * Produktion. `src` und `tsconfig.json` sind dabei, weil Betriebsskripte
 * (`backfill-kpi.ts`, `db-backup.ts`) über `tsx` die Dienste importieren.
 */
const INHALT = [
  'package.json',
  'package-lock.json',
  'next.config.ts',
  'ecosystem.config.js',
  'tsconfig.json',
  'postcss.config.mjs',
  'tailwind.config.ts',
  'public',
  'prisma',
  'scripts',
  'src',
  // Das Aktivierungsskript reist mit: Das nächste Release wird mit dem
  // Skript des laufenden aktiviert, nicht mit einem Stand aus Git.
  'deploy',
];

/** Nie im Artefakt, auch wenn ein Einschluss sie träfe. */
const AUSSCHLUSS = ['.env', '.env.*', '*.tsbuildinfo', 'cache'];

function sha256Datei(pfad: string): Promise<string> {
  return new Promise((ok, fehler) => {
    const h = createHash('sha256');
    createReadStream(pfad)
      .on('data', (d) => h.update(d))
      .on('end', () => ok(h.digest('hex')))
      .on('error', fehler);
  });
}

function git(...args: string[]): string {
  const bin = process.env.GIT_BIN || 'git';
  return execFileSync(bin, args, { cwd: WURZEL, encoding: 'utf8' }).trim();
}

async function main(): Promise<void> {
  const ausgabe = resolve(argument('ausgabe', 'release'));
  const distDir = process.env.NEXT_DIST_DIR?.trim() || '.next';
  const ohneModule = schalter('ohne-module');
  const unsauberErlaubt = schalter('unsauber');

  // --- Commit --------------------------------------------------------------
  const commit = process.env.GITHUB_SHA?.trim() || git('rev-parse', 'HEAD');
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`Kein gültiger Commit: ${commit}`);
  const unsauber = git('status', '--porcelain', '--untracked-files=no').length > 0;
  if (unsauber && !unsauberErlaubt) {
    throw new Error('Der Arbeitsbaum hat ungesicherte Änderungen. Ein Artefakt muss einem Commit entsprechen (--unsauber nur für Proben).');
  }

  // --- Bau vollständig? ----------------------------------------------------
  const bau = join(WURZEL, distDir);
  for (const datei of ['BUILD_ID', 'routes-manifest.json', 'prerender-manifest.json']) {
    if (!existsSync(join(bau, datei))) {
      throw new Error(`${distDir}/${datei} fehlt — der Bau ist nicht vollständig (oder läuft noch).`);
    }
  }
  const buildId = readFileSync(join(bau, 'BUILD_ID'), 'utf8').trim();

  // --- React-Korrektur -----------------------------------------------------
  const korrektur = spawnSync(process.execPath, [join(WURZEL, 'scripts', 'react-hydrationskorrektur.mjs'), '--pruefen'], {
    cwd: WURZEL,
    encoding: 'utf8',
  });
  if (korrektur.status !== 0) {
    throw new Error(`React-Hydrationskorrektur nicht angewendet:\n${korrektur.stdout}${korrektur.stderr}`);
  }

  // --- Manifest ------------------------------------------------------------
  const paket = JSON.parse(readFileSync(join(WURZEL, 'package.json'), 'utf8')) as { version: string };
  const nextVersion = (JSON.parse(readFileSync(join(WURZEL, 'node_modules', 'next', 'package.json'), 'utf8')) as { version: string }).version;
  const npmVersion = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['-v'], { encoding: 'utf8', shell: process.platform === 'win32' }).stdout.trim();
  const manifest = {
    format: 1,
    anwendung: 'clenaris',
    version: paket.version,
    commit,
    unsauber,
    buildId,
    distDir,
    erstelltUtc: new Date().toISOString(),
    node: process.version,
    npm: npmVersion,
    plattform: `${process.platform}-${process.arch}`,
    next: nextVersion,
    sperrdateiSha256: await sha256Datei(join(WURZEL, 'package-lock.json')),
    /*
      Seit V2-1 (2026-09-26) ist das Artefakt **nicht** mehr an eine Adresse
      gebunden: Links, Mails, Zahlungen, Signaturen und die Herkunftsprüfung
      lesen `APP_URL` zur Laufzeit (`src/lib/laufzeit-konfiguration.ts`).
      Beim Bau fest steht nur die kanonische Domain der statisch
      vorgerenderten Website (`src/lib/seiten-url.ts`) — ein Wert für alle
      Umgebungen. Er steht hier zur Nachvollziehbarkeit, nicht als Bindung.
    */
    seitenUrl: process.env.NEXT_PUBLIC_SITE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? null,
    reactKorrektur: 'geprueft',
    mitModulen: !ohneModule,
    // Ein Artefakt ohne Module, aus einem unsauberen Baum oder aus einem
    // anderen Bauverzeichnis als `.next` ist eine Probe: `start:built` liest
    // `.next`, und ein umgeleitetes Verzeichnis auf dem Server wäre eine
    // zweite Konfiguration, die niemand geprüft hat.
    auslieferbar: !ohneModule && !unsauber && distDir === '.next',
  };

  mkdirSync(ausgabe, { recursive: true });
  const name = `clenaris-${commit.slice(0, 12)}${ohneModule ? '-probe' : ''}`;
  const manifestPfad = join(WURZEL, 'RELEASE.json');
  writeFileSync(manifestPfad, `${JSON.stringify(manifest, null, 2)}\n`);

  // --- Packen --------------------------------------------------------------
  const archiv = join(ausgabe, `${name}.tar.gz`);
  const inhalt = [...INHALT, distDir, 'RELEASE.json', ...(ohneModule ? [] : ['node_modules'])].filter((p) =>
    existsSync(join(WURZEL, p)),
  );
  // Auch `.env.example` bleibt draussen: Das Muster soll ohne Ausnahme gelten,
  // damit die Gegenprobe unten keine Liste erlaubter Umgebungsdateien braucht.
  const ausschluss = [...AUSSCHLUSS, `${distDir}/cache`].flatMap((m) => ['--exclude', m]);
  const tar = spawnSync('tar', ['-czf', archiv, ...ausschluss, ...inhalt], { cwd: WURZEL, encoding: 'utf8' });
  rmSync(manifestPfad, { force: true });
  if (tar.status !== 0) throw new Error(`tar ist fehlgeschlagen: ${tar.stderr}`);

  // Die Gegenprobe: Liegt wirklich keine `.env` drin?
  const liste = spawnSync('tar', ['-tzf', archiv], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });
  const eintraege = liste.stdout.split(/\r?\n/).filter(Boolean);
  const geheim = eintraege.filter((e) => /(^|\/)\.env(\.|$)/.test(e));
  if (geheim.length > 0) throw new Error(`Das Artefakt enthält Umgebungsdateien: ${geheim.join(', ')}`);

  const summe = await sha256Datei(archiv);
  writeFileSync(join(ausgabe, `${name}.tar.gz.sha256`), `${summe}  ${name}.tar.gz\n`);
  writeFileSync(join(ausgabe, `${name}.json`), `${JSON.stringify({ ...manifest, archivSha256: summe }, null, 2)}\n`);

  console.log(`Artefakt      : ${archiv}`);
  console.log(`Grösse        : ${Math.round(statSync(archiv).size / 1024 / 1024)} MB, ${eintraege.length} Einträge`);
  console.log(`SHA-256       : ${summe}`);
  console.log(`Commit        : ${commit}${unsauber ? ' (UNSAUBER)' : ''}`);
  console.log(`Build-ID      : ${buildId}`);
  console.log(`Auslieferbar  : ${manifest.auslieferbar ? 'ja' : 'nein (Probe)'}`);
}

main().catch((fehler) => {
  console.error(`❌  ${fehler instanceof Error ? fehler.message : String(fehler)}`);
  process.exit(1);
});
