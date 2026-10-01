/**
 * Ein unveränderliches Release-Artefakt packen (Production V2, Wave 22;
 * Manifest Format 2 seit 2026-09-30).
 *
 *   npm ci
 *   node scripts/react-hydrationskorrektur.mjs --pruefen
 *   npm run build            # gegen eine Datenbank OHNE Demobestand
 *   npx tsx scripts/release-artefakt.ts --ausgabe release/ [--ohne-module] [--unsauber]
 *
 * Ergebnis im Ausgabeverzeichnis:
 *
 *   clenaris-<sha12>.tar.gz          das Archiv, mit RELEASE.json darin
 *   clenaris-<sha12>.tar.gz.sha256   `<summe>  <name>` für `sha256sum -c`
 *   clenaris-<sha12>.json            das Beiblatt: Manifest + Summe, Grösse,
 *                                    Packzeit, ob normalisiert gepackt
 *
 * ---------------------------------------------------------------------------
 *  Warum
 * ---------------------------------------------------------------------------
 *
 * Bis Wave 22 baute `scripts/deploy.sh` **auf dem Server**: `git reset
 * --hard`, `npm ci`, `next build`. Die Pipeline prüfte also einen Bau, und
 * ausgeliefert wurde ein anderer — aus demselben Commit, aber mit einem
 * eigenen `npm ci`, einer eigenen Anwendung der Korrekturen und einem eigenen
 * `next build`. Meistens ist das dasselbe. Wenn nicht, merkt es niemand, denn
 * geprüft wurde das Original.
 *
 * Das Artefakt schliesst diese Lücke: Gepackt wird **genau** der Baum, gegen
 * den die Prüfreihen liefen — `.next`, `node_modules` mit angewandten
 * Korrekturen, Migrationen —, mit einem Manifest und einer SHA-256. Der Server
 * baut nichts mehr; er prüft die Summe, entpackt und startet mit
 * `start:built`. Was lief, ist, was geprüft wurde.
 *
 * Die Regeln — was hineingehört, was draussen bleibt, wie gepackt und
 * gegengeprüft wird — stehen in `scripts/release/artefakt-regeln.ts` und sind
 * dort ohne Bau geprüft (`tests/api/release-artefakt.test.ts`). Diese Datei
 * sammelt die Messwerte (Git, Bau, Werkzeuge), ruft die Regeln und führt aus.
 *
 * ---------------------------------------------------------------------------
 *  Was das Skript verweigert (Exit 1, nichts Brauchbares im Ausgabeverzeichnis)
 * ---------------------------------------------------------------------------
 *
 *  • einen unvollständigen Bau — `BUILD_ID` allein reicht nicht, er wird früh
 *    geschrieben; verlangt werden auch `routes-manifest.json` und
 *    `prerender-manifest.json` (dieselbe Falle wie bei `test:server`);
 *  • einen Baum ohne die beiden Korrekturen in `node_modules` —
 *    React-Hydration (RB-001) und Next-Cachezeit (RB-002). Bis 2026-09-30
 *    wurde nur RB-001 geprüft; ein Baum ohne RB-002 wäre ausgeliefert worden,
 *    und nach Tagen Laufzeit hätten veröffentlichte Inhalte bis zu einer
 *    Stunde gefehlt (Kopf von `scripts/next-cachezeit-korrektur.mjs`);
 *  • **Demodaten im Bau** — erfundene Bewertungen, Beispielartikel, Namen und
 *    Adressen der Demokundschaft in vorgerenderten Seiten, Sitemap oder
 *    Manifesten (`prisma/demo-kennzeichen.ts`). Die Meldung nennt die Datei,
 *    nicht den Wert;
 *  • jede Umgebungsdatei (`.env*`, auch `.env.example`) im Archiv ausserhalb
 *    von `node_modules` — Geheimnisse gehören auf den Server, nicht in ein
 *    Archiv, das in der CI liegt;
 *  • ein Archiv, dessen Liste nicht genau dem abgelaufenen Baum entspricht
 *    (fehlender, überzähliger oder doppelter Eintrag);
 *  • einen Commit mit ungesicherten Änderungen — geänderte verfolgte Dateien
 *    überall, **unverfolgte Dateien in den Einträgen des Artefakts** —, ausser
 *    mit `--unsauber` (für eine örtliche Probe; das Manifest vermerkt es);
 *  • **von Git ignorierte Dateien** im Inhalt (eine `*.pem` unter `deploy/`),
 *    die `git status` nie zeigt — ausser den erzeugten Orten in
 *    `IGNORIERT_ERLAUBT` (`public/pdfjs/`); auch mit `--unsauber`;
 *  • einen `GITHUB_SHA`, der nicht dem ausgecheckten Commit entspricht, und
 *    eine CI-Herkunft, die nur halb gesetzt ist;
 *  • ein Ausgabeverzeichnis innerhalb eines Eintrags des Artefakts.
 *
 * `node_modules` gehört hinein, obwohl es gross ist: Die Korrekturen sind
 * Veränderungen *in* `node_modules`, und ein `npm ci` auf dem Server wäre
 * genau der zweite, ungeprüfte Baum, den das Artefakt abschaffen soll.
 * Gebaut wird deshalb auf demselben Betriebssystem wie der Server (Linux),
 * sonst passt die Prisma-Engine nicht. `--ohne-module` lässt es für eine
 * örtliche Probe weg und schreibt das ins Manifest; ein solches Artefakt ist
 * nicht auslieferbar, und `deploy/v2/release-aktivieren.sh` weist es ab.
 *
 * ---------------------------------------------------------------------------
 *  Auslieferbar
 * ---------------------------------------------------------------------------
 *
 * Entscheidet allein `auslieferbarNach` in `src/lib/release/manifest.ts`:
 * mit Modulen, sauber, aus `.next`, gebaut in einem CI-Lauf durch einen Push
 * (oder einen von Hand gestarteten Lauf) auf `main`. Ein Pull-Request-Lauf
 * baut einen Zusammenführungs-Commit, der nie auf `main` stand; ein örtlicher
 * Bau hat keine geprüfte Herkunft. Beides wird gepackt — als Probe.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';

import { loadEnvConfig } from '@next/env';

import type { ArtefaktManifest } from '../src/lib/release/manifest';
import {
  AUSSCHLUSSGRUND_TEXT,
  MANIFEST_DATEI,
  archivlisteLesen,
  artefaktName,
  beilageBauen,
  ciHerkunftAusUmgebung,
  commitBestimmen,
  demodatenMeldung,
  demodatenSuchen,
  eintraegeSammeln,
  ignoriertAbfrage,
  ignoriertImArchiv,
  manifestBauen,
  migrationenAuflisten,
  packliste,
  quelleZeit,
  tarArtErkennen,
  tarAufruf,
  umgebungsdateienImArchiv,
  unsauberePfade,
  vollstaendig,
  vollstaendigkeitPruefen,
  type Ausschlussgrund,
  type TarArt,
} from './release/artefakt-regeln';

const WURZEL = resolve(__dirname, '..');

function argument(name: string, vorgabe = ''): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : vorgabe;
}
const schalter = (name: string) => process.argv.includes(`--${name}`);

function sha256Datei(pfad: string): Promise<string> {
  return new Promise((ok, fehler) => {
    const h = createHash('sha256');
    createReadStream(pfad)
      .on('data', (d) => h.update(d))
      .on('end', () => ok(h.digest('hex')))
      .on('error', fehler);
  });
}

/**
 * `git` mit roher Ausgabe. Nicht getrimmt: `git status --porcelain` beginnt
 * eine Zeile mit einem Leerzeichen, wenn nur der Arbeitsbaum geändert ist —
 * ein `trim()` schnitte aus „ M src/x.ts" den Status ab.
 */
function gitRoh(...args: string[]): string {
  const bin = process.env.GIT_BIN || 'git';
  const r = spawnSync(bin, args, { cwd: WURZEL, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new Error(`git ist nicht aufrufbar (${bin}): ${r.error.message} — GIT_BIN setzen, wenn git nicht im PATH liegt.`);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} ist fehlgeschlagen: ${r.stderr.trim()}`);
  return r.stdout;
}
const git = (...args: string[]) => gitRoh(...args).trim();

/** Welche tar-Fassung im PATH liegt — GNU tar packt reproduzierbar, bsdtar nur als Probe. */
export function tarArtAbfragen(): TarArt {
  const r = spawnSync('tar', ['--version'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new Error(`tar ist nicht aufrufbar: ${r.error?.message ?? r.stderr}`);
  const art = tarArtErkennen(r.stdout);
  if (!art) {
    throw new Error(`Unbekannte tar-Fassung (${r.stdout.split(/\r?\n/)[0]}) — verlangt ist GNU tar (CI, Server) oder bsdtar (örtliche Probe).`);
  }
  return art;
}

/**
 * Einen Prozess laufen lassen; bei GNU tar mit `gzip -n` dahinter. Beide
 * Ausgangscodes zählen: Stirbt gzip, bricht tar mit einem Schreibfehler ab,
 * und stirbt tar, schreibt gzip ein gültiges, aber abgeschnittenes Archiv —
 * das fiele erst beim Entpacken auf dem Server auf.
 */
function tarLaufen(befehl: { argumente: string[]; gzip: string[] | null }, wurzel: string, archiv: string): Promise<void> {
  return new Promise((ok, fehler) => {
    const meldungen: string[] = [];
    const ziel = befehl.gzip ? openSync(archiv, 'w') : null;
    const tar = spawn('tar', befehl.argumente, { cwd: wurzel, stdio: ['ignore', befehl.gzip ? 'pipe' : 'ignore', 'pipe'] });
    const gz = befehl.gzip && ziel !== null ? spawn('gzip', befehl.gzip, { stdio: ['pipe', ziel, 'pipe'] }) : null;
    if (gz) {
      // Ein Schreibfehler in die Leitung (gzip schon beendet) kommt über den
      // Ausgangscode von tar an; unbehandelt beendete er diesen Prozess.
      gz.stdin!.on('error', () => undefined);
      tar.stdout!.pipe(gz.stdin!);
      gz.stderr!.on('data', (d) => meldungen.push(`gzip: ${String(d)}`));
    }
    tar.stderr!.on('data', (d) => meldungen.push(`tar: ${String(d)}`));

    const codes = new Map<string, number | null>();
    let beendet = false;
    const abschliessen = (name: string, code: number | null, fehlerbild?: Error) => {
      if (beendet) return;
      if (fehlerbild) {
        meldungen.push(`${name}: ${fehlerbild.message}\n`);
        // Startet einer der beiden nicht, wartete der andere ewig auf seine
        // Leitung — und hielte diesen Prozess (oder die Prüfung) am Leben.
        tar.kill();
        gz?.kill();
      }
      codes.set(name, fehlerbild ? -1 : code);
      if (codes.size < (gz ? 2 : 1) && !fehlerbild) return;
      beendet = true;
      if (ziel !== null) closeSync(ziel);
      const schlecht = [...codes.entries()].filter(([, c]) => c !== 0);
      if (schlecht.length === 0) ok();
      else fehler(new Error(`Packen fehlgeschlagen (${schlecht.map(([n, c]) => `${n} ${c}`).join(', ')}):\n${meldungen.join('').trim()}`));
    };
    tar.on('error', (e) => abschliessen('tar', null, e));
    tar.on('close', (code) => abschliessen('tar', code));
    gz?.on('error', (e) => abschliessen('gzip', null, e));
    gz?.on('close', (code) => abschliessen('gzip', code));
  });
}

/**
 * Ist der Bau packbar? Liefert die Build-ID oder hält an.
 *
 *  • **Vollständig:** `BUILD_ID` allein reicht nicht, Next schreibt sie früh;
 *    erst `routes-manifest.json` und `prerender-manifest.json` zeigen einen
 *    abgeschlossenen Bau (dieselbe Falle wie bei `test:server`).
 *  • **Ohne Demodaten** (`prisma/demo-kennzeichen.ts`): Die Pipeline spielt
 *    den Demobestand für die Prüfreihen ein, und die Website wird beim Bau
 *    vorgerendert. Ein Bau gegen diese Datenbank trägt erfundene Bewertungen
 *    und Beispielartikel in `.next/server` — ausgeliefert stünden sie auf der
 *    echten Website, bis die erste Neuvalidierung sie ersetzt. Es gibt keinen
 *    Schalter dagegen: Eine Probe mit Demodaten ist mit `--ohne-module` nicht
 *    ungefährlicher, sie landet nur seltener auf einem Server.
 *
 * Exportiert für `tests/api/release-artefakt.test.ts`.
 */
export function bauPruefen(wurzel: string, distDir: string): string {
  const bau = join(wurzel, distDir);
  for (const datei of ['BUILD_ID', 'routes-manifest.json', 'prerender-manifest.json']) {
    if (!existsSync(join(bau, datei))) {
      throw new Error(`${distDir}/${datei} fehlt — der Bau ist nicht vollständig (oder läuft noch).`);
    }
  }
  const treffer = demodatenSuchen(wurzel, distDir);
  if (treffer.length > 0) throw new Error(demodatenMeldung(treffer));
  const buildId = readFileSync(join(bau, 'BUILD_ID'), 'utf8').trim();
  if (!buildId) throw new Error(`${distDir}/BUILD_ID ist leer.`);
  return buildId;
}

function auszug(liste: readonly string[], hoechstens = 20): string {
  const teil = liste.slice(0, hoechstens).map((e) => `  ${e}`);
  if (liste.length > hoechstens) teil.push(`  … und ${liste.length - hoechstens} weitere`);
  return teil.join('\n');
}

/**
 * Das Archiv schreiben und gegenprüfen.
 *
 * Das Manifest entsteht in einem eigenen Zwischenverzeichnis und kommt von
 * dort ins Archiv — nie in die Wurzel des Repositories: Dort läge es nach
 * einem Abbruch als unverfolgte Datei, und der nächste Lauf fände einen
 * „unsauberen" Baum oder, schlimmer, packte das alte Manifest.
 *
 * Nach dem Packen wird das Archiv aufgelistet und mit der erwarteten Liste
 * verglichen (`vollstaendigkeitPruefen`), dann nach Umgebungsdateien
 * durchsucht. Scheitert etwas, wird das Archiv gelöscht: Ein halbes Archiv im
 * Ausgabeverzeichnis würde vom nächsten Schritt (Ablage in der CI) sonst
 * womöglich hochgeladen.
 *
 * Exportiert für `tests/api/release-artefakt.test.ts`, damit der echte
 * `tar`-Aufruf an einem kleinen Baum geprüft wird — auf dem Prüfrechner mit
 * der tar-Fassung, die dort liegt.
 */
export async function archivPacken(o: {
  wurzel: string;
  archiv: string;
  eintraege: readonly string[];
  manifest: ArtefaktManifest;
  quelleEpoche: number;
}): Promise<{ art: TarArt; normalisiert: boolean; gelistet: string[] }> {
  const art = tarArtAbfragen();
  const zwischen = mkdtempSync(join(tmpdir(), 'clenaris-artefakt-'));
  try {
    writeFileSync(join(zwischen, MANIFEST_DATEI), `${JSON.stringify(o.manifest, null, 2)}\n`);
    const listenDatei = join(zwischen, 'packliste');
    const aufruf = tarAufruf({
      art,
      archiv: o.archiv,
      listenDatei,
      manifestVerzeichnis: zwischen,
      eintraege: o.eintraege,
      quelleEpoche: o.quelleEpoche,
    });
    writeFileSync(listenDatei, aufruf.liste);
    await tarLaufen(aufruf, o.wurzel, o.archiv);

    const liste = spawnSync('tar', aufruf.auflisten, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });
    if (liste.status !== 0) throw new Error(`Das Archiv lässt sich nicht auflisten: ${liste.stderr}`);
    const gelistet = archivlisteLesen(liste.stdout);

    const befund = vollstaendigkeitPruefen([...o.eintraege, MANIFEST_DATEI], gelistet);
    if (!vollstaendig(befund)) {
      throw new Error(
        [
          'Das Archiv entspricht nicht dem abgelaufenen Baum:',
          ...(befund.fehlend.length ? [`fehlend (${befund.fehlend.length}):`, auszug(befund.fehlend)] : []),
          ...(befund.ueberzaehlig.length ? [`überzählig (${befund.ueberzaehlig.length}):`, auszug(befund.ueberzaehlig)] : []),
          ...(befund.doppelt.length ? [`doppelt (${befund.doppelt.length}):`, auszug(befund.doppelt)] : []),
        ].join('\n'),
      );
    }
    const geheim = umgebungsdateienImArchiv(gelistet);
    if (geheim.length > 0) throw new Error(`Das Archiv enthält Umgebungsdateien ausserhalb von node_modules:\n${auszug(geheim)}`);

    return { art, normalisiert: aufruf.normalisiert, gelistet };
  } catch (fehler) {
    rmSync(o.archiv, { force: true });
    throw fehler;
  } finally {
    rmSync(zwischen, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  // Dieselben `.env`-Dateien in derselben Reihenfolge wie `next build` — sonst
  // hielte das Manifest eine andere `seitenUrl` fest, als im Bündel steht.
  // Erst hier und nicht beim Import: Die Prüfung importiert `archivPacken`
  // und soll dabei keine Umgebung des Repositories erben.
  loadEnvConfig(WURZEL, false);

  const ausgabe = resolve(argument('ausgabe', 'release'));
  const distDir = process.env.NEXT_DIST_DIR?.trim() || '.next';
  const mitModulen = !schalter('ohne-module');
  const unsauberErlaubt = schalter('unsauber');
  const oberste = packliste(distDir, mitModulen);

  // --- Ausgabe ausserhalb des Artefakts -----------------------------------
  // Läge das Ausgabeverzeichnis in einem Eintrag (`--ausgabe src/tmp`),
  // packte der nächste Lauf das vorige Archiv mit.
  const ausgabeRelativ = relative(WURZEL, ausgabe).split(sep).join('/');
  if (oberste.some((o) => ausgabeRelativ === o || ausgabeRelativ.startsWith(`${o}/`))) {
    throw new Error(`Das Ausgabeverzeichnis ${ausgabeRelativ} liegt im Inhalt des Artefakts — ein anderes wählen (z. B. release/).`);
  }

  // --- Commit, Herkunft, Sauberkeit ---------------------------------------
  const commit = commitBestimmen(process.env.GITHUB_SHA, git('rev-parse', 'HEAD'));
  const zeit = quelleZeit(git('show', '-s', '--format=%cI', commit));
  const ci = ciHerkunftAusUmgebung(process.env);
  const dreckig = unsauberePfade(gitRoh('status', '--porcelain=v1', '-z', '--untracked-files=all'), oberste);
  const unsauber = dreckig.length > 0;
  if (unsauber && !unsauberErlaubt) {
    throw new Error(
      `Der Arbeitsbaum ist nicht sauber (${dreckig.length} Pfad(e)) — ein Artefakt muss einem Commit entsprechen (--unsauber nur für Proben):\n${auszug(dreckig)}`,
    );
  }

  // --- Bau vollständig und ohne Demodaten? --------------------------------
  const buildId = bauPruefen(WURZEL, distDir);

  // --- Korrekturen in node_modules ----------------------------------------
  for (const [skript, name] of [
    ['react-hydrationskorrektur.mjs', 'React-Hydrationskorrektur (RB-001)'],
    ['next-cachezeit-korrektur.mjs', 'Next-Cachezeit-Korrektur (RB-002)'],
  ] as const) {
    const r = spawnSync(process.execPath, [join(WURZEL, 'scripts', skript), '--pruefen'], { cwd: WURZEL, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`${name} nicht angewendet:\n${r.stdout}${r.stderr}`);
  }

  // --- Inhalt: gesammelt, nichts von Git Ignoriertes -----------------------
  // Erst nach dem Bau: `public/pdfjs/` entsteht beim Bau und ist erlaubt
  // ignoriert; vorher fehlte es, und das Artefakt wäre unvollständig.
  const aufnahme = eintraegeSammeln(WURZEL, oberste, distDir);
  const ignoriert = ignoriertImArchiv(gitRoh(...ignoriertAbfrage()), aufnahme.eintraege);
  if (ignoriert.length > 0) {
    throw new Error(
      [
        `Von Git ignorierte Dateien lägen im Artefakt (${ignoriert.length}) — sie stehen in keinem Commit, und .gitignore führt darunter Geheimnisklassen (*.pem, .env*):`,
        auszug(ignoriert),
        'Entfernen. Ist eine Datei beim Bau erzeugt und zur Laufzeit nötig, gehört ihr Ort mit Grund in IGNORIERT_ERLAUBT (scripts/release/artefakt-regeln.ts).',
      ].join('\n'),
    );
  }

  // --- Manifest ------------------------------------------------------------
  const paket = JSON.parse(readFileSync(join(WURZEL, 'package.json'), 'utf8')) as { version: string };
  const nextVersion = (JSON.parse(readFileSync(join(WURZEL, 'node_modules', 'next', 'package.json'), 'utf8')) as { version: string }).version;
  const npm = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['-v'], { encoding: 'utf8', shell: process.platform === 'win32' });
  if (npm.status !== 0 || !npm.stdout.trim()) throw new Error('npm -v liefert keine Fassung.');
  const manifest = manifestBauen({
    version: paket.version,
    commit,
    unsauber,
    buildId,
    distDir,
    quelleZeitUtc: zeit.utc,
    node: process.version,
    npm: npm.stdout.trim(),
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
    seitenUrl: process.env.NEXT_PUBLIC_SITE_URL?.trim() || process.env.NEXT_PUBLIC_APP_URL?.trim() || null,
    mitModulen,
    migrationen: migrationenAuflisten(join(WURZEL, 'prisma', 'migrations')),
    ci,
  });

  // --- Packen --------------------------------------------------------------
  mkdirSync(ausgabe, { recursive: true });
  const name = artefaktName(commit, mitModulen);
  const archiv = join(ausgabe, `${name}.tar.gz`);
  const gepackt = await archivPacken({ wurzel: WURZEL, archiv, eintraege: aufnahme.eintraege, manifest, quelleEpoche: zeit.epoche });

  const summe = await sha256Datei(archiv);
  const beilage = beilageBauen(manifest, {
    archivSha256: summe,
    archivGroesseBytes: statSync(archiv).size,
    erstelltUtc: new Date().toISOString(),
    archivNormalisiert: gepackt.normalisiert,
  });
  writeFileSync(join(ausgabe, `${name}.tar.gz.sha256`), `${summe}  ${name}.tar.gz\n`);
  writeFileSync(join(ausgabe, `${name}.json`), `${JSON.stringify(beilage, null, 2)}\n`);

  const ausgelassen = new Map<Ausschlussgrund, number>();
  for (const a of aufnahme.ausgeschlossen) ausgelassen.set(a.grund, (ausgelassen.get(a.grund) ?? 0) + 1);

  console.log(`Artefakt      : ${archiv}`);
  console.log(`Grösse        : ${Math.round(beilage.archivGroesseBytes / 1024 / 1024)} MB, ${gepackt.gelistet.length} Einträge (vollständig)`);
  for (const [grund, anzahl] of ausgelassen) {
    console.log(`Ausgelassen   : ${anzahl} × ${AUSSCHLUSSGRUND_TEXT[grund]}`);
  }
  console.log(`SHA-256       : ${summe}`);
  console.log(`Version       : ${manifest.version}`);
  console.log(`Commit        : ${commit}${unsauber ? ' (UNSAUBER)' : ''}`);
  console.log(`Build-ID      : ${buildId}`);
  console.log(`Migrationen   : ${manifest.migrationen.length}`);
  console.log(`CI-Lauf       : ${ci ? `${ci.lauf}/${ci.versuch} (${ci.ereignis}, ${ci.ref})` : 'keiner (örtlich)'}`);
  console.log(`Normalisiert  : ${gepackt.normalisiert ? 'ja (GNU tar, gzip -n)' : `nein (${gepackt.art === 'bsd' ? 'bsdtar' : gepackt.art})`}`);
  console.log(`Auslieferbar  : ${manifest.auslieferbar ? 'ja' : 'nein (Probe)'}`);
}

if (require.main === module) {
  main().catch((fehler) => {
    console.error(`FEHLER: ${fehler instanceof Error ? fehler.message : String(fehler)}`);
    process.exit(1);
  });
}
