/**
 * `npm run security:check` — die Sicherheitsprüfungen in einem Lauf
 * (Sicherheitsautomation, 2026-09-26).
 *
 *   npm run security:check                     # Standardlauf
 *   npm run security:check -- --streng         # „nicht geprüft" zählt als Fehler (CI)
 *   npm run security:check -- --datenbank      # Schranken auch in DATABASE_URL suchen
 *   npm run security:check -- --mit-tests      # Sicherheitsreihen gegen TEST_BASE_URL
 *   npm run security:check -- --melden         # Bericht an SECURITY_REPORT_URL senden
 *
 * ---------------------------------------------------------------------------
 *  Was dieser Lauf ist
 * ---------------------------------------------------------------------------
 *
 * Ein **Dirigent**, keine neue Prüfung. Er ruft die vorhandenen Werkzeuge auf
 * (Geheimnisprüfung, `npm audit`, `prisma validate`, die OpenAPI-Registry,
 * die Prüfreihe) und ergänzt zwei, die es vorher nicht gab: die
 * Musterprüfung (`scripts/security/muster.ts`) und den Abgleich der
 * öffentlichen Endpunkte und Datenbankschranken mit durchgesehenen Listen
 * unter `security/`.
 *
 * Vier Ausgänge je Prüfung, und sie sind nicht austauschbar:
 *
 *   BESTANDEN       geprüft, nichts Blockierendes
 *   BEFUND          geprüft, mindestens ein Befund (Schwere steht dabei)
 *   NICHT GEPRÜFT   konnte hier nicht laufen — **kein** Bestehen
 *   FEHLER          das Werkzeug selbst ist gescheitert
 *
 * „Nicht geprüft" als „bestanden" zu zählen ist der Fehler, den dieser Lauf
 * vermeiden soll: Unter Windows ohne Bash läuft die Geheimnisprüfung nicht,
 * und genau dann stand früher gar nichts da. Massgebend für Geheimnisse
 * bleibt `scripts/ci-secret-scan.sh` im CI.
 *
 * Exitcode 1 bei einem blockierenden Befund oder einem FEHLER; mit
 * `--streng` auch bei NICHT GEPRÜFT.
 *
 * Was dieser Lauf **nicht** leistet, steht in `docs/SECURITY_AUTOMATION.md`:
 * Er findet bekannte Muster und bekannte Schwachstellen in Abhängigkeiten —
 * keine Logikfehler, keine fehlende Mandantenbedingung, keine unbekannte
 * Lücke.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { befundEinordnen, veralteteBewertungen, type Bewertung } from './security/bewertung';
import { geheimnisseImBestand } from './security/geheimnisse';
import { melden, type Meldung } from './security/melden';
import { musterPruefen, type Unterdrueckung } from './security/muster';
import { statusMitPflichtteil } from './security/pflichtabgleich';
import { bilanzPruefen, konfigurierteDateien, testbilanzLesen } from './security/testbilanz';

type Status = 'BESTANDEN' | 'BEFUND' | 'NICHT_GEPRUEFT' | 'FEHLER';
type Schwere = 'blockierend' | 'warnung' | 'hinweis';

interface Befund {
  id?: string;
  schwere: Schwere;
  titel: string;
  ort?: string;
  details?: string;
}

interface Pruefung {
  id: string;
  titel: string;
  status: Status;
  befunde: Befund[];
  hinweis?: string;
  dauerMs: number;
}

const WURZEL = join(__dirname, '..');
const argv = process.argv.slice(2);
const args = new Set(argv);

/**
 * Welche Prüfungen dieser Aufruf verspricht (2026-09-27).
 *
 *   statisch   Geheimnisse, Abhängigkeiten, Muster, Migrationen,
 *              Schnittstellen, Repository — ohne laufenden Server
 *   tests      nur die Sicherheitsreihen gegen TEST_BASE_URL
 *   voll       beides (Vorgabe, `npm run security:check`)
 *
 * **Jede Prüfung im Umfang muss laufen und bestehen.** Vorher kannte der Lauf
 * nur einen Umfang, aus dem die Prüfreihe ohne `--mit-tests` als
 * NICHT GEPRÜFT herausfiel — der Befehl endete mit Exitcode 0 und dem
 * Gesamtstatus NICHT_GEPRUEFT zugleich. „Bestanden" hiess damit je nach
 * Aufruf etwas anderes. Jetzt nennt der Aufruf seinen Umfang, und innerhalb
 * dieses Umfangs ist NICHT GEPRÜFT ein Fehlschlag, kein Hinweis. Was
 * ausserhalb des Umfangs liegt, erscheint nicht als „nicht geprüft", sondern
 * gar nicht — der Befehl hat es nicht versprochen.
 *
 * `--streng` und `--mit-tests` bleiben als ältere Schreibweisen gültig
 * (`--mit-tests` = voll); strenger als jetzt geht es nicht mehr.
 */
type Umfang = 'statisch' | 'tests' | 'voll';
const umfangRoh = argv[argv.indexOf('--umfang') + 1];
const UMFANG: Umfang =
  argv.includes('--umfang') && (umfangRoh === 'statisch' || umfangRoh === 'tests' || umfangRoh === 'voll')
    ? umfangRoh
    : argv.includes('--umfang')
      ? (() => {
          console.error(`Unbekannter Umfang „${umfangRoh ?? ''}" — erlaubt: statisch, tests, voll.`);
          process.exit(2);
        })()
      : 'voll';
const MIT_STATISCH = UMFANG !== 'tests';
const MIT_TESTS = UMFANG !== 'statisch';

function json<T>(pfad: string): T {
  return JSON.parse(readFileSync(join(WURZEL, pfad), 'utf8')) as T;
}

/** Ein Programm ausführen, ohne Shell, mit Zeitlimit. */
function ausfuehren(befehl: string, argumente: string[], optionen: { zeitMs?: number; env?: NodeJS.ProcessEnv } = {}) {
  const r = spawnSync(befehl, argumente, {
    cwd: WURZEL,
    encoding: 'utf8',
    timeout: optionen.zeitMs ?? 120_000,
    maxBuffer: 64 * 1024 * 1024,
    env: optionen.env ?? process.env,
    // Unter Windows sind `npm` und `npx` Stapeldateien; sie brauchen die
    // Shell. Die Argumente sind feste Texte aus diesem Skript.
    shell: process.platform === 'win32' && /^(npm|npx)$/.test(befehl),
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', fehler: r.error };
}

function gitFinden(): string | null {
  const kandidaten = [process.env.GIT, 'git'];
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const desktop = join(process.env.LOCALAPPDATA, 'GitHubDesktop');
    if (existsSync(desktop)) {
      for (const d of readdirSync(desktop).filter((n) => n.startsWith('app-')).sort().reverse()) {
        kandidaten.push(join(desktop, d, 'resources', 'app', 'git', 'cmd', 'git.exe'));
      }
    }
  }
  for (const k of kandidaten) {
    if (!k) continue;
    const r = spawnSync(k, ['--version'], { encoding: 'utf8' });
    if (r.status === 0) return k;
  }
  return null;
}

async function pruefung(id: string, titel: string, lauf: () => Promise<Omit<Pruefung, 'id' | 'titel' | 'dauerMs'>> | Omit<Pruefung, 'id' | 'titel' | 'dauerMs'>): Promise<Pruefung> {
  const start = Date.now();
  try {
    const r = await lauf();
    return { id, titel, ...r, dauerMs: Date.now() - start };
  } catch (fehler) {
    return { id, titel, status: 'FEHLER', befunde: [], hinweis: fehler instanceof Error ? fehler.message : String(fehler), dauerMs: Date.now() - start };
  }
}

const statusAus = (befunde: Befund[]): Status => (befunde.some((b) => b.schwere !== 'hinweis') ? 'BEFUND' : 'BESTANDEN');

// ---------------------------------------------------------------------------
//  1. Geheimnisse — dieselbe Umsetzung wie im CI
// ---------------------------------------------------------------------------
//
// Bis 2026-09-27 rief diese Prüfung das Bash-Skript auf und meldete ohne Bash
// NICHT GEPRÜFT — auf jedem Windows-Rechner also immer. Jetzt stehen die
// Regeln einmal in `scripts/security/geheimnisse.ts`; das Bash-Skript ist nur
// noch eine Hülle darum. Örtlich und im CI läuft derselbe Code.

function geheimnisse() {
  const { funde, dateien } = geheimnisseImBestand(WURZEL);
  const befunde: Befund[] = funde.map((f) => ({ schwere: 'blockierend', titel: f.regel, ort: `${f.datei}${f.zeile ? `:${f.zeile}` : ''}` }));
  return { status: statusAus(befunde), befunde, hinweis: `${dateien} verfolgte Dateien.` };
}

// ---------------------------------------------------------------------------
//  2. Abhängigkeiten — npm audit, eingeordnet
// ---------------------------------------------------------------------------

interface AuditEintrag {
  name: string;
  severity: string;
  isDirect: boolean;
  via: (string | { title: string; url: string; severity: string; range: string })[];
  fixAvailable: boolean | { name: string; version: string; isSemVerMajor: boolean };
}

function abhaengigkeiten() {
  const r = ausfuehren('npm', ['audit', '--omit=dev', '--json'], { zeitMs: 180_000 });
  let bericht: { vulnerabilities?: Record<string, AuditEintrag>; metadata?: { vulnerabilities: Record<string, number> } };
  try {
    bericht = JSON.parse(r.stdout);
  } catch {
    return { status: 'NICHT_GEPRUEFT' as const, befunde: [], hinweis: `npm audit lieferte kein JSON (Netz?): ${(r.stderr || r.stdout).slice(0, 200)}` };
  }
  if (!bericht.vulnerabilities) {
    return { status: 'NICHT_GEPRUEFT' as const, befunde: [], hinweis: 'npm audit ohne Ergebnisliste (Registry nicht erreichbar?).' };
  }
  const bewertungen = json<{ befunde: Bewertung[] }>('security/akzeptierte-befunde.json').befunde;
  const heute = new Date().toISOString().slice(0, 10);
  const befunde: Befund[] = [];
  const gesehen = new Set<string>();
  for (const eintrag of Object.values(bericht.vulnerabilities)) {
    for (const via of eintrag.via) {
      if (typeof via === 'string') continue;
      const id = via.url.split('/').pop() ?? via.url;
      if (gesehen.has(id)) continue;
      gesehen.add(id);
      const behebung =
        eintrag.fixAvailable === true
          ? 'Behebung ohne Hauptversion verfügbar'
          : eintrag.fixAvailable
            ? `Behebung: ${eintrag.fixAvailable.name}@${eintrag.fixAvailable.version}${eintrag.fixAvailable.isSemVerMajor ? ' (Hauptversion)' : ''}`
            : 'keine Behebung verfügbar';
      // Die Regeln (Ablauf, Vorwarnung, Höchstfrist) stehen in
      // `scripts/security/bewertung.ts` und sind dort geprüft.
      const { schwere, vermerk } = befundEinordnen(via.severity, bewertungen.find((b) => b.id === id), heute);
      befunde.push({
        id,
        schwere,
        titel: `${eintrag.name} (${via.severity}): ${via.title}`.slice(0, 300),
        ort: `${eintrag.name} ${via.range}`,
        details: `${behebung} · ${vermerk}`.slice(0, 1000),
      });
    }
  }
  // Bewertungen ohne Befund: behoben oder zurückgezogen — der Eintrag gehört
  // weg, sonst deckt er einen künftigen Befund mit derselben Kennung.
  for (const alt of veralteteBewertungen(bewertungen, gesehen)) {
    befunde.push({ id: alt.id, schwere: 'hinweis', titel: `Bewertung ohne Befund (entfernen): ${alt.id} ${alt.paket}` });
  }
  const m = bericht.metadata?.vulnerabilities ?? {};
  return {
    status: statusAus(befunde),
    befunde,
    hinweis: `Laufzeitabhängigkeiten: ${m.critical ?? 0} kritisch, ${m.high ?? 0} hoch, ${m.moderate ?? 0} mittel, ${m.low ?? 0} niedrig.`,
  };
}

// ---------------------------------------------------------------------------
//  3. Musterprüfung
// ---------------------------------------------------------------------------

function muster() {
  const { unterdrueckungen } = json<{ unterdrueckungen: Unterdrueckung[] }>('security/unterdrueckungen.json');
  const { treffer, fehler } = musterPruefen(WURZEL, unterdrueckungen);
  const befunde: Befund[] = [
    ...fehler.map((f) => ({ schwere: 'blockierend' as const, titel: f })),
    ...treffer
      .filter((t) => !t.unterdrueckt)
      .map((t) => ({
        id: t.regel,
        schwere: t.schwere,
        titel: `[${t.standard}] ${t.regel}: ${t.frage}`,
        ort: `${t.datei}:${t.zeile}`,
        details: t.auszug,
      })),
  ];
  const unterdrueckt = treffer.filter((t) => t.unterdrueckt).length;
  return { status: statusAus(befunde), befunde, hinweis: `${treffer.length} Treffer, davon ${unterdrueckt} durchgesehen und begründet unterdrückt.` };
}

// ---------------------------------------------------------------------------
//  4. Migrationen und Schema
// ---------------------------------------------------------------------------

async function migrationen() {
  const befunde: Befund[] = [];
  const v = ausfuehren('npx', ['prisma', 'validate'], { zeitMs: 120_000 });
  if (v.code !== 0) befunde.push({ schwere: 'blockierend', titel: 'prisma validate scheitert', details: (v.stderr || v.stdout).slice(-800) });

  const verzeichnis = join(WURZEL, 'prisma', 'migrations');
  let alles = '';
  for (const name of readdirSync(verzeichnis).sort()) {
    const datei = join(verzeichnis, name, 'migration.sql');
    if (!existsSync(datei)) continue;
    const roh = readFileSync(datei);
    // Ein BOM hat Postgres schon einmal eine Migration verweigern lassen
    // (CLAUDE.md, Konventionen).
    if (roh[0] === 0xef && roh[1] === 0xbb && roh[2] === 0xbf) befunde.push({ schwere: 'blockierend', titel: 'Migration mit UTF-8-BOM', ort: `prisma/migrations/${name}` });
    const sql = roh.toString('utf8');
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(sql)) befunde.push({ schwere: 'blockierend', titel: 'Migration mit Steuerzeichen', ort: `prisma/migrations/${name}` });
    for (const m of sql.matchAll(/^\s*(DROP\s+(TABLE|COLUMN|TYPE)|ALTER\s+TABLE\s+\S+\s+DROP\s+COLUMN|TRUNCATE)\b[^\n]*/gim)) {
      befunde.push({ schwere: 'hinweis', titel: 'Datenverlierende Anweisung (bei Freigabe bewusst prüfen)', ort: `prisma/migrations/${name}`, details: m[0].trim().slice(0, 200) });
    }
    alles += `\n${sql}`;
  }

  const schranken = json<{ teilindizes: string[]; trigger: string[] }>('security/datenbank-schranken.json');
  for (const name of [...schranken.teilindizes, ...schranken.trigger]) {
    if (!new RegExp(`\\b${name}\\b`).test(alles)) befunde.push({ schwere: 'blockierend', titel: `Handgeschriebene Schranke fehlt in den Migrationen: ${name}` });
  }
  const bekannt = new Set([...schranken.teilindizes, ...schranken.trigger]);
  for (const m of alles.matchAll(/CREATE\s+UNIQUE\s+INDEX\s+"?(\w+)"?[^;]*?WHERE|CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+"?(\w+)"?/gis)) {
    const name = m[1] ?? m[2];
    if (name && !bekannt.has(name)) befunde.push({ schwere: 'warnung', titel: `Neue handgeschriebene Schranke nicht in security/datenbank-schranken.json: ${name}` });
  }

  /**
   * Verträglichkeitstor (Notfallauftrag 2026-09-27): Jede Migration braucht
   * eine durchgesehene Einstufung gegen die vorherige Programmfassung, und
   * eine mildere Einstufung als die Heuristik eine Begründung. Blockierend —
   * die Auslieferung aktiviert Migration und Programm nur dann ohne
   * Wartungsfenster zusammen, wenn sie weiss, was die Migration der alten
   * Fassung antut (`scripts/migration-kompatibilitaet.ts`).
   */
  const { reiheEinstufen, registerLesen, torPruefen } = await import('./migration-kompatibilitaet');
  const tor = torPruefen(reiheEinstufen(verzeichnis), registerLesen());
  for (const f of tor.fehler) befunde.push({ schwere: 'blockierend', titel: 'Migrations-Verträglichkeit', details: f });

  let hinweis = `${schranken.teilindizes.length} Teilindizes, ${schranken.trigger.length} Trigger in den Migrationen gefunden; Verträglichkeit: ${tor.fehler.length === 0 ? 'jede Migration durchgesehen' : `${tor.fehler.length} Fehler`}.`;
  // Verlangt, aber ohne Adresse: NICHT_GEPRUEFT statt BESTANDEN (M2, `security/pflichtabgleich.ts`).
  const abgleich = { verlangt: args.has('--datenbank'), gelaufen: false };
  if (abgleich.verlangt) {
    if (!process.env.DATABASE_URL?.trim()) {
      hinweis += ' Datenbankabgleich: NICHT GEPRÜFT (keine DATABASE_URL) — `--datenbank` verlangt ihn.';
    } else {
      const { erzeugePrismaClient } = await import('../src/lib/prisma-client');
      const prisma = erzeugePrismaClient();
      try {
        const indizes = new Set((await prisma.$queryRaw<{ n: string }[]>`SELECT indexname AS n FROM pg_indexes WHERE schemaname = 'public'`).map((r) => r.n));
        const trigger = new Set((await prisma.$queryRaw<{ n: string }[]>`SELECT tgname AS n FROM pg_trigger WHERE NOT tgisinternal`).map((r) => r.n));
        for (const n of schranken.teilindizes) if (!indizes.has(n)) befunde.push({ schwere: 'blockierend', titel: `Teilindex fehlt in der Datenbank: ${n}` });
        for (const n of schranken.trigger) if (!trigger.has(n)) befunde.push({ schwere: 'blockierend', titel: `Trigger fehlt in der Datenbank: ${n}` });
        hinweis += ' Datenbankabgleich durchgeführt.';
        abgleich.gelaufen = true;
      } finally {
        await prisma.$disconnect();
      }
    }
  }
  return { status: statusMitPflichtteil(befunde, abgleich), befunde, hinweis };
}

// ---------------------------------------------------------------------------
//  5. Schnittstellen — was ist ohne Anmeldung erreichbar?
// ---------------------------------------------------------------------------

async function schnittstellen() {
  const { ROUTES } = await import('./openapi-routes');
  const liste = json<{ endpunkte: { weg: string; begruendung: string }[] }>('security/oeffentliche-endpunkte.json').endpunkte;
  const erlaubt = new Map(liste.map((e) => [e.weg, e.begruendung]));
  const befunde: Befund[] = [];
  const offen = ROUTES.filter((r) => r.guard.kind === 'public' || r.guard.kind === 'cron');
  for (const r of offen) {
    const weg = `${r.method.toUpperCase()} ${r.path}`;
    if (!erlaubt.has(weg)) befunde.push({ schwere: 'blockierend', titel: `Öffentlicher Endpunkt ohne Durchsicht: ${weg}`, details: 'In security/oeffentliche-endpunkte.json mit Begründung aufnehmen — oder schützen.' });
  }
  const vorhanden = new Set(offen.map((r) => `${r.method.toUpperCase()} ${r.path}`));
  for (const e of liste) if (!vorhanden.has(e.weg)) befunde.push({ schwere: 'hinweis', titel: `Eintrag ohne Endpunkt (entfernen): ${e.weg}` });
  for (const r of ROUTES) {
    if (r.guard.kind === 'session' && r.method !== 'get') befunde.push({ schwere: 'hinweis', titel: `Schreibender Endpunkt nur mit Sitzung, ohne Recht: ${r.method.toUpperCase()} ${r.path}` });
  }
  // Das Kontingent je Endpunkt prüft die Musterregel `rate-limit-fehlt` im
  // Quelltext — nicht die Registry: Sie muss den Schutz spiegeln (das prüft
  // `npm run openapi`), das Kontingent nicht, und eine Prüfung gegen sie
  // meldete Endpunkte, die längst eines haben.
  return { status: statusAus(befunde), befunde, hinweis: `${ROUTES.length} Endpunkte, davon ${offen.length} ohne Anmeldung oder mit Maschinentoken.` };
}

// ---------------------------------------------------------------------------
//  6. Repository
// ---------------------------------------------------------------------------

function repository() {
  const git = gitFinden();
  let dateien: string[];
  let quelle: string;
  if (git) {
    const r = spawnSync(git, ['ls-files', '-z'], { cwd: WURZEL, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    dateien = r.stdout.split('\0').filter(Boolean);
    quelle = 'verfolgter Bestand (git ls-files)';
  } else {
    dateien = [];
    const gehe = (rel: string) => {
      for (const n of readdirSync(join(WURZEL, rel))) {
        if (['node_modules', '.git', 'test-results', 'security-reports'].includes(n) || n.startsWith('.next')) continue;
        const p = rel ? `${rel}/${n}` : n;
        if (statSync(join(WURZEL, p)).isDirectory()) gehe(p);
        else dateien.push(p);
      }
    };
    gehe('');
    quelle = 'Arbeitsbaum (kein git gefunden)';
  }
  const befunde: Befund[] = [];
  for (const d of dateien) {
    const name = d.split('/').pop() ?? d;
    if (/^\.env(\..+)?$/.test(name) && name !== '.env.example') befunde.push({ schwere: 'blockierend', titel: 'Umgebungsdatei im Bestand', ort: d });
    else if (/\.(pem|key|p12|pfx|jks|keystore)$/i.test(name) || /^id_(rsa|ed25519|ecdsa)/.test(name)) befunde.push({ schwere: 'blockierend', titel: 'Schlüsseldatei im Bestand', ort: d });
    else if (/\.(sqlite|db|dump|bak)$/i.test(name) || (/\.sql$/i.test(name) && !d.startsWith('prisma/migrations/'))) befunde.push({ schwere: 'warnung', titel: 'Datenbankabzug oder SQL ausserhalb der Migrationen', ort: d });
    try {
      const groesse = statSync(join(WURZEL, d)).size;
      if (groesse > 5 * 1024 * 1024) befunde.push({ schwere: 'warnung', titel: `Grosse Datei (${Math.round(groesse / 1024 / 1024)} MB)`, ort: d });
    } catch {
      // im Index, aber nicht im Arbeitsbaum — hier ohne Belang
    }
  }
  if (!existsSync(join(WURZEL, 'package-lock.json'))) befunde.push({ schwere: 'blockierend', titel: 'package-lock.json fehlt — Installation nicht reproduzierbar' });
  const ignoriert = existsSync(join(WURZEL, '.gitignore')) ? readFileSync(join(WURZEL, '.gitignore'), 'utf8') : '';
  if (!/^\.env/m.test(ignoriert)) befunde.push({ schwere: 'blockierend', titel: '.gitignore schliesst .env nicht aus' });
  return { status: statusAus(befunde), befunde, hinweis: `${dateien.length} Dateien, ${quelle}.` };
}

// ---------------------------------------------------------------------------
//  7. Sicherheitsreihen der Prüfreihe (nur mit --mit-tests)
// ---------------------------------------------------------------------------

const SICHERHEITSREIHEN = [
  'rbac',
  'ownership',
  'mandanten',
  'zugriffstokens',
  'oeffentlicher-zugang',
  'oeffentliche-links',
  'dateisicherheit',
  'datei-zugriff',
  'auslieferung-absicherung',
  'protokoll-schwaerzung',
  'protokoll-und-schranken',
  'session-refresh',
  'scan-kennung',
  'scan',
  'suche',
  'sicherheitszentrum',
];

async function pruefreihe() {
  const basis = process.env.TEST_BASE_URL;
  if (!basis) return { status: 'NICHT_GEPRUEFT' as const, befunde: [], hinweis: 'TEST_BASE_URL fehlt (braucht `npm run test:server`).' };
  try {
    await fetch(`${basis}/api/auth/session`, { signal: AbortSignal.timeout(5000) });
  } catch {
    return { status: 'NICHT_GEPRUEFT' as const, befunde: [], hinweis: `Kein Testserver unter ${basis}.` };
  }
  /*
    N-08 (2026-09-27): Bis hierher filterte `existsSync` fehlende Reihen still
    heraus, und gezählt wurden nur `# pass` und `# fail`. Eine umbenannte
    Mandantenreihe fiel damit aus dem Lauf, und ein Fall, der sich mit
    `t.skip()` verabschiedete, zählte wie ein bestandener. Jetzt ist eine
    konfigurierte, aber fehlende Datei ein blockierender Befund, und die Bilanz
    (übersprungen, todo, abgebrochen, fehlende Zusammenfassung) entscheidet
    nach denselben Regeln wie `verify.ts` — `scripts/security/testbilanz.ts`.
  */
  const { vorhanden, fehlend } = konfigurierteDateien(WURZEL, SICHERHEITSREIHEN.map((n) => `tests/api/${n}.test.ts`));
  const befunde: Befund[] = fehlend.map((d) => ({
    schwere: 'blockierend' as const,
    titel: 'Konfigurierte Sicherheitsreihe fehlt',
    ort: d,
    details: 'Datei wiederherstellen oder SICHERHEITSREIHEN in scripts/security-check.ts bewusst anpassen.',
  }));
  if (vorhanden.length === 0) return { status: statusAus(befunde), befunde, hinweis: 'Keine der konfigurierten Reihen ist vorhanden.' };

  // Der Bericht wird ausdrücklich gewählt: Die Vorgabe hängt von der
  // Node-Fassung und davon ab, ob die Ausgabe ein Terminal ist.
  const r = ausfuehren('npx', ['tsx', '--test', '--test-concurrency=1', '--test-reporter=tap', ...vorhanden], { zeitMs: 600_000 });
  const bilanz = testbilanzLesen(r.stdout);
  for (const grund of bilanzPruefen(bilanz)) {
    befunde.push({
      schwere: 'blockierend',
      titel: `Sicherheitsreihen: ${grund}`.slice(0, 300),
      details: r.stdout.split('\n').filter((z) => /not ok|# SKIP|# TODO/i.test(z)).slice(0, 15).join('\n'),
    });
  }
  if (r.code !== 0 && bilanz.gescheitert === 0 && bilanz.gefunden) {
    befunde.push({ schwere: 'blockierend', titel: `Testlauf endete mit Exitcode ${r.code ?? 'unbekannt'} ohne gescheiterten Fall`, details: (r.stderr || '').slice(-800) });
  }
  return {
    status: statusAus(befunde),
    befunde,
    hinweis: `${vorhanden.length} von ${SICHERHEITSREIHEN.length} Reihen, ${bilanz.bestanden} bestanden, ${bilanz.gescheitert} gescheitert, ${bilanz.uebersprungen} übersprungen.`,
  };
}

// ---------------------------------------------------------------------------
//  Lauf
// ---------------------------------------------------------------------------

const ZEICHEN: Record<Status, string> = { BESTANDEN: '✓', BEFUND: '✗', NICHT_GEPRUEFT: '○', FEHLER: '!' };

async function main() {
  console.log(`\n  Sicherheitsprüfung (Umfang: ${UMFANG}) — docs/SECURITY_STANDARD.md, docs/SECURITY_AUTOMATION.md\n`);
  const pruefungen: Pruefung[] = [];
  if (MIT_STATISCH) {
    pruefungen.push(
      await pruefung('geheimnisse', 'Geheimnisse im Bestand', geheimnisse),
      await pruefung('abhaengigkeiten', 'Abhängigkeiten (npm audit, Laufzeit)', abhaengigkeiten),
      await pruefung('muster', 'Musterprüfung (Durchsichtsanlässe)', muster),
      await pruefung('migrationen', 'Migrationen, Schema, Datenbankschranken', migrationen),
      await pruefung('schnittstellen', 'Öffentliche Endpunkte und Schutzdeklaration', schnittstellen),
      await pruefung('repository', 'Repository (verbotene Dateien, Lockfile)', repository),
    );
  }
  if (MIT_TESTS) pruefungen.push(await pruefung('pruefreihe', 'Sicherheitsreihen der Prüfreihe', pruefreihe));

  for (const p of pruefungen) {
    const blockierend = p.befunde.filter((b) => b.schwere === 'blockierend').length;
    const warnung = p.befunde.filter((b) => b.schwere === 'warnung').length;
    const hinweise = p.befunde.filter((b) => b.schwere === 'hinweis').length;
    const status = p.status === 'NICHT_GEPRUEFT' ? 'NICHT GEPRÜFT' : p.status;
    console.log(`  ${ZEICHEN[p.status]} ${p.titel.padEnd(48)} ${status.padEnd(14)} ${blockierend} blockierend · ${warnung} Warnung · ${hinweise} Hinweis  (${(p.dauerMs / 1000).toFixed(1)} s)`);
    if (p.hinweis) console.log(`      ${p.hinweis}`);
    for (const b of p.befunde.filter((x) => x.schwere !== 'hinweis').slice(0, 25)) {
      console.log(`      ${b.schwere === 'blockierend' ? '✗' : '!'} ${b.titel}${b.ort ? `  — ${b.ort}` : ''}`);
      if (b.details) console.log(`        ${b.details.split('\n')[0]!.slice(0, 200)}`);
    }
  }

  const blockiert = pruefungen.some((p) => p.status === 'FEHLER' || p.befunde.some((b) => b.schwere === 'blockierend'));
  const ungeprueft = pruefungen.filter((p) => p.status === 'NICHT_GEPRUEFT');
  // NICHT GEPRÜFT innerhalb des Umfangs ist ein Fehlschlag (siehe UMFANG) und
  // steht im Gesamtstatus deshalb vor der Warnung.
  const gesamt: Meldung['status'] = blockiert ? 'KRITISCH' : ungeprueft.length ? 'NICHT_GEPRUEFT' : pruefungen.some((p) => p.befunde.some((b) => b.schwere === 'warnung')) ? 'WARNUNG' : 'OK';

  const bericht = {
    quelle: 'SECURITY_CHECK' as const,
    status: gesamt,
    version: process.env.npm_package_version,
    erstelltAm: new Date().toISOString(),
    zusammenfassung:
      `${pruefungen.filter((p) => p.status === 'BESTANDEN').length} bestanden, ${pruefungen.filter((p) => p.status === 'BEFUND').length} mit Befund, ` +
      `${ungeprueft.length} nicht geprüft (${ungeprueft.map((p) => p.id).join(', ') || '—'}), ${pruefungen.filter((p) => p.status === 'FEHLER').length} Fehler.`,
    pruefungen: pruefungen.map((p) => ({ id: p.id, titel: p.titel, status: p.status, befunde: p.befunde.filter((b) => b.schwere !== 'hinweis').length })),
    befunde: pruefungen
      .flatMap((p) => p.befunde.map((b) => ({ ...b, pruefung: p.id })))
      .filter((b) => b.schwere !== 'hinweis' || b.pruefung === 'abhaengigkeiten')
      .slice(0, 200)
      .map((b) => ({
        id: b.id?.slice(0, 120),
        titel: b.titel.slice(0, 300),
        schwere: b.schwere === 'blockierend' ? ('hoch' as const) : b.schwere === 'warnung' ? ('mittel' as const) : ('info' as const),
        ort: b.ort?.slice(0, 300),
        details: b.details?.slice(0, 1000),
      })),
    kennzahlen: {} as Record<string, number | string | boolean>,
  };

  const ordner = join(WURZEL, 'security-reports');
  mkdirSync(ordner, { recursive: true });
  const stempel = bericht.erstelltAm.replace(/[:.]/g, '-');
  writeFileSync(join(ordner, `security-check-${stempel}.json`), `${JSON.stringify({ ...bericht, einzelheiten: pruefungen }, null, 2)}\n`);
  writeFileSync(join(ordner, 'letzter-lauf.json'), `${JSON.stringify(bericht, null, 2)}\n`);

  console.log(`\n  Gesamt: ${gesamt} (Umfang ${UMFANG}, ${pruefungen.length} Prüfungen). Bericht: security-reports/security-check-${stempel}.json`);
  if (ungeprueft.length) console.log(`  Nicht geprüft ist nicht bestanden — Lauf gescheitert: ${ungeprueft.map((p) => p.titel).join('; ')}.`);

  if (args.has('--melden')) await melden(bericht, (z) => console.log(`  ${z}`));

  process.exitCode = blockiert || ungeprueft.length > 0 ? 1 : 0;
}

void main();
