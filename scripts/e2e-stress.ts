/**
 * Die Browserreihe mehrfach hintereinander fahren — jeder Lauf gegen einen
 * frisch gestarteten Testserver.
 *
 *   npm run e2e:stress                 # 5 Läufe
 *   npm run e2e:stress -- --laeufe 8
 *   npm run e2e:stress -- --laeufe 3 --datei tests/e2e/gate4d-sperre.spec.ts
 *
 * ---------------------------------------------------------------------------
 *  Wozu
 * ---------------------------------------------------------------------------
 *
 * Ein einzelner grüner Lauf sagt über einen Fehler, der sich alle paar Läufe
 * zeigt, nichts aus. Genau daran ist der Hydrationsbefund über mehrere Waves
 * hinweg hängengeblieben: „dreimal 19/20, danach dreimal 20/20" — beide
 * Beobachtungen stimmten, und keine war eine Aussage.
 *
 * Dieses Skript macht aus der Beobachtung eine Messung: n vollständige Läufe,
 * `retries: 0`, jeder gegen einen **neu gestarteten** Server, und am Ende eine
 * Tabelle mit den tatsächlichen Ergebnissen.
 *
 * ---------------------------------------------------------------------------
 *  Was „frischer Zustand" hier heisst
 * ---------------------------------------------------------------------------
 *
 * Vor jedem Lauf wird der Testserver beendet und neu gestartet. Das ist nicht
 * Symbolik:
 *
 *  • **Rate-Limit-Zähler.** Sie liegen als Dateien in
 *    `CLENARIS_TEST_CACHE_DIR` und werden vom Serverstart geleert. Zwei volle
 *    Reihen gegen denselben Prozess laufen in erschöpfte Kontingente — genau
 *    der Fehlbefund, der in Wave 1 als „Hydrationsfehler" gemeldet wurde und
 *    keiner war.
 *  • **Prozesszustand.** Kennzahlenregistrierung, Verbindungspool und der
 *    anwendungsinterne Zwischenspeicher sind nach einer Reihe nicht mehr das,
 *    was sie am Anfang waren. Ein Fehler, der erst im zweiten Lauf auftritt,
 *    soll als solcher erkennbar sein und nicht dem dritten Lauf zugeschrieben
 *    werden.
 *  • **Postausgang.** Der simulierte Mailausgang liegt im selben Verzeichnis.
 *
 * Der **Datenbestand** wird bewusst *nicht* neu eingespielt: Jeder Fall räumt
 * vor und nach sich auf (`tests/README.md`), und ein Neuaufbau zwischen den
 * Läufen würde genau die Frage verdecken, ob die Reihe das auch tut.
 *
 * Beendet wird ausschliesslich der **selbst gestartete** Prozessbaum. Ein
 * Entwicklungsserver auf einem anderen Port bleibt unberührt.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { laufspurenSichern } from './security/befundsicherung';

interface Laufergebnis {
  nummer: number;
  bestanden: number;
  fehlgeschlagen: number;
  uebersprungen: number;
  wackelig: number;
  dauerSekunden: number;
  hydrationsartefakte: number;
  exitcode: number;
}

const argv = process.argv.slice(2);

function wert(schalter: string): string | null {
  const index = argv.indexOf(schalter);
  // `indexOf` liefert −1, wenn der Schalter fehlt, und `argv[-1 + 1]` wäre
  // `argv[0]` — derselbe Fehler, der in Wave 4 ein Rotationsskript
  // stillschweigend nichts tun liess.
  if (index < 0) return null;
  return argv[index + 1] ?? null;
}

const laeufe = Number.parseInt(wert('--laeufe') ?? '5', 10);
const datei = wert('--datei');
const port = process.env.E2E_PORT?.trim() || '3001';
/**
 * Ausserhalb von `test-results/`, weil Playwright sein Ausgabeverzeichnis zu
 * Beginn jedes Laufs leert — sonst zählt dieses Skript im fünften Lauf die
 * Artefakte des vierten nicht mehr und meldet sogar negative Differenzen.
 */
const artefakte = join(process.cwd(), 'hydrationsbefunde');

if (!Number.isInteger(laeufe) || laeufe < 1) {
  console.error('❌  --laeufe braucht eine positive ganze Zahl.');
  process.exit(1);
}

if (!existsSync(join(process.cwd(), '.next', 'BUILD_ID'))) {
  console.error('❌  Kein Produktionsbau in .next — zuerst `npm run build` (bei gestopptem Entwicklungsserver).');
  process.exit(1);
}

// ---------------------------------------------------------------------------
//  Server
// ---------------------------------------------------------------------------

const warte = (ms: number) => new Promise<void>((auf) => setTimeout(auf, ms));

async function erreichbar(): Promise<boolean> {
  try {
    const antwort = await fetch(`http://127.0.0.1:${port}/api/auth/session`, {
      signal: AbortSignal.timeout(3_000),
    });
    return antwort.status > 0;
  } catch {
    return false;
  }
}

function baumBeenden(kind: ChildProcess | null): void {
  if (!kind?.pid) return;
  if (process.platform === 'win32') {
    // `kind.kill()` beendet unter Windows nur die `tsx`-Hülle; der darunter
    // liegende `next start` bliebe am Port hängen und der nächste Lauf liefe
    // gegen den *alten* Prozess — also gegen nicht geleerte Zähler.
    spawnSync('taskkill', ['/PID', String(kind.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-kind.pid, 'SIGTERM');
    } catch {
      kind.kill('SIGTERM');
    }
  }
}

/**
 * Ein Batch-Skript (`npm.cmd`, `npx.cmd`) lässt sich unter Windows seit Node 20
 * nur noch **über die Shell** starten — `spawn('npm.cmd', …)` scheitert mit
 * `EINVAL`. Das ist die Absicherung gegen CVE-2024-27980 und keine Panne;
 * `shell: true` ist der vorgesehene Weg, und die Argumente hier sind fest
 * verdrahtet, nicht aus einer Eingabe zusammengesetzt.
 */
const ueberShell = process.platform === 'win32';

async function serverStarten(): Promise<ChildProcess> {
  const kind = spawn('npm', ['run', 'test:server'], {
    stdio: 'ignore',
    shell: ueberShell,
    env: { ...process.env, PORT: port },
    detached: process.platform !== 'win32',
  });

  const frist = Date.now() + 120_000;
  while (Date.now() < frist) {
    if (await erreichbar()) return kind;
    if (kind.exitCode !== null) throw new Error(`Der Testserver hat sich mit Code ${kind.exitCode} beendet.`);
    await warte(1_000);
  }
  baumBeenden(kind);
  throw new Error(`Der Testserver war nach 120 s auf Port ${port} nicht erreichbar.`);
}

async function serverBeenden(kind: ChildProcess | null): Promise<void> {
  baumBeenden(kind);
  const frist = Date.now() + 30_000;
  while (Date.now() < frist) {
    if (!(await erreichbar())) return;
    await warte(500);
  }
  console.warn(`⚠  Port ${port} antwortet noch — ein fremder Prozess hält ihn.`);
}

// ---------------------------------------------------------------------------
//  Ein Lauf
// ---------------------------------------------------------------------------

function artefaktzahl(): number {
  if (!existsSync(artefakte)) return 0;
  return readdirSync(artefakte).filter((name) => name.endsWith('.json')).length;
}

function playwrightFahren(): { ausgabe: string; exitcode: number } {
  const ergebnis = spawnSync(
    'npx',
    // `--retries=0` ausdrücklich, nicht nur aus der Konfiguration: Eine Reihe,
    // die als Tor zählt, soll nicht davon abhängen, dass niemand dort einen
    // Wiederholungswert einträgt.
    ['playwright', 'test', '--retries=0', ...(datei ? [datei] : [])],
    {
      encoding: 'utf8',
      shell: ueberShell,
      maxBuffer: 64 * 1024 * 1024,
      // Playwright soll den Server **nicht** selbst starten: Dieses Skript
      // besitzt ihn und will ihn zwischen den Läufen kontrolliert wechseln.
      env: { ...process.env, E2E_PORT: port, PLAYWRIGHT_HTML_OPEN: 'never' },
    },
  );
  const ausgabe = `${ergebnis.stdout ?? ''}${ergebnis.stderr ?? ''}`;
  process.stdout.write(ausgabe);
  return { ausgabe, exitcode: ergebnis.status ?? 1 };
}

/** Playwrights Listenausgabe endet mit Zeilen wie „19 passed (1.2m)". */
function zaehlen(ausgabe: string, wort: string): number {
  const treffer = ausgabe.match(new RegExp(`(\\d+)\\s+${wort}`));
  return treffer ? Number.parseInt(treffer[1]!, 10) : 0;
}

// ---------------------------------------------------------------------------
//  Hauptlauf
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  mkdirSync(artefakte, { recursive: true });
  const ergebnisse: Laufergebnis[] = [];

  console.log('');
  console.log(`  Stressreihe: ${laeufe} vollständige Browserläufe, je gegen einen neu gestarteten Testserver.`);
  console.log(`  Port ${port} · retries 0 · ${datei ?? 'alle Dateien'}`);
  console.log('');

  for (let nummer = 1; nummer <= laeufe; nummer++) {
    console.log(`\n══════════ Lauf ${nummer} von ${laeufe} ══════════\n`);

    // Ein bereits laufender Server gehört diesem Skript nicht — trotzdem muss
    // er weg, sonst läuft der erste Lauf gegen fremde Zähler.
    if (await erreichbar()) {
      console.log('  Ein Server antwortet bereits auf diesem Port. Er wird beendet, damit der Lauf definiert beginnt.');
      await portFreiraeumen();
    }

    let kind: ChildProcess | null = null;
    const vorher = artefaktzahl();
    const start = Date.now();
    let exitcode = 1;
    let ausgabe = '';

    try {
      kind = await serverStarten();
      const lauf = playwrightFahren();
      ausgabe = lauf.ausgabe;
      exitcode = lauf.exitcode;
    } catch (fehler) {
      console.error(`❌  Lauf ${nummer} konnte nicht starten: ${(fehler as Error).message}`);
    } finally {
      await serverBeenden(kind);
    }

    /**
     * Die vollständige Ausgabe eines **roten** Laufs wird weggeschrieben.
     *
     * Ohne das ist sie nur im Terminal, und wer die Reihe im Hintergrund
     * fahren lässt (das ist der Normalfall bei zehn Läufen), hat am Ende die
     * Zusammenfassung und nicht den Fehlschlag. Genau so ist in Wave 9.1 der
     * erste eingefangene Restbefund verlorengegangen.
     */
    if (exitcode !== 0) {
      mkdirSync(artefakte, { recursive: true });
      const marke = `stress-lauf-${nummer}-${Date.now()}`;
      const protokoll = join(artefakte, `${marke}.log`);
      writeFileSync(protokoll, ausgabe, 'utf8');
      console.log(`\n  Vollständige Ausgabe des roten Laufs: ${protokoll}`);
      // Die Ausgabe allein reichte nicht (RC-20): Sie nennt die Spur nur mit
      // ihrem Pfad in `test-results/`, und den leert der nächste Lauf.
      const spuren = laufspurenSichern(join(process.cwd(), 'test-results'), join(artefakte, marke));
      if (spuren) console.log(`  Spuren, Bildschirmfotos und Fehlerkontext des roten Laufs: ${spuren}`);
    }

    ergebnisse.push({
      nummer,
      bestanden: zaehlen(ausgabe, 'passed'),
      fehlgeschlagen: zaehlen(ausgabe, 'failed'),
      uebersprungen: zaehlen(ausgabe, 'skipped'),
      wackelig: zaehlen(ausgabe, 'flaky'),
      dauerSekunden: Math.round((Date.now() - start) / 1000),
      hydrationsartefakte: artefaktzahl() - vorher,
      exitcode,
    });
  }

  console.log('\n══════════ Ergebnis der Stressreihe ══════════\n');
  console.log('  Lauf  bestanden  fehlgeschlagen  übersprungen  Hydration  Dauer');
  for (const e of ergebnisse) {
    console.log(
      `  ${String(e.nummer).padStart(4)}  ${String(e.bestanden).padStart(9)}  ${String(e.fehlgeschlagen).padStart(14)}  ${String(e.uebersprungen).padStart(12)}  ${String(e.hydrationsartefakte).padStart(9)}  ${e.dauerSekunden}s`,
    );
  }

  const bericht = join(process.cwd(), 'test-results', `stress-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(bericht, JSON.stringify({ port, datei, laeufe, ergebnisse }, null, 2), 'utf8');
  console.log(`\n  Bericht: ${bericht}`);

  // Rot ist auch ein Lauf mit Exitcode 0, in dem Fälle übersprungen wurden,
  // wackelten oder Hydrationsartefakte entstanden (2026-09-29, M4): Playwright
  // endet dann mit 0, und „5/5 grün" wäre eine Aussage über Fälle, die nie
  // liefen. Ein Lauf ohne einen einzigen bestandenen Fall beweist ebenfalls
  // nichts.
  const rot = ergebnisse.filter(
    (e) => e.exitcode !== 0 || e.uebersprungen > 0 || e.hydrationsartefakte > 0 || e.bestanden === 0 || e.wackelig > 0,
  );
  if (rot.length > 0) {
    console.log(`\n❌  ${rot.length} von ${laeufe} Läufen rot (Läufe ${rot.map((e) => e.nummer).join(', ')}).`);
    process.exit(1);
  }
  console.log(`\n✓  ${laeufe} von ${laeufe} Läufen grün, keine Hydrationsartefakte.`);
}

/**
 * Einen fremden Prozess auf dem Testport beenden.
 *
 * Nur für den Testport und nur in diesem Skript: Ein hängengebliebener
 * `next start` aus einem abgebrochenen Lauf ist der häufigste Grund dafür,
 * dass eine Stressreihe gegen nicht geleerte Zähler läuft — und das sieht
 * anschliessend wie ein Produktfehler aus.
 */
async function portFreiraeumen(): Promise<void> {
  if (process.platform === 'win32') {
    const gefunden = spawnSync('powershell', [
      '-NoProfile',
      '-Command',
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`,
    ], { encoding: 'utf8' });
    for (const zeile of (gefunden.stdout ?? '').split(/\r?\n/)) {
      const pid = zeile.trim();
      if (/^\d+$/.test(pid)) spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore' });
    }
  } else {
    spawnSync('bash', ['-lc', `lsof -ti tcp:${port} | xargs -r kill -9`], { stdio: 'ignore' });
  }
  const frist = Date.now() + 20_000;
  while (Date.now() < frist) {
    if (!(await erreichbar())) return;
    await warte(500);
  }
}

void main();
