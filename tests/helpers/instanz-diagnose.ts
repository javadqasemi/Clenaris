import { execFile, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { Socket } from 'node:net';
import { cpus, freemem, loadavg, totalmem, uptime } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import pg from 'pg';

import { redigieren } from '../e2e/helpers/diagnose';

/**
 * Beweissicherung für Prüfinstanzen, die eine Testdatei selbst startet
 * (W-11, 2026-10-01).
 *
 * ---------------------------------------------------------------------------
 *  Der Befund, für den das gebaut ist
 * ---------------------------------------------------------------------------
 *
 * `tests/api/laufzeit-konfiguration.test.ts` startet aus **einem** Bau zwei
 * `next start` (A und B) und fragt beide ab. In vollen Läufen hing dabei
 * zweimal die **erste** Anfrage an A — die erste, nachdem A untätig gewartet
 * hatte, während B hochfuhr — volle 30 Sekunden, bis die Zeitgrenze des
 * Prüfklienten griff. Einzeln lief die Datei grün; am 2026-09-28 lief sie in
 * vier vollen Läufen grün. Ohne Wiederauftreten kein Beleg, und deshalb ist
 * W-11 nicht geschlossen.
 *
 * Die beiden Diagnosen vom 2026-09-27 (bis hierher in der Testdatei) sagten
 * nur zweierlei: A hatte beim Start mit 200 geantwortet, und eine Nachfrage
 * an `/api/health` **nach** den 30 Sekunden kam sofort zurück. Was sie nicht
 * sagen konnten, ist genau das, worauf es ankommt:
 *
 *  • **Wo** die Anfrage stand. Kam die Verbindung gar nicht zustande (Port,
 *    Netz, falscher Empfänger), oder stand sie, und die Antwort blieb aus
 *    (Prozess blockiert, Handler wartet)? Der Kern nimmt eine Verbindung an,
 *    auch wenn die Ereignisschleife des Prozesses gerade steht — „verbunden,
 *    aber keine Kopfzeilen" und „nicht verbunden" sind zwei verschiedene
 *    Befunde mit verschiedenen Ursachen.
 *  • **Ob A während** des Hängens überhaupt antwortete. Eine Nachfrage nach
 *    30 Sekunden zeigt nur, dass es danach wieder ging.
 *  • **In welcher Lage** die Maschine war: freier Speicher, Speicher und
 *    Rechenzeit der Instanzen, Verbindungen zur Datenbank. Der Befund trat
 *    nur in vollen Läufen auf, also unter Last — auf einer Maschine mit
 *    wenig freiem Arbeitsspeicher.
 *
 * ---------------------------------------------------------------------------
 *  Was hier gemessen wird
 * ---------------------------------------------------------------------------
 *
 *  1. **Zeitleiste:** Start jeder Instanz, Port, Bereitschaft, jede Anfrage
 *     mit ihren Phasen (verbunden, gesendet, Kopfzeilen, Ende) und mit der
 *     Zeit, die die Instanz davor untätig war.
 *  2. **Serverausgabe mit Zeitstempel**, Zeile für Zeile — vorher stand nur
 *     ein zusammengeklebtes Textende ohne Zeitbezug im Fehler.
 *  3. **Wächter:** Hat eine Anfrage nach fünf Sekunden noch keine
 *     Kopfzeilen, gehen zwei Proben über **neue** Verbindungen an dieselbe
 *     Instanz — eine ohne Datenbank (`/api/public/runtime-config`), eine mit
 *     (`/api/health`) — und die Lage wird erhoben, **während** es hängt.
 *     Antworten die Proben sofort, betrifft das Hängen diese eine Anfrage;
 *     hängen sie mit, steht der Prozess; hängt nur die Probe mit Datenbank,
 *     liegt es dort.
 *  4. **Abzug** nach `test-results/w11-<Zeitpunkt>.json`, sobald eine
 *     Anfrage scheitert oder eine Instanz nicht hochkommt: Lage während und
 *     nach dem Hängen (`pg_stat_activity` gruppiert nach Datenbank, Zustand,
 *     `application_name` und Warteart, `max_connections`, `os.freemem()`,
 *     Speicher und Rechenzeit des Prüfprozesses und der Instanzen), die
 *     Zeitleiste und das Ende der Serverausgabe. Eine Anfrage, die den
 *     Wächter auslöste und **trotzdem** ankam, hinterlässt
 *     `w11-langsam-<Zeitpunkt>.json`: dasselbe Phänomen unterhalb der
 *     Zeitgrenze, und bei einem Fehler, der sich selten zeigt, ist der
 *     Beinahe-Fall die häufigere Spur.
 *
 * `test-results/` und nicht `hydrationsbefunde/`: Der Prüfweg sichert
 * `test-results/` eines roten Laufs, bevor er aufräumt (RC-20,
 * `scripts/security/befundsicherung.ts`), und `e2e-stress.ts` zählt jede
 * `.json` in `hydrationsbefunde/` als Hydrationsbefund — ein W-11-Abzug dort
 * färbte eine fremde Bilanz. Eine rote HTTP-Reihe bricht den Prüfweg ab,
 * bevor Playwright `test-results/` leeren könnte.
 *
 * ---------------------------------------------------------------------------
 *  Was hier ausdrücklich **nicht** geschieht
 * ---------------------------------------------------------------------------
 *
 * Keine Wiederholung, keine längere Zeitgrenze, kein Filter. Die Anfrage
 * scheitert nach denselben 30 Sekunden wie vorher, und der Fall scheitert
 * mit ihr. Die Proben ändern das Ergebnis nicht — sie laufen neben der
 * hängenden Anfrage, nicht an ihrer Stelle. Ein Prüfwerkzeug, das einen
 * seltenen Fehler „verschwinden" lässt, hätte ihn nur unsichtbar gemacht.
 *
 * ---------------------------------------------------------------------------
 *  Warum die Datenbank im Abzug steht
 * ---------------------------------------------------------------------------
 *
 * `/api/public/runtime-config` berührt die Datenbank nicht: Ohne Cookie
 * liefert `getSession()` sofort `null`, das Rate-Limit zählt im Prüfbetrieb
 * synchron in Dateien (`FileDriver` in `src/lib/redis.ts`), der Handler liest
 * nur die Umgebung. Die Datenbank kann das erste Hängen also nicht
 * unmittelbar erklären — zumal es am 2026-09-27 beobachtet wurde, zwei Tage
 * vor dem Umstieg auf Prisma 7. Sie steht trotzdem im Abzug, weil die
 * übrigen Fälle dieser Gruppe (Newsletter, Abmeldung) sie brauchen und weil
 * der Pool seit Prisma 7 anders wartet: `PrismaPg` baut einen `pg.Pool` ohne
 * `connectionTimeoutMillis` (`src/lib/prisma-client.ts`) — eine Anfrage, die
 * keine Verbindung bekommt, wartet dort unbegrenzt, wo Prisma 6 nach zehn
 * Sekunden abbrach. Die Instanzen tragen dafür einen eigenen
 * `application_name` (`PGAPPNAME`), damit ihre Verbindungen im Abzug
 * auseinanderzuhalten sind.
 */

/** Ablage der Abzüge — dasselbe Verzeichnis wie Playwrights Ausgabe, siehe oben. */
const ABLAGE = join(__dirname, '..', '..', 'test-results');

/**
 * Die Zeitgrenze einer Anfrage — **unverändert** gegenüber vorher. Sie ist
 * die Messlatte, an der W-11 beobachtet wurde; wer sie anhebt, macht den
 * Befund unsichtbar, statt ihn zu klären.
 */
const ANFRAGE_FRIST_MS = 30_000;

/**
 * Ab wann eine Anfrage als „hängt" gilt und die Proben losgehen. Gesunde
 * Anfragen dieser Gruppe brauchen Millisekunden bis wenige Sekunden; fünf
 * Sekunden sind weit darüber und lassen bis zur Zeitgrenze genug Zeit, die
 * Lage zu erheben, solange das Hängen noch anhält.
 */
const WAECHTER_MS = 5_000;

/** Proben müssen vor der Zeitgrenze der beobachteten Anfrage zurück sein. */
const PROBE_FRIST_MS = 20_000;
const NACHFRAGE_FRIST_MS = 10_000;
/** Obergrenze für das Einsammeln der Wächterbefunde — der Abzug darf nie selbst hängen. */
const ERHEBUNG_FRIST_MS = 25_000;
const PROZESS_FRIST_MS = 20_000;
const DATENBANK_FRIST_MS = 5_000;
/**
 * Wie lange nach `exit` auf `close` gewartet wird, bevor das Ende eines
 * Prozesses ohne Port gemeldet wird — Begründung in `anmelden`.
 */
const ENDE_GNADE_MS = 2_000;

/** So viele Zeilen Serverausgabe je Instanz bleiben im Speicher. */
const AUSGABE_ZEILEN = 400;
/** Obergrenze der Zeitleiste — eine Gruppe dieser Grösse erzeugt weniger als hundert Einträge. */
const ZEITLEISTE_HOECHSTENS = 2_000;

/** Die zwei Proben des Wächters: ohne und mit Datenbank. */
const PROBEN = ['/api/public/runtime-config', '/api/health'] as const;

// ---------------------------------------------------------------------------
//  Reine Bausteine (in `laufzeit-konfiguration.test.ts` ohne Server geprüft)
// ---------------------------------------------------------------------------

/** Farbsteuerzeichen — über den Zeichencode, damit kein Steuerzeichen im Quelltext steht. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/**
 * Den tatsächlichen Port aus der Startausgabe von `next start` lesen.
 *
 * Nachgesehen in `node_modules/next` 15.5.26: `startServer` ruft
 * `server.listen(port, hostname)`, setzt im `listening`-Ereignis
 * `port = server.address().port` und schreibt danach über `logStartInfo`
 * die Zeile `   - Local:        http://<host>:<port>` (`bootstrap`, also
 * `console.log` mit drei Leerzeichen davor). Mit `-p 0` ist das der Port, den
 * das Betriebssystem der Instanz beim Binden gegeben hat. Die Zeile
 * „- Network:" trägt mit `-H` denselben Port, wird aber bewusst nicht
 * gelesen: Massgebend ist die eine Zeile, die Next für den lokalen Aufruf
 * druckt. Port 0 ist nie eine gültige Antwort und gilt als „nicht gefunden".
 */
export function lokalerPortAus(zeile: string): number | null {
  const treffer = /^\s*-\s*Local:\s+https?:\/\/(?:\[[^\]]*\]|[^\s/:]+):(\d{1,5})(?=[/\s]|$)/.exec(zeile.replace(ANSI, ''));
  if (!treffer) return null;
  const port = Number(treffer[1]);
  return port >= 1 && port <= 65_535 ? port : null;
}

/** Die Zeile, mit der Next jedes Scheitern beim Binden einleitet — ohne den Grund selbst. */
const ALLGEMEINER_STARTFEHLER = /Failed to start server/;

/**
 * Ein Startfehler in der Ausgabe, auf Deutsch benannt — oder `null`.
 *
 * Mit `-p 0` kann der Port nicht mehr belegt sein; die Erkennung bleibt,
 * weil `next start` bei jedem Fehler beim Binden mit „Failed to start server"
 * und Exitcode 1 endet und der Fall dann sagen soll, **was** passiert ist,
 * statt nach 90 Sekunden „kam nicht hoch" zu melden.
 *
 * Next schreibt die allgemeine Zeile **vor** dem eigentlichen Grund; wie
 * `anmelden` deshalb mit ihr umgeht, steht dort (`ALLGEMEINER_STARTFEHLER`).
 */
export function startfehlerAus(zeile: string): string | null {
  const text = zeile.replace(ANSI, '').trim();
  if (/EADDRINUSE/.test(text)) return `Der Port ist belegt (EADDRINUSE) — ein anderer Prozess hält ihn: ${text}`;
  if (/EACCES/.test(text)) return `Der Port darf nicht gebunden werden (EACCES): ${text}`;
  if (ALLGEMEINER_STARTFEHLER.test(text)) return `Next meldet „Failed to start server": ${text}`;
  return null;
}

/**
 * Datenblöcke eines Ausgabestroms zu ganzen Zeilen zusammensetzen.
 *
 * Ein `data`-Ereignis liefert, was gerade im Puffer lag — eine Zeile kann
 * mitten im Wort auf zwei Blöcke fallen. Wer jeden Block für sich nach
 * „Local:" durchsucht, findet den Port nur, wenn der Zufall mitspielt; und
 * gerade unter Last, wo W-11 auftrat, zerfällt die Ausgabe eher in kleine
 * Blöcke.
 */
export function zeilenSammler(beiZeile: (zeile: string) => void): { aufnehmen(block: string): void; abschliessen(): void } {
  let rest = '';
  return {
    aufnehmen(block) {
      rest += block;
      const teile = rest.split(/\r?\n/);
      rest = teile.pop() ?? '';
      for (const zeile of teile) beiZeile(zeile);
    },
    abschliessen() {
      if (rest) beiZeile(rest);
      rest = '';
    },
  };
}

export type Phase = 'verbinden' | 'senden' | 'antwort-abwarten' | 'rumpf-lesen' | 'fertig';

export interface Messung {
  instanz: string;
  methode: string;
  pfad: string;
  port: number;
  /** Beginn als ISO-Zeitpunkt; alle `…Ms` zählen ab hier. */
  beginn: string;
  verbundenMs?: number;
  gesendetMs?: number;
  kopfMs?: number;
  endeMs?: number;
  dauerMs?: number;
  status?: number;
  /** Quellport der Verbindung — gleich `port` hiesse: Verbindung mit sich selbst. */
  lokalerPort?: number;
  fehler?: string;
  phase?: Phase;
}

/**
 * Die Phase, die eine Anfrage zuletzt erreicht hat.
 *
 * Die Lesart für den Abzug: `verbinden` — der Kern hat keine Verbindung
 * hergestellt (niemand hört auf dem Port, Rückstau, falscher Empfänger);
 * `antwort-abwarten` — verbunden und gesendet, aber keine Kopfzeilen (der
 * Prozess liest nicht oder der Handler kommt nicht zurück); `rumpf-lesen` —
 * die Antwort begann und blieb stehen.
 */
export function phaseAus(m: Pick<Messung, 'verbundenMs' | 'gesendetMs' | 'kopfMs' | 'endeMs'>): Phase {
  if (m.endeMs !== undefined) return 'fertig';
  if (m.kopfMs !== undefined) return 'rumpf-lesen';
  if (m.gesendetMs !== undefined) return 'antwort-abwarten';
  if (m.verbundenMs !== undefined) return 'senden';
  return 'verbinden';
}

// ---------------------------------------------------------------------------
//  Anfrage mit Phasenmessung
// ---------------------------------------------------------------------------

export interface AnfrageOptionen {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface Antwort {
  status: number;
  text: string;
}

/**
 * Eine Anfrage über eine **neue** Verbindung (`agent: false`), mit Messung
 * jeder Phase in `m`.
 *
 * Neue Verbindung, weil `fetch` Verbindungen offen hält und wiederverwendet:
 * Während Instanz B startet, vergehen mehr als die fünf Sekunden, nach denen
 * Next eine ruhende Verbindung schliesst — die nächste Anfrage an A lief dann
 * auf eine tote Verbindung und scheiterte mit „fetch failed" (gemessen
 * 2026-09-27). Das war eine Eigenheit des Prüfklienten, kein Befund, und die
 * Wahl bleibt.
 *
 * `timeout` ist die Ruhezeit des Sockets: Kommt so lange nichts, wird die
 * Anfrage mit der Phase, in der sie stand, abgebrochen.
 */
function rohAnfrage(port: number, pfad: string, optionen: AnfrageOptionen, m: Messung, fristMs: number): Promise<Antwort> {
  const beginn = Date.now();
  const seit = () => Date.now() - beginn;
  return new Promise((ok, fehler) => {
    const scheitern = (grund: Error) => {
      m.fehler = grund.message;
      m.dauerMs = seit();
      m.phase = phaseAus(m);
      fehler(grund);
    };
    const req = httpRequest(
      { host: '127.0.0.1', port, path: pfad, method: optionen.method ?? 'GET', headers: optionen.headers, agent: false, timeout: fristMs },
      (res) => {
        m.kopfMs = seit();
        m.status = res.statusCode ?? 0;
        const teile: Buffer[] = [];
        res.on('data', (d: Buffer) => teile.push(d));
        res.on('end', () => {
          m.endeMs = seit();
          m.dauerMs = m.endeMs;
          m.phase = 'fertig';
          ok({ status: res.statusCode ?? 0, text: Buffer.concat(teile).toString('utf8') });
        });
        res.on('error', scheitern);
      },
    );
    req.on('socket', (socket: Socket) => {
      const verbunden = () => {
        m.verbundenMs = seit();
        m.lokalerPort = socket.localPort;
      };
      if (socket.connecting) socket.once('connect', verbunden);
      else verbunden();
    });
    req.on('finish', () => {
      m.gesendetMs = seit();
    });
    req.on('timeout', () => req.destroy(new Error(`Zeitüberschreitung nach ${fristMs} ms (${phaseAus(m)}): ${m.methode} ${pfad}`)));
    req.on('error', scheitern);
    if (optionen.body) req.write(optionen.body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
//  Lage der Maschine
// ---------------------------------------------------------------------------

const MIB = 1024 * 1024;

function mitFrist<T>(zusage: Promise<T>, ms: number, was: string): Promise<T> {
  let uhr: NodeJS.Timeout | undefined;
  const frist = new Promise<never>((_, ab) => {
    uhr = setTimeout(() => ab(new Error(`${was}: kein Ergebnis nach ${ms} ms`)), ms);
  });
  return Promise.race([zusage, frist]).finally(() => clearTimeout(uhr));
}

function befehl(datei: string, argumente: string[], fristMs: number): Promise<string> {
  return new Promise((ok, fehler) => {
    execFile(datei, argumente, { timeout: fristMs, windowsHide: true, maxBuffer: 4 * MIB, encoding: 'utf8' }, (f, stdout) =>
      f ? fehler(f) : ok(stdout),
    );
  });
}

/**
 * Speicher, Seitenfehler und Rechenzeit der Instanzen — und der übrigen
 * Node- und Postgres-Prozesse.
 *
 * Unter Windows über WMI (`Win32_Process`), weil weder `tasklist` (Rechenzeit
 * nur in ganzen Sekunden) noch Node selbst diese Zahlen für einen fremden
 * Prozess liefert. Die übrigen `node.exe` und `postgres.exe` stehen mit
 * drin, weil der Befund nur in vollen Läufen auftrat: Dann laufen Testserver,
 * Prüfreihe und gelegentlich ein Entwicklungsserver daneben, und die Frage
 * ist, wer den Speicher hält. Befehlszeilen werden bewusst nicht erhoben —
 * sie können Adressen mit Zugangsdaten enthalten.
 *
 * Unter Linux (CI) aus `/proc`: Dort stehen grosse Seitenfehler und
 * Auslagerung je Prozess, also genau die Spur eines Prozesses, dessen
 * Speicher ausgelagert wurde, während er untätig wartete.
 *
 * Zwei Erhebungen (Wächter und Fehlschlag) ergeben die Differenz: Rechenzeit
 * und Seitenfehler **während** des Hängens. Viel Rechenzeit heisst „der
 * Prozess arbeitete" (Speicherbereinigung, Schleife), wenig Rechenzeit mit
 * vielen Seitenfehlern „er wartete auf ausgelagerten Speicher", wenig von
 * beidem „er wartete auf etwas ausserhalb".
 */
async function prozesseAbziehen(pids: number[]): Promise<unknown> {
  const sauber = pids.filter((pid) => Number.isInteger(pid) && pid > 0);
  try {
    if (process.platform === 'win32') {
      const filter = ["Name='node.exe'", "Name='postgres.exe'", ...sauber.map((pid) => `ProcessId=${pid}`)].join(' OR ');
      const skript = [
        `$p = @(Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; eltern = $_.ParentProcessId; name = $_.Name; arbeitssatzBytes = $_.WorkingSetSize; privatBytes = $_.PrivatePageCount; seitenfehler = $_.PageFaults; benutzerzeit100ns = $_.UserModeTime; kernzeit100ns = $_.KernelModeTime; threads = $_.ThreadCount } })`,
        '$os = Get-CimInstance Win32_OperatingSystem',
        '$pf = @(Get-CimInstance Win32_PageFileUsage | ForEach-Object { [pscustomobject]@{ name = $_.Name; belegtMb = $_.CurrentUsage; groesseMb = $_.AllocatedBaseSize; spitzeMb = $_.PeakUsage } })',
        '[pscustomobject]@{ prozesse = $p; physischFreiKb = $os.FreePhysicalMemory; physischGesamtKb = $os.TotalVisibleMemorySize; virtuellFreiKb = $os.FreeVirtualMemory; virtuellGesamtKb = $os.TotalVirtualMemorySize; auslagerungsdatei = $pf } | ConvertTo-Json -Depth 4 -Compress',
      ].join('\n');
      // Als `-EncodedCommand`: Der Filter enthält Anführungszeichen, und deren
      // Weg über die Befehlszeile von Windows ist für PowerShell 5.1 nicht
      // verlässlich. UTF-16LE in Base64 umgeht die Quotierung ganz. Die
      // Kennungen sind geprüfte ganze Zahlen aus `ChildProcess.pid`.
      const ausgabe = await befehl(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(skript, 'utf16le').toString('base64')],
        PROZESS_FRIST_MS,
      );
      return { instanzPids: sauber, ...(JSON.parse(ausgabe) as Record<string, unknown>) };
    }
    if (process.platform === 'linux') {
      const kb = (text: string, name: string) => Number(new RegExp(`^${name}:\\s+(\\d+)\\s+kB`, 'm').exec(text)?.[1] ?? Number.NaN);
      const meminfo = readFileSync('/proc/meminfo', 'utf8');
      return {
        instanzPids: sauber,
        system: {
          memTotalKb: kb(meminfo, 'MemTotal'),
          memAvailableKb: kb(meminfo, 'MemAvailable'),
          swapTotalKb: kb(meminfo, 'SwapTotal'),
          swapFreeKb: kb(meminfo, 'SwapFree'),
        },
        prozesse: sauber.map((pid) => {
          try {
            const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
            // Erst nach der schliessenden Klammer zählen: Der Prozessname darf
            // Leerzeichen enthalten. Index 0 ist Feld 3 (`state`) aus proc(5).
            const felder = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
            const status = readFileSync(`/proc/${pid}/status`, 'utf8');
            return {
              pid,
              zustand: felder[0],
              kleineSeitenfehler: Number(felder[7]),
              grosseSeitenfehler: Number(felder[9]),
              benutzerTakte: Number(felder[11]),
              systemTakte: Number(felder[12]),
              threads: Number(felder[17]),
              rssKb: kb(status, 'VmRSS'),
              swapKb: kb(status, 'VmSwap'),
            };
          } catch (fehler) {
            return { pid, fehler: (fehler as Error).message };
          }
        }),
        hinweis: 'Takte in USER_HZ (unter Linux üblich 100 je Sekunde).',
      };
    }
    return { instanzPids: sauber, hinweis: `Auf ${process.platform} nicht erhoben.` };
  } catch (fehler) {
    return { instanzPids: sauber, fehler: (fehler as Error).message };
  }
}

/**
 * Verbindungen zur Datenbank — über eine **eigene** Verbindung mit harten
 * Zeitgrenzen, nicht über `testDb()`.
 *
 * Wäre die Datenbank der Grund des Hängens, hinge ein Abzug über den
 * gewöhnlichen Prisma-Zugang mit: Der hat keine Verbindungsfrist (siehe
 * Kopf). Hier gilt für Aufbau und jede Abfrage eine Grenze von fünf
 * Sekunden, und ein Scheitern steht als Befund im Abzug — „keine Verbindung
 * in 5 s" ist selbst eine Aussage.
 *
 * Abfragetexte nur gekürzt und geschwärzt: Prisma schickt Platzhalter, keine
 * Werte, aber ein Rohtext anderer Herkunft kann Daten tragen.
 */
async function datenbankAbziehen(adresse: string | null, anwendung: string): Promise<unknown> {
  if (!adresse) return { fehler: 'Keine Testdatenbankadresse bekannt.' };
  const client = new pg.Client({
    connectionString: adresse,
    connectionTimeoutMillis: DATENBANK_FRIST_MS,
    query_timeout: DATENBANK_FRIST_MS,
    application_name: anwendung,
  });
  try {
    await client.connect();
    const max = await client.query<{ max_connections: string }>('SHOW max_connections');
    const reserviert = await client.query<{ superuser_reserved_connections: string }>('SHOW superuser_reserved_connections');
    const gruppen = await client.query<{ anzahl: number }>(
      `SELECT datname AS datenbank, state AS zustand, application_name AS anwendung, wait_event_type AS warteart,
              count(*)::int AS anzahl,
              round(max(extract(epoch FROM now() - state_change))::numeric, 1)::float8 AS aeltester_zustand_s
         FROM pg_stat_activity
        WHERE backend_type = 'client backend'
        GROUP BY 1, 2, 3, 4
        ORDER BY anzahl DESC`,
    );
    const lang = await client.query<{ abfrage: string | null }>(
      `SELECT pid, datname AS datenbank, application_name AS anwendung, state AS zustand,
              wait_event_type AS warteart, wait_event AS warteereignis,
              round(extract(epoch FROM now() - xact_start)::numeric, 1)::float8 AS transaktion_s,
              round(extract(epoch FROM now() - query_start)::numeric, 1)::float8 AS abfrage_s,
              left(query, 200) AS abfrage
         FROM pg_stat_activity
        WHERE backend_type = 'client backend'
          AND pid <> pg_backend_pid()
          AND state IS DISTINCT FROM 'idle'
          AND now() - coalesce(query_start, backend_start) > interval '5 seconds'
        ORDER BY query_start NULLS LAST
        LIMIT 20`,
    );
    const wartend = await client.query<{ anzahl: number }>('SELECT count(*)::int AS anzahl FROM pg_locks WHERE NOT granted');
    return {
      maxConnections: Number(max.rows[0]?.max_connections),
      superuserReserviert: Number(reserviert.rows[0]?.superuser_reserved_connections),
      verbindungenGesamt: gruppen.rows.reduce((summe, r) => summe + r.anzahl, 0),
      verbindungen: gruppen.rows,
      langeLaufend: lang.rows.map((r) => ({ ...r, abfrage: r.abfrage ? schwaerzen(r.abfrage) : r.abfrage })),
      wartendeSperren: wartend.rows[0]?.anzahl ?? null,
    };
  } catch (fehler) {
    return { fehler: schwaerzen((fehler as Error).message) };
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * Zugangsdaten in Adressen (`postgresql://‹benutzer›:‹passwort›@…`) und alles,
 * was `redigieren` kennt.
 *
 * Das Beispiel steht bewusst mit Winkelzeichen da. In Klarbuchstaben hielt
 * die Geheimnisprüfung (`DB_MUSTER` in `scripts/security/geheimnisse.ts`) es
 * für eine echte Verbindung mit Passwort und brach ab — und zwar zu Recht:
 * Aus einer eingecheckten Zeile heraus ist ein Beispiel von einem Zugangsdatum
 * nicht zu unterscheiden. Eine Ausnahme in der Prüfung wäre der falsche Weg
 * gewesen; sie hätte die nächste echte Adresse in einem Kommentar mit
 * durchgelassen.
 */
function schwaerzen(text: string): string {
  return redigieren(text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1‹zugang›@'));
}

// ---------------------------------------------------------------------------
//  Die Diagnose einer Testdatei
// ---------------------------------------------------------------------------

interface Ausgabezeile {
  zeit: string;
  /** Millisekunden seit dem Start der Instanz. */
  nachMs: number;
  kanal: 'stdout' | 'stderr';
  text: string;
}

interface Eintrag {
  name: string;
  prozess: ChildProcess;
  gestartet: number;
  port: number | null;
  portNachMs: number | null;
  bereitNachMs: number | null;
  /** Ende der letzten erfolgreichen Anfrage — daraus die Ruhezeit vor der nächsten. */
  letzteAntwort: number | null;
  ausgabe: Ausgabezeile[];
  beendet: { code: number | null; signal: string | null; nachMs: number } | null;
  portZusage: Promise<number>;
}

interface Waechter {
  nachMs: number;
  proben: Promise<Messung[]>;
  lage: Promise<unknown>;
}

export interface InstanzDiagnose {
  /**
   * Eine eben gestartete Instanz begleiten: Ausgabe mit Zeitstempel
   * mitschreiben, den Port aus der „Local:"-Zeile lesen, auf eine
   * 200-Antwort von `bereitPfad` warten. Liefert den Port.
   *
   * Scheitert der Start (Prozess endet, Startfehler, Frist), entsteht ein
   * Abzug, und der Fehler nennt ihn.
   */
  startBegleiten(
    name: string,
    prozess: ChildProcess,
    optionen: { datenbank: string | null; fristMs: number; bereitPfad?: string },
  ): Promise<number>;
  /** Eine beobachtete Anfrage an die Instanz auf `port` (siehe Kopf dieser Datei). */
  anfrage(port: number, pfad: string, optionen?: AnfrageOptionen): Promise<Antwort>;
}

/**
 * Eine Diagnose je Testdatei. `kennung` ist der Registerpunkt (`W-11`); aus
 * ihm entstehen Dateinamen (`test-results/w11-…json`) und der
 * `application_name` der Diagnoseverbindung.
 */
export function instanzDiagnose(kennung: string): InstanzDiagnose {
  const kurz = kennung.toLowerCase().replace(/[^a-z0-9]/g, '');
  const beginn = Date.now();
  const instanzen = new Map<string, Eintrag>();
  const zeitleiste: Array<Record<string, unknown>> = [];
  let datenbank: string | null = null;
  let abzugNummer = 0;

  /**
   * Ein Eintrag der Zeitleiste. `nachMs` zählt ab dem Anlegen der Diagnose
   * und steht **nach** den Daten, damit kein gleichnamiges Feld eines
   * Ereignisses die gemeinsame Zeitachse überschreibt — eine Zeitleiste, deren
   * Einträge verschiedene Nullpunkte haben, lässt sich nicht lesen.
   */
  const ereignis = (instanz: string | null, art: string, daten: Record<string, unknown> = {}) => {
    if (zeitleiste.length >= ZEITLEISTE_HOECHSTENS) return;
    zeitleiste.push({ ...daten, zeit: new Date().toISOString(), nachMs: Date.now() - beginn, instanz, art });
  };

  const nachPort = (port: number) => [...instanzen.values()].find((e) => e.port === port);

  const messungAnlegen = (instanz: string, port: number, methode: string, pfad: string): Messung => ({
    instanz,
    methode,
    pfad,
    port,
    beginn: new Date().toISOString(),
  });

  /** Ein Passwort, das in der bekannten Adresse steht, auch dann schwärzen, wenn es allein auftaucht. */
  const geschwaerzt = (text: string): string => {
    let ergebnis = schwaerzen(text);
    if (datenbank) {
      try {
        const passwort = decodeURIComponent(new URL(datenbank).password);
        if (passwort.length >= 4) ergebnis = ergebnis.split(passwort).join('‹passwort›');
      } catch {
        // Keine URL-Form — dann bleibt es bei der Musterschwärzung.
      }
    }
    return ergebnis;
  };

  const lageErfassen = async (anlass: string) => {
    const pids = [...instanzen.values()].map((e) => e.prozess.pid ?? 0);
    const [prozesse, db] = await Promise.all([prozesseAbziehen(pids), datenbankAbziehen(datenbank, `clenaris-${kurz}-diagnose`)]);
    return {
      anlass,
      zeit: new Date().toISOString(),
      system: {
        plattform: process.platform,
        node: process.version,
        prozessoren: cpus().length,
        // Unter Windows immer [0, 0, 0] — Node kennt dort keine Lastmittel.
        lastmittel: loadavg(),
        freiMb: Math.round(freemem() / MIB),
        gesamtMb: Math.round(totalmem() / MIB),
        betriebszeitS: Math.round(uptime()),
      },
      pruefprozess: { speicher: process.memoryUsage(), ressourcen: process.resourceUsage() },
      prozesse,
      datenbank: db,
    };
  };

  const instanzBeschreiben = (e: Eintrag) => ({
    name: e.name,
    pid: e.prozess.pid ?? null,
    port: e.port,
    laeuft: e.prozess.exitCode === null && e.prozess.signalCode === null,
    beendet: e.beendet,
    gestartet: new Date(e.gestartet).toISOString(),
    portNachMs: e.portNachMs,
    bereitNachMs: e.bereitNachMs,
    ruhigSeitMs: e.letzteAntwort === null ? null : Date.now() - e.letzteAntwort,
    ausgabe: e.ausgabe.map((z) => ({ ...z, text: geschwaerzt(z.text) })),
  });

  const ausgabeEnde = (e: Eintrag | undefined, zeilen = 40): string =>
    e
      ? e.ausgabe
          .slice(-zeilen)
          .map((z) => `[+${(z.nachMs / 1000).toFixed(1)} s] ${z.kanal}: ${geschwaerzt(z.text)}`)
          .join('\n') || '(keine Ausgabe)'
      : '(Instanz unbekannt)';

  const abzugSchreiben = (art: 'fehlschlag' | 'langsam', inhalt: Record<string, unknown>): string => {
    mkdirSync(ABLAGE, { recursive: true });
    const stempel = new Date().toISOString().replace(/[:.]/g, '-');
    let datei = join(ABLAGE, `${kurz}-${art === 'langsam' ? 'langsam-' : ''}${stempel}.json`);
    while (existsSync(datei)) datei = datei.replace(/(-\d+)?\.json$/, `-${++abzugNummer}.json`);
    const abzug = {
      kennung,
      art,
      zeitpunkt: new Date().toISOString(),
      lesehilfe: {
        phasen:
          'verbinden = keine Verbindung zustande gekommen; senden = verbunden, Anfrage nicht ganz geschrieben; ' +
          'antwort-abwarten = verbunden und gesendet, keine Kopfzeilen; rumpf-lesen = Antwort begonnen, nicht beendet.',
        proben:
          'Zwei neue Verbindungen, sobald eine Anfrage 5 s ohne Kopfzeilen war: runtime-config (ohne Datenbank) und health (mit). ' +
          'Antworten beide schnell, hängt nur die eine Verbindung; hängen beide, steht der Prozess; hängt nur health, liegt es an der Datenbank.',
        lagen:
          'Erhebung beim Wächter (während des Hängens) und beim Fehlschlag; die Differenz von Rechenzeit und Seitenfehlern zeigt, ' +
          'was der Prozess dazwischen tat. Die Instanzen tragen den application_name, den die Testdatei über PGAPPNAME setzt ' +
          '(W-11: clenaris-w11-a, clenaris-w11-b); die Abzugsverbindung selbst heisst clenaris-<kennung>-diagnose.',
        selbstverbindung: 'lokalerPort gleich port hiesse: Die Anfrage war mit sich selbst verbunden (TCP-Selbstverbindung).',
      },
      ...inhalt,
      instanzen: [...instanzen.values()].map(instanzBeschreiben),
      zeitleiste,
    };
    writeFileSync(datei, JSON.stringify(abzug, null, 2), 'utf8');
    return datei;
  };

  const anmelden = (name: string, prozess: ChildProcess): Eintrag => {
    let portAufloesen!: (port: number) => void;
    let portAblehnen!: (grund: Error) => void;
    const portZusage = new Promise<number>((auf, ab) => {
      portAufloesen = auf;
      portAblehnen = ab;
    });
    // Ein Ende nach erfolgreichem Start lehnt eine bereits erfüllte Zusage ab
    // (wirkungslos) — ohne diesen Empfänger meldete Node einen Start, der vor
    // dem Abwarten scheitert, als unbehandelte Ablehnung.
    portZusage.catch(() => undefined);

    const eintrag: Eintrag = {
      name,
      prozess,
      gestartet: Date.now(),
      port: null,
      portNachMs: null,
      bereitNachMs: null,
      letzteAntwort: null,
      ausgabe: [],
      beendet: null,
      portZusage,
    };
    instanzen.set(name, eintrag);

    /*
      Die Ausgabe wird für die ganze Lebensdauer der Instanz gelesen, nicht
      nur bis zum Port. Das ist mehr als Bequemlichkeit: Liest niemand eine
      Pipe, läuft ihr Puffer voll, und ein Kindprozess, der dann schreibt,
      bleibt stehen — genau die Art Hängen, die hier untersucht wird.
    */
    /*
      Startfehler werden gesammelt, statt beim ersten abzulehnen. Next
      schreibt beim Scheitern des Bindens **zuerst** die allgemeine Zeile
      „Failed to start server" und **danach** den eigentlichen Fehler
      (`next/dist/server/lib/start-server.js` 15.5.26: `_log.error(…)`, dann
      `console.error(err)`, dann `process.exit(1)`). Lehnte schon die erste
      Zeile ab, nannte der Fall den Grund nie — „EADDRINUSE" kam eine Zeile
      zu spät, und die Meldung sagte nur, *dass* der Start scheiterte. Ein
      bestimmter Grund (belegt, nicht erlaubt) lehnt deshalb sofort ab; die
      allgemeine Zeile allein wartet auf das Ende des Prozesses und steht
      dann im Grund mit.
    */
    const startfehler: string[] = [];
    for (const kanal of ['stdout', 'stderr'] as const) {
      const strom = prozess[kanal];
      if (!strom) continue;
      // Ein Zeichen aus mehreren Bytes kann auf zwei Blöcke fallen.
      const decoder = new StringDecoder('utf8');
      const sammler = zeilenSammler((roh) => {
        // Ohne Farbsteuerzeichen: Im Abzug und in der Fehlermeldung stünden sie
        // als Zeichensalat, und für die Portsuche sind sie ohnehin entfernt.
        const text = roh.replace(ANSI, '');
        eintrag.ausgabe.push({ zeit: new Date().toISOString(), nachMs: Date.now() - eintrag.gestartet, kanal, text });
        if (eintrag.ausgabe.length > AUSGABE_ZEILEN) eintrag.ausgabe.shift();
        if (eintrag.port !== null) return;
        const port = kanal === 'stdout' ? lokalerPortAus(text) : null;
        if (port !== null) {
          eintrag.port = port;
          eintrag.portNachMs = Date.now() - eintrag.gestartet;
          ereignis(name, 'port', { port, seitStartMs: eintrag.portNachMs });
          portAufloesen(port);
          return;
        }
        const fehler = startfehlerAus(text);
        if (!fehler) return;
        startfehler.push(fehler);
        if (!ALLGEMEINER_STARTFEHLER.test(text)) portAblehnen(new Error(fehler));
      });
      strom.on('data', (block: Buffer) => sammler.aufnehmen(decoder.write(block)));
      strom.on('end', () => {
        sammler.aufnehmen(decoder.end());
        sammler.abschliessen();
      });
    }

    /*
      Das Ende eines Prozesses, der seinen Port nie nannte, wird erst bei
      `close` gemeldet, nicht schon bei `exit`. Node sagt ausdrücklich, dass
      beim `exit`-Ereignis die Ausgabeströme des Kindes noch offen sein
      können: Die letzten Zeilen — oft genau die Fehlermeldung — wären dann
      noch nicht gelesen, und ein Wettlauf entschiede, ob der Fall
      „EADDRINUSE" oder nur „Prozess endete" meldet. `close` kommt erst,
      wenn beide Ströme zu sind und `zeilenSammler` die letzte Zeile
      abgegeben hat.

      Hielte ein Enkelprozess die Ströme offen, käme `close` nie, und der
      Start scheiterte erst nach 90 Sekunden mit „keine Local-Zeile" — eine
      falsche Aussage über einen Prozess, der längst beendet ist. Dafür die
      Gnadenfrist nach `exit`. `next start` 15.5 startet keinen Enkel (der
      Server läuft im selben Prozess); die Frist ist Versicherung, kein
      Ausgleich für Langsamkeit, und ein Ablehnen nach erfülltem Port ist
      wirkungslos.
    */
    const endeMelden = () => {
      const code = eintrag.beendet?.code ?? prozess.exitCode;
      const signal = eintrag.beendet?.signal ?? prozess.signalCode;
      const ende = `Code ${code ?? '–'}, Signal ${signal ?? '–'}`;
      portAblehnen(
        new Error(
          startfehler.length > 0
            ? `${startfehler.join(' / ')} (Prozess endete: ${ende})`
            : `Der Prozess endete (${ende}), bevor er seinen Port nannte.`,
        ),
      );
    };
    prozess.once('exit', (code, signal) => {
      eintrag.beendet = { code, signal, nachMs: Date.now() - eintrag.gestartet };
      ereignis(name, 'ende', { code, signal });
      setTimeout(endeMelden, ENDE_GNADE_MS).unref();
    });
    prozess.once('close', endeMelden);
    return eintrag;
  };

  const waechterAusloesen = (port: number, m: Messung): Waechter => {
    const nachMs = Date.now() - Date.parse(m.beginn);
    ereignis(m.instanz, 'waechter', { pfad: m.pfad, seitAnfrageMs: nachMs, phase: phaseAus(m) });
    const proben = Promise.all(
      PROBEN.map(async (pfad) => {
        const probe = messungAnlegen(m.instanz, port, 'GET', pfad);
        // Das Ergebnis steht in `probe` — auch ein Scheitern ist ein Befund.
        await rohAnfrage(port, pfad, {}, probe, PROBE_FRIST_MS).catch(() => undefined);
        ereignis(m.instanz, 'probe', { ...probe });
        return probe;
      }),
    );
    return { nachMs, proben, lage: lageErfassen('waechter') };
  };

  /** Proben und Lage des Wächters, je mit eigener Frist — ein hängender Teil nimmt den anderen nicht mit. */
  const waechterEinsammeln = async (waechter: Waechter) => {
    const [proben, lage] = await Promise.allSettled([
      mitFrist(waechter.proben, ERHEBUNG_FRIST_MS, 'Proben'),
      mitFrist(waechter.lage, ERHEBUNG_FRIST_MS, 'Lage beim Wächter'),
    ]);
    return {
      proben: proben.status === 'fulfilled' ? proben.value : null,
      lage: lage.status === 'fulfilled' ? lage.value : { anlass: 'waechter', fehler: (lage.reason as Error).message },
    };
  };

  const probenText = (proben: Messung[] | null): string =>
    proben
      ? proben.map((p) => `${p.methode} ${p.pfad} → ${p.status ?? p.fehler ?? '?'} nach ${p.dauerMs ?? '?'} ms (${p.phase ?? phaseAus(p)})`).join('; ')
      : 'keine (der Wächter hat nicht ausgelöst oder seine Proben kamen nicht zurück)';

  const fehlschlagBelegen = async (
    eintrag: Eintrag | undefined,
    m: Messung,
    waechter: Waechter | null,
    ruhigVorherMs: number | null,
    fehler: Error,
  ): Promise<Error> => {
    const waehrend = waechter ? await waechterEinsammeln(waechter) : null;
    const lage = await lageErfassen('fehlschlag');
    // Die Nachfrage der Diagnose vom 2026-09-27, beibehalten: Sie trennt
    // „Prozess antwortet nicht mehr" von „er antwortet wieder".
    const nachfrage = messungAnlegen(m.instanz, m.port, 'GET', '/api/health');
    await rohAnfrage(m.port, '/api/health', {}, nachfrage, NACHFRAGE_FRIST_MS).catch(() => undefined);
    ereignis(m.instanz, 'nachfrage', { ...nachfrage });

    const datei = abzugSchreiben('fehlschlag', {
      anlass: `${m.instanz}: ${fehler.message}`,
      messung: m,
      ruhigVorherMs,
      waechter: waechter ? { nachMs: waechter.nachMs, proben: waehrend?.proben ?? null } : null,
      nachfrage,
      lagen: [...(waehrend ? [waehrend.lage] : []), lage],
    });

    const zustand = eintrag
      ? eintrag.prozess.exitCode === null && eintrag.prozess.signalCode === null
        ? 'läuft'
        : `beendet (Code ${eintrag.prozess.exitCode ?? '–'}, Signal ${eintrag.prozess.signalCode ?? '–'})`
      : 'unbekannt';
    return new Error(
      [
        `Instanz ${m.instanz} (Port ${m.port}, Prozess ${zustand}): ${fehler.message}`,
        `Phase: ${m.phase ?? phaseAus(m)} — verbunden ${m.verbundenMs ?? '–'} ms, gesendet ${m.gesendetMs ?? '–'} ms, Kopfzeilen ${m.kopfMs ?? '–'} ms; lokaler Port ${m.lokalerPort ?? '–'}`,
        `Ruhig vor der Anfrage: ${ruhigVorherMs ?? '–'} ms`,
        `Proben während des Hängens: ${probenText(waehrend?.proben ?? null)}`,
        `Nachfrage /api/health: ${nachfrage.status ?? nachfrage.fehler ?? '?'} nach ${nachfrage.dauerMs ?? '?'} ms`,
        `Abzug: ${datei}`,
        'Serverausgabe (Ende):',
        ausgabeEnde(eintrag),
      ].join('\n'),
    );
  };

  return {
    async startBegleiten(name, prozess, optionen) {
      if (optionen.datenbank) datenbank = optionen.datenbank;
      const eintrag = anmelden(name, prozess);
      ereignis(name, 'start', { pid: prozess.pid ?? null });
      const bis = eintrag.gestartet + optionen.fristMs;
      const bereitPfad = optionen.bereitPfad ?? '/api/public/runtime-config';

      let grund: string;
      try {
        const port = await mitFrist(eintrag.portZusage, Math.max(1, bis - Date.now()), 'Startausgabe ohne „Local:"-Zeile');
        let versuche = 0;
        let letzte: Messung | null = null;
        while (Date.now() < bis && prozess.exitCode === null) {
          versuche += 1;
          letzte = messungAnlegen(name, port, 'GET', bereitPfad);
          try {
            const antwort = await rohAnfrage(port, bereitPfad, {}, letzte, Math.min(ANFRAGE_FRIST_MS, Math.max(1_000, bis - Date.now())));
            if (antwort.status === 200) {
              eintrag.bereitNachMs = Date.now() - eintrag.gestartet;
              eintrag.letzteAntwort = Date.now();
              ereignis(name, 'bereit', { port, seitStartMs: eintrag.bereitNachMs, versuche });
              return port;
            }
          } catch {
            // Noch nicht bereit — die letzte Messung steht unten im Abzug.
          }
          await new Promise((r) => setTimeout(r, 500));
        }
        grund = `nicht bereit nach ${versuche} Versuchen; letzter Versuch: ${letzte ? `${letzte.status ?? letzte.fehler ?? '?'} (${letzte.phase ?? phaseAus(letzte)})` : '–'}`;
        ereignis(name, 'nicht-bereit', { port, versuche, letzte });
      } catch (fehler) {
        grund = (fehler as Error).message;
        ereignis(name, 'startfehler', { grund });
      }
      const lage = await lageErfassen('startfehler');
      const datei = abzugSchreiben('fehlschlag', { anlass: `${name} kam nicht hoch: ${grund}`, lagen: [lage] });
      throw new Error(`Instanz ${name} kam nicht hoch: ${grund}\nAbzug: ${datei}\nServerausgabe (Ende):\n${ausgabeEnde(eintrag, 60)}`);
    },

    async anfrage(port, pfad, optionen = {}) {
      const eintrag = nachPort(port);
      const name = eintrag?.name ?? `Port ${port}`;
      const letzteAntwort = eintrag?.letzteAntwort ?? null;
      const ruhigVorherMs = letzteAntwort === null ? null : Date.now() - letzteAntwort;
      const m = messungAnlegen(name, port, optionen.method ?? 'GET', pfad);
      // Über ein Objekt statt einer `let`-Variablen: TypeScript verfolgt keine
      // Zuweisung aus einem Rückruf und hielte den Wächter sonst für immer `null`.
      const beobachtet: { waechter: Waechter | null } = { waechter: null };
      const uhr = setTimeout(() => {
        if (m.kopfMs === undefined) beobachtet.waechter = waechterAusloesen(port, m);
      }, WAECHTER_MS);

      try {
        const antwort = await rohAnfrage(port, pfad, optionen, m, ANFRAGE_FRIST_MS);
        clearTimeout(uhr);
        ereignis(name, 'anfrage', { ...m, ruhigVorherMs });
        if (eintrag) eintrag.letzteAntwort = Date.now();
        const waechter = beobachtet.waechter;
        if (waechter) {
          // Angekommen, aber erst nach dem Wächter: festhalten, nicht warten.
          // Der Fall läuft weiter wie ohne Diagnose; der Abzug entsteht, sobald
          // Proben und Lage vorliegen (beide mit eigener Frist).
          void waechterEinsammeln(waechter)
            .then(({ proben, lage }) =>
              abzugSchreiben('langsam', {
                anlass: `${name}: ${m.methode} ${pfad} brauchte ${m.dauerMs} ms`,
                messung: m,
                ruhigVorherMs,
                waechter: { nachMs: waechter.nachMs, proben },
                lagen: [lage],
              }),
            )
            .catch(() => undefined);
        }
        return antwort;
      } catch (fehler) {
        clearTimeout(uhr);
        ereignis(name, 'anfrage', { ...m, ruhigVorherMs });
        throw await fehlschlagBelegen(eintrag, m, beobachtet.waechter, ruhigVorherMs, fehler as Error);
      }
    },
  };
}
