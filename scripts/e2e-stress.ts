/**
 * Die Browserreihe mehrfach hintereinander fahren — jeder Lauf gegen einen
 * frisch gestarteten Testserver.
 *
 *   npm run e2e:stress                 # 5 Läufe
 *   npm run e2e:stress -- --laeufe 8
 *   npm run e2e:stress -- --laeufe 3 --datei tests/e2e/gate4d-sperre.spec.ts
 *   npm run e2e:stress -- --bericht <datei.json>   # Bericht an festen Ort (verify:release)
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
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { laufspurenSichern } from './security/befundsicherung';
import { browserBerichtLesen, engineBilanzPruefen, engineZeilen, type Stressbericht, type Stresslauf } from './security/pruefweg-abschluss';

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
/**
 * Wohin der Bericht der Reihe geht. Vorgabe wie bisher `test-results/stress-<Zeit>.json`;
 * `verify:release` gibt einen festen Pfad vor, weil es den Bericht danach in
 * den Release-Nachweis übernimmt und nicht nach dem neuesten Zeitstempel
 * raten soll.
 */
const berichtPfad = wert('--bericht');
const port = process.env.E2E_PORT?.trim() || '3001';
/**
 * Der JSON-Bericht von Playwright je Lauf (2026-09-30). In `test-results/`,
 * weil ein roter Lauf dieses Verzeichnis ohnehin wegsichert
 * (`laufspurenSichern`) — die Zahlen reisen dann mit der Spur. Playwright
 * leert das Verzeichnis zu Beginn des nächsten Laufs; bis dahin ist er
 * gelesen.
 */
const playwrightBericht = join(process.cwd(), 'test-results', 'playwright-bericht.json');
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

/*
  Dasselbe Bauverzeichnis wie `next.config.ts` und `test-server.ts`
  (`NEXT_DIST_DIR`, sonst `.next`). Bis 2026-09-30 stand hier fest `.next`:
  Mit gesetztem `NEXT_DIST_DIR` — dem üblichen Weg, neben einem laufenden
  Entwicklungsserver zu bauen — verweigerte die Reihe einen vorhandenen Bau
  oder, schlimmer, liess sich von einem alten `.next` beruhigen, während der
  Testserver aus dem anderen Verzeichnis startete.
*/
const bauverzeichnis = process.env.NEXT_DIST_DIR?.trim() || '.next';
if (!existsSync(join(process.cwd(), bauverzeichnis, 'BUILD_ID'))) {
  console.error(`❌  Kein Produktionsbau in ${bauverzeichnis} — zuerst \`npm run build\` (bei gestopptem Entwicklungsserver).`);
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
    // Wiederholungswert einträgt. `list,json`: die gewohnte Liste für den
    // Menschen, der JSON-Bericht für die Zählung.
    ['playwright', 'test', '--retries=0', '--reporter=list,json', ...(datei ? [datei] : [])],
    {
      encoding: 'utf8',
      shell: ueberShell,
      maxBuffer: 64 * 1024 * 1024,
      // Playwright soll den Server **nicht** selbst starten: Dieses Skript
      // besitzt ihn und will ihn zwischen den Läufen kontrolliert wechseln.
      env: { ...process.env, E2E_PORT: port, PLAYWRIGHT_HTML_OPEN: 'never', PLAYWRIGHT_JSON_OUTPUT_NAME: playwrightBericht },
    },
  );
  const ausgabe = `${ergebnis.stdout ?? ''}${ergebnis.stderr ?? ''}`;
  process.stdout.write(ausgabe);
  return { ausgabe, exitcode: ergebnis.status ?? 1 };
}

/*
  Gezählt wird aus dem JSON-Bericht, nicht mehr aus der Listenausgabe
  (2026-09-30). Hier stand `ausgabe.match(/(\d+)\s+passed/)` — der **erste**
  Treffer im ganzen Protokoll. Jede Zeile davor, die zufällig „3 passed“ oder
  „2 skipped“ enthielt (eine Fehlermeldung, ein Konsolenausdruck der
  Anwendung, ein Testtitel), wurde zur Bilanz des Laufs; und ein
  übersprungener Fall, dessen Zeile Playwright anders formulierte, zählte als
  null. Die Regel „0 übersprungen, 0 wackelig, mindestens ein bestandener
  Fall“ war damit so gut wie die Formulierung der Ausgabe. Jetzt gilt
  dieselbe Regel wie in `verify.ts` (`browserBilanzPruefen` aus
  `testbilanz.ts`, über `engineBilanzPruefen` für die Summe und je Engine),
  auf denselben Zahlen, die Playwright selbst zählt.
*/

// ---------------------------------------------------------------------------
//  Hauptlauf
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  mkdirSync(artefakte, { recursive: true });
  const ergebnisse: Stresslauf[] = [];

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
    // Der Bericht des vorigen Laufs muss weg, bevor dieser beginnt: Startet
    // der Server nicht, oder scheitert Playwright, bevor es `test-results/`
    // selbst leert (kaputte Konfiguration, fehlender Browser), läse die
    // Zählung sonst die Zahlen des vorigen, grünen Laufs — ein roter Lauf mit
    // grünen Zahlen im Bericht.
    rmSync(playwrightBericht, { force: true });

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

    // Rot ist auch ein Lauf mit Exitcode 0, in dem Fälle übersprungen wurden,
    // wackelten oder Hydrationsartefakte entstanden (2026-09-29, M4):
    // Playwright endet dann mit 0, und „5/5 grün" wäre eine Aussage über
    // Fälle, die nie liefen. Ein Lauf ohne einen einzigen bestandenen Fall
    // beweist ebenfalls nichts, ein Lauf ohne Bericht auch nicht — und seit
    // 2026-09-30 über die ganze Reihe auch keine Engine ohne bestandenen Fall.
    const bilanz = browserBerichtLesen(playwrightBericht);
    const gruende = engineBilanzPruefen(bilanz, { jedeEngine: !datei });
    if (exitcode !== 0) gruende.unshift(`Playwright endete mit Exitcode ${exitcode}.`);
    const hydrationsartefakte = artefaktzahl() - vorher;
    if (hydrationsartefakte > 0) gruende.push(`${hydrationsartefakte} Hydrationsartefakt(e).`);
    const g = bilanz?.gesamt;

    /**
     * Die vollständige Ausgabe eines **roten** Laufs wird weggeschrieben.
     *
     * Ohne das ist sie nur im Terminal, und wer die Reihe im Hintergrund
     * fahren lässt (das ist der Normalfall bei zehn Läufen), hat am Ende die
     * Zusammenfassung und nicht den Fehlschlag. Genau so ist in Wave 9.1 der
     * erste eingefangene Restbefund verlorengegangen.
     *
     * Seit 2026-09-30 für **jeden** roten Lauf, nicht nur für einen mit
     * Exitcode ungleich 0: Ein Lauf mit übersprungenem Fall ist ebenso rot,
     * und gerade bei ihm will man später sehen, welcher es war. Mit der Spur
     * wandert der JSON-Bericht des Laufs mit (er liegt in `test-results/`).
     */
    if (gruende.length > 0) {
      mkdirSync(artefakte, { recursive: true });
      const marke = `stress-lauf-${nummer}-${Date.now()}`;
      const protokoll = join(artefakte, `${marke}.log`);
      writeFileSync(protokoll, `${ausgabe}\n\n── Gründe (e2e-stress) ──\n${gruende.join('\n')}\n`, 'utf8');
      console.log(`\n  Lauf ${nummer} rot: ${gruende.join(' ')}`);
      console.log(`  Vollständige Ausgabe des roten Laufs: ${protokoll}`);
      // Die Ausgabe allein reichte nicht (RC-20): Sie nennt die Spur nur mit
      // ihrem Pfad in `test-results/`, und den leert der nächste Lauf.
      const spuren = laufspurenSichern(join(process.cwd(), 'test-results'), join(artefakte, marke));
      if (spuren) console.log(`  Spuren, Bildschirmfotos und Fehlerkontext des roten Laufs: ${spuren}`);
    }

    ergebnisse.push({
      nummer,
      bestanden: g?.expected ?? 0,
      fehlgeschlagen: g?.unexpected ?? 0,
      uebersprungen: g?.skipped ?? 0,
      wackelig: g?.flaky ?? 0,
      dauerSekunden: Math.round((Date.now() - start) / 1000),
      hydrationsartefakte,
      exitcode,
      jeEngine: bilanz?.jeEngine ?? {},
      gruende,
    });
  }

  console.log('\n══════════ Ergebnis der Stressreihe ══════════\n');
  console.log('  Lauf  bestanden  fehlgeschlagen  übersprungen  wackelig  Hydration  Dauer');
  for (const e of ergebnisse) {
    console.log(
      `  ${String(e.nummer).padStart(4)}  ${String(e.bestanden).padStart(9)}  ${String(e.fehlgeschlagen).padStart(14)}  ${String(e.uebersprungen).padStart(12)}  ${String(e.wackelig).padStart(8)}  ${String(e.hydrationsartefakte).padStart(9)}  ${e.dauerSekunden}s`,
    );
    const engines = Object.keys(e.jeEngine);
    if (engines.length > 0) {
      for (const zeile of engineZeilen({ gesamt: {}, jeEngine: e.jeEngine, engines })) console.log(`        ${zeile}`);
    }
  }

  const bericht = berichtPfad ? resolve(berichtPfad) : join(process.cwd(), 'test-results', `stress-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const inhalt: Stressbericht = { port, datei, laeufe, ergebnisse };
  mkdirSync(dirname(bericht), { recursive: true });
  writeFileSync(bericht, JSON.stringify(inhalt, null, 2), 'utf8');
  console.log(`\n  Bericht: ${bericht}`);

  const rot = ergebnisse.filter((e) => e.gruende.length > 0);
  if (rot.length > 0) {
    console.log(`\n❌  ${rot.length} von ${laeufe} Läufen rot (Läufe ${rot.map((e) => e.nummer).join(', ')}).`);
    process.exit(1);
  }
  console.log(`\n✓  ${laeufe} von ${laeufe} Läufen grün, keine Hydrationsartefakte${datei ? '' : ', jede Engine mit bestandenen Fällen'}.`);
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
