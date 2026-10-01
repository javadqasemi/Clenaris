import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadEnvConfig } from '@next/env';

import {
  KonfigurationsFehler,
  oeffentlicheKonfigurationAus,
  PublicRuntimeConfigSchema,
  ursprungAus,
  type Umgebung,
} from '../../src/lib/laufzeit-konfiguration';
import { databaseNameOf, istTestdatenbank } from '../../prisma/seed-guard';
import { BASE_URL, get, requireServer } from '../helpers/client';
import {
  instanzDiagnose,
  lokalerPortAus,
  phaseAus,
  startfehlerAus,
  zeilenSammler,
  type AnfrageOptionen,
  type Antwort,
} from '../helpers/instanz-diagnose';
import { PRUEF_RESEND_GEHEIMNIS, PRUEF_SICHERHEITSBERICHT_TOKEN } from '../helpers/webhooks';
import { testDb, testDbSchliessen } from '../helpers/testdb';

/**
 * Laufzeitkonfiguration (V2-1, 2026-09-26).
 *
 * Drei Ebenen, weil jede eine andere Frage beantwortet:
 *
 *  1. **Rein** — `oeffentlicheKonfigurationAus` mit einer Umgebung voller
 *     Geheimnisse: Kommt nur heraus, was das Schema nennt? Schlägt eine
 *     ungültige Konfiguration geschlossen fehl? Das geht ohne Server und
 *     prüft die Regel dort, wo sie steht (wie `bi-rechenkerne.test.ts`).
 *  2. **Über HTTP** gegen den laufenden Testserver: Liefert der Endpunkt
 *     genau diese Form, und kann eine Anfrage die Herkunft verschieben?
 *  3. **Dasselbe Artefakt, zwei Umgebungen** — der eigentliche Beweis für
 *     V2-1. Aus **einem** vorhandenen Bau werden zwei `next start` mit
 *     verschiedener `APP_URL` und verschiedenen Analyse-Kennungen gestartet,
 *     ohne Neubau. Stünde irgendwo noch ein beim Bau eingesetzter Wert,
 *     antworteten beide gleich. Geprüft wird an drei Stellen, die vorher
 *     festsassen: Browser-Konfiguration, Herkunftsprüfung und ein
 *     tatsächlich versendeter Link (`absoluteUrl` im Postausgang). Seit
 *     2026-09-30 dazu der Schalter der Besuchsmessung: A misst, B nicht, und
 *     B speichert nichts.
 *
 * Ebene 3 überspringt sich örtlich, wenn kein Bau oder keine Testdatenbank
 * da ist — im CI (`CI` gesetzt) scheitert sie stattdessen: Dort ist sie der
 * Nachweis, und ein übersprungener Nachweis ist keiner.
 *
 * Eine Ausnahme, mit Absicht: „Instanz mit ausgeschalteter Besuchsmessung
 * speichert nichts" (2026-09-30) überspringt sich auch örtlich nie. Neue
 * Fälle fallen unter das Null-Übersprung-Tor des Prüfwegs; ein weiterer
 * bedingter Übersprung hätte es geschwächt, und der Schalter wäre gerade
 * dort unbelegt geblieben, wo er zählt. Wer die Datei örtlich gegen
 * `npm run dev` oder ohne `clenaris_test` laufen lässt, sieht diesen einen
 * Fall deshalb rot, mit dem Grund in der Meldung — das ist die fehlende
 * Voraussetzung, kein Fehler des Produkts.
 */

// Werte, die in keiner Antwort auftauchen dürfen. Jeder ist eindeutig genug,
// dass ein Treffer kein Zufall sein kann.
//
// Die Formen sind so gewählt, dass die Geheimnisprüfung
// (`scripts/ci-secret-scan.sh`) sie zu Recht **nicht** für echte hält: Die
// Datenbankadressen zeigen auf `.invalid` (reserviert, nie auflösbar — die
// dort dokumentierte Ausnahme), die Anbietermarker sind kürzer als echte
// Schlüssel. Ein erster Entwurf mit einem gewöhnlichen Hostnamen und einem
// `NEXT_PUBLIC_…SECRET` hielt den CI-Lauf 36277056624 an — richtig so: Aus
// einer eingecheckten Datei heraus ist ein Marker von einem Geheimnis nicht
// zu unterscheiden, also muss er anders aussehen.
const MARKER = {
  DATABASE_URL: 'postgresql://marker-db-user:marker-db-passwort@marker-db-host.invalid:5432/marker_test',
  DIRECT_URL: 'postgresql://marker-direct:marker-direct-passwort@marker-db-host.invalid:5432/marker_test',
  JWT_SECRET: 'marker-jwt-geheimnis-0123456789abcdef0123456789abcdef',
  CRON_SECRET: 'marker-cron-geheimnis-0123456789abcdef',
  ENCRYPTION_KEY: 'deadbeef'.repeat(8),
  STRIPE_SECRET_KEY: 'sk_live_marker0123456789',
  STRIPE_WEBHOOK_SECRET: 'whsec_marker0123456789',
  SUPABASE_SERVICE_ROLE_KEY: 'marker-supabase-service-role',
  ANTHROPIC_API_KEY: 'sk-ant-marker-0123456789',
  RESEND_API_KEY: 're_marker0123456789',
  TWILIO_AUTH_TOKEN: 'marker-twilio-token',
  SECURITY_REPORT_TOKEN: 'marker-sicherheitsbericht-token',
  RELEASE_EXECUTOR_TOKEN: 'marker-release-ausfuehrer-token',
  RELEASE_EXECUTOR_SIGNING_KEY: 'marker-release-ausfuehrer-signatur',
  SSH_PRIVATE_KEY: 'marker-ssh-privat',
  SENTRY_AUTH_TOKEN: 'marker-monitoring-token',
  GOOGLE_MAPS_SERVER_KEY: 'marker-maps-server',
  // Öffentlich benannt, aber nicht freigegeben: Auch ein `NEXT_PUBLIC_`-Name
  // reicht nicht, um in die Browser-Konfiguration zu gelangen.
  NEXT_PUBLIC_NICHT_FREIGEGEBEN: 'marker-oeffentlich-benannt',
  NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: 'marker-maps-browser',
  NEXT_PUBLIC_SUPABASE_URL: 'https://marker-supabase.example',
} as const;

const MARKERWERTE = Object.values(MARKER);

function ohneMarker(text: string, wo: string, zusaetzlich: string[] = []): void {
  for (const wert of [...MARKERWERTE, ...zusaetzlich]) {
    assert.ok(!text.includes(wert), `${wo} enthält einen Wert aus der Server-Umgebung: ${wert.slice(0, 12)}…`);
  }
}

describe('Laufzeitkonfiguration: Freigabeliste und Geheimnisse (rein)', () => {
  const basis: Umgebung = {
    ...MARKER,
    NODE_ENV: 'production',
    APP_URL: 'https://a.clenaris.example',
    NEXT_PUBLIC_GA_MEASUREMENT_ID: 'G-ABC1234',
    NEXT_PUBLIC_GTM_ID: 'GTM-XYZ123',
    NEXT_PUBLIC_FACEBOOK_PIXEL_ID: '1234567890',
  };

  it('liefert genau die freigegebenen Felder — nichts aus der übrigen Umgebung', () => {
    const konfiguration = oeffentlicheKonfigurationAus(basis);
    assert.deepEqual(Object.keys(konfiguration).sort(), ['analytics', 'appUrl', 'besuchsmessung']);
    assert.deepEqual(Object.keys(konfiguration.analytics).sort(), ['facebookPixelId', 'gaMeasurementId', 'gtmId']);
    // `besuchsmessung` (2026-09-30): ohne `CLENARIS_BESUCHSMESSUNG=an` aus.
    assert.deepEqual(konfiguration, {
      appUrl: 'https://a.clenaris.example',
      analytics: { gaMeasurementId: 'G-ABC1234', gtmId: 'GTM-XYZ123', facebookPixelId: '1234567890' },
      besuchsmessung: false,
    });
    assert.equal(oeffentlicheKonfigurationAus({ ...basis, CLENARIS_BESUCHSMESSUNG: 'an' }).besuchsmessung, true);
    ohneMarker(JSON.stringify(konfiguration), 'Die Browser-Konfiguration');
  });

  it('das Schema lehnt jedes weitere Feld ab — auch eines, das jemand später dazuschreibt', () => {
    // Die Grundform ist gültig: Sonst scheiterten die beiden Fälle unten an
    // einem fehlenden Pflichtfeld (`besuchsmessung`) statt am zusätzlichen —
    // und bewiesen nichts mehr über die Freigabeliste.
    const gueltig = { appUrl: 'https://a.clenaris.example', analytics: {}, besuchsmessung: false };
    assert.equal(PublicRuntimeConfigSchema.safeParse(gueltig).success, true);
    const erweitert = { ...gueltig, jwtSecret: MARKER.JWT_SECRET };
    assert.equal(PublicRuntimeConfigSchema.safeParse(erweitert).success, false);
    const verschachtelt = { ...gueltig, analytics: { databaseUrl: MARKER.DATABASE_URL } };
    assert.equal(PublicRuntimeConfigSchema.safeParse(verschachtelt).success, false);
  });

  it('eine ungültige Analyse-Kennung fällt weg, statt in ein Skript zu geraten', () => {
    const konfiguration = oeffentlicheKonfigurationAus({
      ...basis,
      NEXT_PUBLIC_GA_MEASUREMENT_ID: "G-ABC');alert(1);//",
      NEXT_PUBLIC_GTM_ID: 'GTM-<script>',
      NEXT_PUBLIC_FACEBOOK_PIXEL_ID: '12345"',
    });
    // Über JSON verglichen: So sieht es der Browser, und Zod lässt die
    // weggefallenen Felder als `undefined` stehen.
    assert.deepEqual(JSON.parse(JSON.stringify(konfiguration.analytics)), {});
  });

  it('eine ungültige Herkunft schlägt geschlossen fehl', () => {
    for (const falsch of [
      'javascript:alert(1)',
      'ftp://a.clenaris.example',
      'https://nutzer:passwort@a.clenaris.example',
      'https://a.clenaris.example/pfad',
      'https://a.clenaris.example/?x=1',
      'https://a.clenaris.example/#anker',
      'keine adresse',
    ]) {
      assert.throws(() => ursprungAus({ APP_URL: falsch }), KonfigurationsFehler, falsch);
      assert.throws(() => oeffentlicheKonfigurationAus({ ...basis, APP_URL: falsch }), KonfigurationsFehler, falsch);
    }
  });

  it('ohne APP_URL verweigert die Produktion — ausserhalb gilt localhost', () => {
    assert.throws(() => ursprungAus({ NODE_ENV: 'production' }), KonfigurationsFehler);
    assert.equal(ursprungAus({ NODE_ENV: 'development' }), 'http://localhost:3000');
  });

  it('APP_URL geht dem älteren NEXT_PUBLIC_APP_URL vor, und nur die Herkunft bleibt', () => {
    assert.equal(ursprungAus({ APP_URL: 'https://neu.example/', NEXT_PUBLIC_APP_URL: 'https://alt.example' }), 'https://neu.example');
    assert.equal(ursprungAus({ NEXT_PUBLIC_APP_URL: 'https://alt.example:8443' }), 'https://alt.example:8443');
  });
});

describe('Laufzeitkonfiguration über HTTP', () => {
  before(requireServer);

  it('GET /api/public/runtime-config liefert nur die Freigabeliste, ungespeichert', async () => {
    const antwort = await get<{ data: unknown }>('/api/public/runtime-config');
    assert.equal(antwort.status, 200);
    const geprueft = PublicRuntimeConfigSchema.safeParse(antwort.payload.data);
    assert.ok(geprueft.success, `Antwort ausserhalb des Schemas: ${antwort.text}`);
    assert.match(antwort.headers.get('cache-control') ?? '', /no-cache|no-store/);
    // Die zwei Geheimnisse, die dem Testserver sicher bekannt sind.
    assert.ok(!antwort.text.includes(PRUEF_RESEND_GEHEIMNIS));
    assert.ok(!antwort.text.includes(PRUEF_SICHERHEITSBERICHT_TOKEN));
    for (const name of ['DATABASE_URL', 'JWT_SECRET', 'CRON_SECRET']) {
      const wert = process.env[name];
      if (wert) assert.ok(!antwort.text.includes(wert), `${name} steht in der Antwort`);
    }
  });

  it('keine Anfrage verschiebt die Herkunft — weder Kopfzeilen noch Abfrage', async () => {
    const normal = await get<{ data: { appUrl: string } }>('/api/public/runtime-config');
    const versucht = await get<{ data: { appUrl: string } }>('/api/public/runtime-config?appUrl=https://boese.example&APP_URL=https://boese.example', {
      headers: {
        'x-forwarded-host': 'boese.example',
        'x-forwarded-proto': 'https',
        origin: 'https://boese.example',
        forwarded: 'host=boese.example;proto=https',
      },
    });
    assert.equal(versucht.status, 200);
    assert.equal(versucht.payload.data.appUrl, normal.payload.data.appUrl);
    assert.ok(!versucht.text.includes('boese.example'));
  });

  it('ein übergeschobenes X-Forwarded-Host macht eine fremde Herkunft nicht vertrauenswürdig', async () => {
    // Der Testserver läuft mit TRUSTED_PROXY_MODE=NONE: Den Kopf setzt dann
    // nur der Aufrufer, und er darf die Herkunftsprüfung nicht erweitern.
    const antwort = await fetch(`${BASE_URL}/api/auth/logout`, {
      method: 'POST',
      headers: { origin: 'https://boese.example', 'x-forwarded-host': 'boese.example' },
    });
    assert.equal(antwort.status, 403);
  });
});

// ---------------------------------------------------------------------------
//  Dasselbe Artefakt, zwei Laufzeitumgebungen
// ---------------------------------------------------------------------------

const IM_CI = Boolean(process.env.CI);
const WURZEL = join(__dirname, '..', '..');
const DIST = process.env.NEXT_DIST_DIR?.trim() || '.next';

interface Instanz {
  name: 'A' | 'B';
  appUrl: string;
  ga: string;
  gtm: string;
  port: number;
  cacheDir: string;
  prozess: ChildProcess;
}

/**
 * Zeitleiste, Phasen jeder Anfrage und ein Abzug bei jedem Fehlschlag (W-11).
 * Was erhoben wird und warum, steht in `tests/helpers/instanz-diagnose.ts`.
 */
const w11 = instanzDiagnose('W-11');

/** Die Testdatenbank für die beiden Instanzen — nie eine andere. */
function testdatenbankAdresse(): string | null {
  if (!process.env.DATABASE_URL && !process.env.TEST_DATABASE_URL) loadEnvConfig(WURZEL, false, { info: () => {}, error: () => {} });
  const explizit = process.env.TEST_DATABASE_URL;
  const roh = explizit ?? process.env.DATABASE_URL;
  if (!roh) return null;
  let adresse = roh;
  if (!explizit) {
    const url = new URL(roh);
    const name = url.pathname.replace(/^\//, '');
    if (!name.endsWith('_test')) url.pathname = `/${name}_test`;
    adresse = url.toString();
  }
  return istTestdatenbank(databaseNameOf(adresse)) ? adresse : null;
}

function bauVollstaendig(): boolean {
  return ['BUILD_ID', 'routes-manifest.json', 'prerender-manifest.json'].every((d) => existsSync(join(WURZEL, DIST, d)));
}

async function starten(name: 'A' | 'B', appUrl: string, ga: string, gtm: string, datenbank: string): Promise<Instanz> {
  const cacheDir = mkdtempSync(join(tmpdir(), `clenaris-artefakt-${name.toLowerCase()}-`));
  // `next start` aus dem vorhandenen Bau — kein `build`, kein `npm`, keine
  // Korrektur. Die Umgebung ist vollständig benannt: die Instanzwerte, die
  // Marker-Geheimnisse (die nirgends auftauchen dürfen) und die
  // Testdatenbank. Ein leerer Resend-Schlüssel hält den Postausgang aktiv.
  //
  // `-p 0` (W-11, 2026-10-01): Den Port wählt das Betriebssystem beim Binden,
  // und die Instanz nennt ihn selbst in ihrer „Local:"-Zeile
  // (`w11.startBegleiten`). Vorher wählte die Prüfung ihn vorab — Port 0
  // binden, Port merken, wieder schliessen, dann `next start -p <port>`.
  // Zwischen dem Schliessen und dem Binden durch Next liegen Sekunden, in
  // denen das Betriebssystem denselben Port jeder anderen Verbindung geben
  // kann (Quellports ausgehender Verbindungen stammen aus demselben Bereich,
  // und in einem vollen Lauf öffnen Testserver und Prüfreihe laufend welche);
  // dann scheiterte der Start mit EADDRINUSE. Mit `-p 0` gibt es dieses
  // Zeitfenster nicht mehr. Das erklärt ein Scheitern beim Start, nicht das
  // beobachtete Hängen einer Anfrage an eine bereite Instanz — es ist eine
  // Fehlerquelle weniger, kein Nachweis der Ursache. Next 15.5 lässt 0 zu
  // (`parseValidPositiveInteger` weist nur negative Werte ab) und setzt
  // `PORT` nach dem Binden auf den echten Port.
  const prozess = spawn(process.execPath, [join(WURZEL, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', '0', '-H', '127.0.0.1'], {
    cwd: WURZEL,
    env: {
      ...process.env,
      ...MARKER,
      NODE_ENV: 'production',
      NEXT_DIST_DIR: DIST,
      DATABASE_URL: datenbank,
      DIRECT_URL: datenbank,
      APP_URL: appUrl,
      NEXT_PUBLIC_APP_URL: '',
      NEXT_PUBLIC_GA_MEASUREMENT_ID: ga,
      NEXT_PUBLIC_GTM_ID: gtm,
      NEXT_PUBLIC_FACEBOOK_PIXEL_ID: '',
      TRUSTED_PROXY_MODE: 'NONE',
      CLENARIS_TEST_CACHE_DIR: cacheDir,
      // Eigener `application_name` je Instanz (`pg` liest `PGAPPNAME`), damit
      // der W-11-Abzug ihre Datenbankverbindungen in `pg_stat_activity`
      // auseinanderhalten kann — die Anwendung selbst setzt keinen.
      PGAPPNAME: `clenaris-w11-${name.toLowerCase()}`,
      // Leer statt weggelassen: `next start` liest die `.env` nach, aber nur
      // für Namen, die in der Umgebung noch gar nicht vorkommen. Ein leerer
      // Wert schaltet die Integration ab (`hasIntegration` prüft Boolean) —
      // Resend aus hält den Postausgang aktiv, ohne Supabase-Adresse bleibt
      // der Dienstschlüssel-Marker wirkungslos, ohne Redis zählt die Datei.
      RESEND_API_KEY: '',
      NEXT_PUBLIC_SUPABASE_URL: '',
      REDIS_URL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Dieselbe Frist wie vorher (90 s), dieselbe Bereitschaftsprobe
  // (`/api/public/runtime-config` mit 200); die Ausgabe liest jetzt die
  // Diagnose — mit Zeitstempel je Zeile und bis zum Ende der Instanz.
  const port = await w11.startBegleiten(name, prozess, { datenbank, fristMs: 90_000 }).catch((fehler: Error) => {
    prozess.kill();
    throw fehler;
  });
  return { name, appUrl, ga, gtm, port, cacheDir, prozess };
}

/**
 * Eine Anfrage an eine der beiden Instanzen — über eine **neue** Verbindung
 * (`agent: false`, Begründung bei `rohAnfrage` in
 * `tests/helpers/instanz-diagnose.ts`), mit derselben Zeitgrenze von 30
 * Sekunden wie bisher. Neu ist allein die Beobachtung: Phasen, Wächter mit
 * Proben, Abzug bei einem Fehlschlag (W-11). Das Ergebnis eines Falls ändert
 * sie nicht.
 */
function anfrage(port: number, pfad: string, optionen: AnfrageOptionen = {}): Promise<Antwort> {
  return w11.anfrage(port, pfad, optionen);
}

/**
 * Eine Instanz beenden — erst, wenn offene Beinahe-Abzüge fertig sind
 * (W-11). Deren Proben gehen an genau diese Instanz; beendete der Abbau sie
 * vorher, stünde im Abzug „Probe gescheitert", und er behauptete ein Hängen,
 * das nur der Abbau verursacht hat. Das Warten ist durch die Fristen des
 * Wächters begrenzt und dauert ohne Beinahe-Fall keinen Augenblick.
 */
async function beenden(instanz: Instanz | undefined): Promise<void> {
  await w11.abzuegeAbwarten();
  if (!instanz || instanz.prozess.exitCode !== null) return;
  await new Promise<void>((ok) => {
    instanz.prozess.once('exit', () => ok());
    instanz.prozess.kill();
    setTimeout(ok, 5_000);
  });
}

function mailsIn(cacheDir: string): Array<{ to: string[]; html: string; text: string }> {
  const ordner = join(cacheDir, 'mail');
  if (!existsSync(ordner)) return [];
  return readdirSync(ordner)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(ordner, f), 'utf8')) as { to: string[]; html: string; text: string });
}

/**
 * Die Bausteine, mit denen die Prüfinstanzen ihren Port nennen und eine
 * hängende Anfrage eingeordnet wird (W-11) — ohne Server und ohne Bau.
 *
 * Sie laufen in jedem Lauf, auch örtlich ohne Bau, wo die Gruppe darunter
 * sich überspringt: Liest der Start den Port falsch, scheitert dort jeder
 * Fall mit „kam nicht hoch", und der Grund wäre dann erst im CI zu sehen.
 * Die Zeilen sind die wörtliche Ausgabe von `next start` 15.5.26
 * (`logStartInfo` → `bootstrap`: drei Leerzeichen, dann „- Local:" mit acht
 * Leerzeichen Abstand).
 */
describe('Prüfinstanzen: Port aus der Startausgabe und Einordnung einer Anfrage (rein)', () => {
  it('liest den gebundenen Port aus der „Local:"-Zeile, nicht aus „Network:"', () => {
    assert.equal(lokalerPortAus('   - Local:        http://127.0.0.1:53124'), 53124);
    assert.equal(lokalerPortAus(`${String.fromCharCode(27)}[1m   - Local:        http://127.0.0.1:53124${String.fromCharCode(27)}[22m`), 53124);
    assert.equal(lokalerPortAus('   - Local:        http://localhost:3000'), 3000);
    assert.equal(lokalerPortAus('   - Local:        http://[::1]:4100'), 4100);
    assert.equal(lokalerPortAus('   - Network:      http://127.0.0.1:53124'), null);
    assert.equal(lokalerPortAus('   - Local:        http://127.0.0.1:0'), null, 'Port 0 ist nie der gebundene Port');
    assert.equal(lokalerPortAus('   - Local:        http://127.0.0.1:123456'), null);
    assert.equal(lokalerPortAus(' ✓ Ready in 812ms'), null);
  });

  it('setzt eine über mehrere Datenblöcke verteilte Zeile wieder zusammen', () => {
    const zeilen: string[] = [];
    const sammler = zeilenSammler((zeile) => zeilen.push(zeile));
    for (const block of ['   ▲ Next.js 15.5.26\n   - Loc', 'al:        http://127.0.0.1:5', '3124\r\n   - Network:', '      http://127.0.0.1:53124\n', ' ✓ Ready']) {
      sammler.aufnehmen(block);
    }
    assert.deepEqual(
      zeilen.map(lokalerPortAus).filter((port) => port !== null),
      [53124],
    );
    assert.equal(zeilen.length, 3, 'die unvollständige letzte Zeile wartet auf ihr Ende');
    sammler.abschliessen();
    assert.equal(zeilen.at(-1), ' ✓ Ready');
  });

  it('benennt einen Startfehler, statt erst nach der Frist „kam nicht hoch" zu melden', () => {
    assert.match(startfehlerAus('Error: listen EADDRINUSE: address already in use 127.0.0.1:3001') ?? '', /belegt \(EADDRINUSE\)/);
    assert.match(startfehlerAus(' ⨯ Failed to start server') ?? '', /Failed to start server/);
    assert.equal(startfehlerAus('   ✓ Ready in 812ms'), null);
    assert.equal(startfehlerAus('   - Local:        http://127.0.0.1:53124'), null);
  });

  it('ordnet eine Anfrage der letzten erreichten Phase zu', () => {
    assert.equal(phaseAus({}), 'verbinden');
    assert.equal(phaseAus({ verbundenMs: 1 }), 'senden');
    assert.equal(phaseAus({ verbundenMs: 1, gesendetMs: 2 }), 'antwort-abwarten');
    assert.equal(phaseAus({ verbundenMs: 1, gesendetMs: 2, kopfMs: 3 }), 'rumpf-lesen');
    assert.equal(phaseAus({ verbundenMs: 1, gesendetMs: 2, kopfMs: 3, endeMs: 4 }), 'fertig');
  });

  /**
   * Begleitung, Wächter und Abzug — an einem Stellvertreterprozess statt an
   * `next start` (2026-10-01).
   *
   * Bis hierher waren nur die vier reinen Bausteine oben eingecheckt
   * geprüft. Der Weg, der sie verbindet — Port aus der Ausgabe eines echten
   * Kindprozesses, früher Abbruch bei einem Startfehler, Abzug beim
   * Scheitern, Wächterzeile bei einem Beinahe-Fall —, lief nur in
   * Notizskripten. Ein Fehler darin hätte sich erst als undurchsichtiges
   * Scheitern der Zwei-Instanzen-Gruppe im vollen Lauf gezeigt, oder gar
   * nicht: Ein Beinahe-Fall ohne Zeile und ohne Datei sieht aus wie ein
   * ruhiger Lauf.
   *
   * Der Stellvertreter ist ein kleiner HTTP-Server in einem eigenen
   * Node-Prozess (`process.execPath -e`), der seine „Local:"-Zeile so
   * druckt wie `next start` 15.5.26, und zwar über zwei Datenblöcke verteilt
   * — wie unter Last. Kein Bau, keine Datenbank, kein Testserver; die Gruppe
   * läuft deshalb in jedem Lauf mit. Die Fristen sind verkürzt
   * (`Einstellungen`, nur nach unten zulässig), die Abzüge landen in einem
   * Wegwerfverzeichnis statt in `test-results/`, und die Wächterzeilen werden
   * eingesammelt statt gedruckt: Eine `W-11-Wächter`-Zeile aus der
   * Selbstprüfung im Protokoll eines vollen Laufs hielte jemand für den
   * echten Befund. Das Skript des Stellvertreters bleibt rein ASCII (Next
   * druckt „⨯", hier als Unicode-Escape geschrieben), damit die
   * Befehlszeile unter Windows nichts umkodiert; und es beendet sich erst im
   * Rückruf des letzten `write`, damit keine Zeile an `process.exit`
   * verlorengeht — geprüft wird das Werkzeug, nicht Nodes Pufferung.
   */
  describe('Begleitung, Wächter und Abzug an einem Stellvertreterprozess', () => {
    /** Was die Fälle unten aus einem Abzug lesen — nicht seine ganze Form. */
    interface Abzug {
      kennung: string;
      art: string;
      messung: { phase?: string; dauerMs?: number };
      waechter: { proben: Array<{ status?: number }> | null } | null;
      lagen: Array<{ anlass: string; datenbank?: { fehler?: string } }>;
      instanzen: Array<{ beendet: { code: number | null } | null; ausgabe: Array<{ kanal: string; text: string }> }>;
    }

    const kinder: ChildProcess[] = [];
    let ablage = '';

    before(() => {
      ablage = mkdtempSync(join(tmpdir(), 'clenaris-w11-selbstprobe-'));
    });

    after(() => {
      for (const kind of kinder) if (kind.exitCode === null && kind.signalCode === null) kind.kill();
      rmSync(ablage, { recursive: true, force: true });
    });

    function stellvertreter(skript: string): ChildProcess {
      const kind = spawn(process.execPath, ['-e', skript], { stdio: ['ignore', 'pipe', 'pipe'] });
      kinder.push(kind);
      return kind;
    }

    /** Ein Server, der auf alles 200 antwortet — ausser auf die Wege in `wege`. */
    const server = (wege = '') => `
      const http = require('node:http');
      const server = http.createServer((anfrage, antwort) => {
        ${wege}
        antwort.writeHead(200, { 'content-type': 'text/plain' });
        antwort.end('stellvertreter');
      });
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        process.stdout.write('   Next.js 15.5.26 (Stellvertreter)\\n   - Loc');
        setTimeout(() => process.stdout.write('al:        http://127.0.0.1:' + port + '\\n   Ready in 5ms\\n'), 50);
      });
    `;

    /** Den Pfad des Abzugs aus einer Fehlermeldung lesen und den Abzug laden. */
    function abzugAus(meldung: string): { datei: string; abzug: Abzug } {
      const datei = /Abzug: (.+\.json)/.exec(meldung)?.[1];
      assert.ok(datei, `kein Abzug genannt:\n${meldung}`);
      assert.ok(datei.startsWith(ablage), `Abzug ausserhalb der Wegwerfablage: ${datei}`);
      return { datei, abzug: JSON.parse(readFileSync(datei, 'utf8')) as Abzug };
    }

    async function scheitert(zusage: Promise<unknown>): Promise<Error> {
      const ergebnis = await zusage.then(
        () => null,
        (fehler: unknown) => fehler,
      );
      assert.ok(ergebnis instanceof Error, 'erwartet war ein Scheitern');
      return ergebnis;
    }

    it('nimmt keine längere Frist an — die Messlatte lässt sich nur senken', () => {
      assert.throws(() => instanzDiagnose('W-11-Selbstprobe', { anfrageFristMs: 30_001 }), /nur verkürzt/);
      assert.throws(() => instanzDiagnose('W-11-Selbstprobe', { waechterMs: 5_001 }), /nur verkürzt/);
      assert.throws(() => instanzDiagnose('W-11-Selbstprobe', { anfrageFristMs: 0 }), /nur verkürzt/);
      assert.doesNotThrow(() => instanzDiagnose('W-11-Selbstprobe', { anfrageFristMs: 30_000, waechterMs: 5_000 }));
    });

    it('liest den Port aus der zerteilten „Local:"-Zeile und meldet bei einer schnellen Antwort nichts', async () => {
      const zeilen: string[] = [];
      const diagnose = instanzDiagnose('W-11-Selbstprobe', { ablage, melden: (z) => zeilen.push(z) });
      const port = await diagnose.startBegleiten('S', stellvertreter(server()), { datenbank: null, fristMs: 20_000 });
      const antwort = await diagnose.anfrage(port, '/irgendwo');
      assert.equal(antwort.status, 200);
      assert.equal(antwort.text, 'stellvertreter', 'die Antwort kommt vom Stellvertreter, nicht von einem anderen Prozess');
      assert.deepEqual(await diagnose.abzuegeAbwarten(), []);
      assert.deepEqual(zeilen, []);
    });

    it('nennt einen belegten Port als Grund — die allgemeine Zeile davor verdeckt ihn nicht', async () => {
      // Wörtlich die Reihenfolge von `start-server.js`: erst die allgemeine
      // Zeile, dann der Fehler, dann `process.exit(1)`. Gegen den alten
      // Stand meldete der Fall nur „Failed to start server".
      const kind = stellvertreter(`
        process.stderr.write(
          ' \\u2a2f Failed to start server\\nError: listen EADDRINUSE: address already in use 127.0.0.1:3001\\n    at Server.setupListenHandle (node:net:1908:16)\\n',
          () => process.exit(1),
        );
      `);
      const diagnose = instanzDiagnose('W-11-Selbstprobe', { ablage, melden: () => undefined });
      const fehler = await scheitert(diagnose.startBegleiten('S', kind, { datenbank: null, fristMs: 60_000 }));
      assert.match(fehler.message, /^Instanz S kam nicht hoch: Der Port ist belegt \(EADDRINUSE\)/);
      const { abzug } = abzugAus(fehler.message);
      assert.equal(abzug.art, 'fehlschlag');
      assert.equal(abzug.kennung, 'W-11-Selbstprobe');
      // Wörtlich verglichen, nicht per Muster: Ein Syntaxfehler im Skript des
      // Stellvertreters gäbe dessen Quelltext samt „EADDRINUSE" auf stderr
      // aus, und ein Muster wäre dann aus dem falschen Grund erfüllt.
      assert.ok(
        abzug.instanzen[0]!.ausgabe.some(
          (z) => z.kanal === 'stderr' && z.text === 'Error: listen EADDRINUSE: address already in use 127.0.0.1:3001',
        ),
        'die Fehlerzeile steht mit Kanal im Abzug',
      );
      assert.equal(abzug.lagen[0]!.datenbank?.fehler, 'Keine Testdatenbankadresse bekannt.');
    });

    it('meldet einen Prozess, der vor seinem Port endet, mit Grund, Exitcode und gelesener Ausgabe', async () => {
      // Hier folgt auf die allgemeine Zeile kein bestimmter Grund. Gemeldet
      // wird erst bei `close`, wenn alle Ausgabe gelesen ist — vorher entschied
      // ein Wettlauf zwischen `exit` und den letzten Zeilen.
      const kind = stellvertreter(`
        process.stdout.write('kein Port in Sicht\\n', () =>
          process.stderr.write(' \\u2a2f Failed to start server\\n', () => process.exit(1)),
        );
      `);
      const diagnose = instanzDiagnose('W-11-Selbstprobe', { ablage, melden: () => undefined });
      const fehler = await scheitert(diagnose.startBegleiten('S', kind, { datenbank: null, fristMs: 60_000 }));
      assert.match(fehler.message, /Failed to start server.*\(Prozess endete: Code 1, Signal –\)/);
      const { abzug } = abzugAus(fehler.message);
      assert.equal(abzug.instanzen[0]!.beendet?.code, 1);
      assert.ok(
        abzug.instanzen[0]!.ausgabe.some((z) => z.text === 'kein Port in Sicht'),
        'die Ausgabe vor dem Ende steht im Abzug',
      );
    });

    it('eine hängende Anfrage scheitert nach ihrer Frist — mit Phase, Proben, Nachfrage, Wächterzeile und Abzug', async () => {
      const zeilen: string[] = [];
      const diagnose = instanzDiagnose('W-11-Selbstprobe', { ablage, melden: (z) => zeilen.push(z), anfrageFristMs: 2_000, waechterMs: 300 });
      const port = await diagnose.startBegleiten('S', stellvertreter(server(`if (anfrage.url === '/haengt') return;`)), {
        datenbank: null,
        fristMs: 20_000,
      });
      const fehler = await scheitert(diagnose.anfrage(port, '/haengt'));
      assert.match(fehler.message, /Zeitüberschreitung nach 2000 ms \(antwort-abwarten\): GET \/haengt/);
      assert.match(fehler.message, /Phase: antwort-abwarten/);
      assert.match(fehler.message, /Proben während des Hängens: GET \/api\/public\/runtime-config → 200 .*; GET \/api\/health → 200 /);
      assert.match(fehler.message, /Nachfrage \/api\/health: 200 /);
      const { abzug } = abzugAus(fehler.message);
      assert.equal(abzug.art, 'fehlschlag');
      assert.equal(abzug.messung.phase, 'antwort-abwarten');
      assert.equal(abzug.waechter?.proben?.length, 2);
      assert.deepEqual(
        abzug.lagen.map((l) => l.anlass),
        ['waechter', 'fehlschlag'],
        'Lage beim Wächter und beim Fehlschlag',
      );
      assert.equal(zeilen.length, 1, zeilen.join('\n'));
      assert.match(zeilen[0]!, /^W-11-Selbstprobe-Wächter: S GET \/haengt nach \d+ ms ohne Kopfzeilen \(Phase antwort-abwarten\)/);
    });

    it('ein Beinahe-Fall lässt den Fall grün, meldet sich aber zweimal und hinterlässt einen Abzug', async () => {
      const zeilen: string[] = [];
      const diagnose = instanzDiagnose('W-11-Selbstprobe', { ablage, melden: (z) => zeilen.push(z), anfrageFristMs: 10_000, waechterMs: 300 });
      const port = await diagnose.startBegleiten(
        'S',
        stellvertreter(
          server(`if (anfrage.url === '/langsam') { setTimeout(() => { antwort.writeHead(200); antwort.end('spaet'); }, 900); return; }`),
        ),
        { datenbank: null, fristMs: 20_000 },
      );
      const antwort = await diagnose.anfrage(port, '/langsam');
      assert.equal(antwort.status, 200);
      assert.equal(antwort.text, 'spaet');

      const abzuege = await diagnose.abzuegeAbwarten();
      assert.equal(abzuege.length, 1, abzuege.join('\n'));
      assert.match(abzuege[0]!, /w11selbstprobe-langsam-[^\\/]+\.json$/);
      const abzug = JSON.parse(readFileSync(abzuege[0]!, 'utf8')) as Abzug;
      assert.equal(abzug.art, 'langsam');
      assert.ok((abzug.messung.dauerMs ?? 0) >= 900, `Dauer ${abzug.messung.dauerMs} ms`);
      assert.deepEqual(
        abzug.waechter?.proben?.map((p) => p.status),
        [200, 200],
      );

      assert.equal(zeilen.length, 2, zeilen.join('\n'));
      assert.match(zeilen[0]!, /^W-11-Selbstprobe-Wächter: S GET \/langsam nach \d+ ms ohne Kopfzeilen/);
      assert.ok(zeilen[1]!.startsWith('W-11-Selbstprobe-Wächter: S GET /langsam kam nach '), zeilen[1]);
      assert.ok(zeilen[1]!.endsWith(`Abzug: ${abzuege[0]}`), 'die zweite Zeile nennt den Pfad des Abzugs');
    });
  });
});

describe('Dasselbe Artefakt unter zwei Laufzeitumgebungen (ohne Neubau)', () => {
  const datenbank = testdatenbankAdresse();
  const voraussetzung = !bauVollstaendig()
    ? `kein vollständiger Bau in ${DIST}`
    : !datenbank
      ? 'keine erkennbare Testdatenbank'
      : null;
  if (voraussetzung && IM_CI) {
    it('Voraussetzungen im CI', () => assert.fail(`Nachweis nicht möglich: ${voraussetzung}.`));
    return;
  }
  const optionen = voraussetzung ? { skip: `Übersprungen: ${voraussetzung}.` } : {};

  const A = { appUrl: 'https://a.pruef-clenaris.example', ga: 'G-AAAA1111', gtm: 'GTM-AAAA11' };
  const B = { appUrl: 'https://b.pruef-clenaris.example:8443', ga: 'G-BBBB2222', gtm: 'GTM-BBBB22' };
  const ADRESSEN = { A: 'laufzeit-artefakt-a@pruef.clenaris.example', B: 'laufzeit-artefakt-b@pruef.clenaris.example' };

  let a: Instanz | undefined;
  let b: Instanz | undefined;
  let buildIdVorher = '';
  let buildIdZeitVorher = 0;

  async function aufraeumen(): Promise<void> {
    const db = testDb();
    if (db) await db.newsletterSubscriber.deleteMany({ where: { email: { in: Object.values(ADRESSEN) } } });
  }

  before(async () => {
    if (voraussetzung) return;
    buildIdVorher = readFileSync(join(WURZEL, DIST, 'BUILD_ID'), 'utf8').trim();
    buildIdZeitVorher = statSync(join(WURZEL, DIST, 'BUILD_ID')).mtimeMs;
    await aufraeumen();
    /*
      Besuchsmessung (2026-09-30): A misst, B nicht — derselbe Bau, nur die
      Umgebung verschieden. Gesetzt über `process.env`, das `starten` beim
      Erzeugen des Prozesses übernimmt; ausdrücklich `aus` statt leer, damit
      auch der Wert „irgendetwas ausser an" geprüft ist und `next start`
      nicht aus der `.env` nachliest. Danach wieder der alte Stand: Die
      übrigen Dateien des Laufs sollen davon nichts merken.
    */
    const besuchsmessungVorher = process.env.CLENARIS_BESUCHSMESSUNG;
    try {
      process.env.CLENARIS_BESUCHSMESSUNG = 'an';
      // Nacheinander: Zwei gleichzeitig startende Instanzen kämpfen um
      // denselben Bau-Zwischenspeicher nicht, aber um Speicher im CI-Läufer.
      a = await starten('A', A.appUrl, A.ga, A.gtm, datenbank!);
      process.env.CLENARIS_BESUCHSMESSUNG = 'aus';
      b = await starten('B', B.appUrl, B.ga, B.gtm, datenbank!);
    } finally {
      if (besuchsmessungVorher === undefined) delete process.env.CLENARIS_BESUCHSMESSUNG;
      else process.env.CLENARIS_BESUCHSMESSUNG = besuchsmessungVorher;
    }
  });

  after(async () => {
    await Promise.all([beenden(a), beenden(b)]);
    for (const i of [a, b]) if (i) rmSync(i.cacheDir, { recursive: true, force: true });
    if (!voraussetzung) await aufraeumen();
    await testDbSchliessen();
  });

  it('Browser-Konfiguration: jede Instanz nennt ihre eigene Herkunft und Kennungen', optionen, async () => {
    for (const [instanz, erwartet] of [[a!, A], [b!, B]] as const) {
      /**
       * Genau diese erste Anfrage an A hing in zwei vollen Läufen 30 Sekunden
       * (W-11, 2026-09-27). Die beiden Diagnosen, die hier standen
       * (Prozesszustand, Protokollende, Nachfrage an `/api/health`), leistet
       * jetzt `anfrage` selbst — für jede Anfrage dieser Gruppe, mit Phasen,
       * Proben während des Hängens und einem Abzug in `test-results/`. Die
       * Erwartung bleibt dieselbe.
       */
      const { status, text } = await anfrage(instanz.port, '/api/public/runtime-config');
      assert.equal(status, 200);
      const rumpf = JSON.parse(text) as { data: unknown };
      // `besuchsmessung`: A startet mit `an`, B mit `aus` (siehe `before`).
      assert.deepEqual(rumpf.data, {
        appUrl: erwartet.appUrl,
        analytics: { gaMeasurementId: erwartet.ga, gtmId: erwartet.gtm },
        besuchsmessung: instanz.name === 'A',
      });
      ohneMarker(text, `Instanz ${instanz.name}`, [datenbank!]);
    }
  });

  /**
   * Der Schalter der Besuchsmessung wirkt zur Laufzeit, und ausgeschaltet
   * speichert der Server nichts (2026-09-30).
   *
   * Dieselbe Meldung geht an beide Instanzen. A misst — das ist die
   * Gegenprobe: Ohne sie bestünde der Fall auch dann, wenn die Meldung aus
   * einem ganz anderen Grund verworfen würde (Automatenfilter, Pfad,
   * Schema). B antwortet ebenfalls 204, aber in der Datenbank steht nur die
   * Zeile von A.
   *
   * Ohne Ausweichen: Fehlt der Bau, scheitert dieser Fall mit dem Grund,
   * statt still übersprungen zu werden — ein übersprungener Nachweis ist
   * keiner.
   */
  it('Instanz mit ausgeschalteter Besuchsmessung speichert nichts', async () => {
    assert.ok(a && b, `Die beiden Instanzen laufen nicht: ${voraussetzung ?? 'unbekannter Grund'}.`);
    const db = testDb();
    assert.ok(db, 'Keine Testdatenbank für die Gegenprobe.');

    // Nur Buchstaben und kurz: Ziffernfolgen und lange Segmente maskiert die
    // Bereinigung als Token, und dann stimmte der Pfad nicht mehr.
    const marke = `laufzeitmessung${Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('')}`;
    const wegraeumen = () => db.trafficEvent.deleteMany({ where: { path: { contains: marke } } });
    await wegraeumen();
    try {
      for (const instanz of [a, b]) {
        const antwort = await anfrage(instanz.port, '/api/public/traffic', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            // Ein gewöhnlicher Browser — Automaten verwirft die Bereinigung.
            'user-agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
          },
          body: JSON.stringify({
            sitzung: 'Laufzeit_Pruefsitzung',
            ereignisse: [{ name: 'PAGE_VIEW', pfad: `/${marke}/${instanz.name.toLowerCase()}` }],
          }),
        });
        assert.equal(antwort.status, 204, `Instanz ${instanz.name}: ${antwort.status} ${antwort.text}`);
      }
      const zeilen = await db.trafficEvent.findMany({ where: { path: { contains: marke } } });
      assert.deepEqual(
        zeilen.map((z) => z.path),
        [`/${marke}/a`],
        'A (an) muss speichern, B (aus) darf nichts speichern',
      );
    } finally {
      await wegraeumen();
    }
  });

  it('Herkunftsprüfung: A vertraut nur A, B nur B', optionen, async () => {
    const pruefen = async (instanz: Instanz, origin: string) =>
      (await anfrage(instanz.port, '/api/auth/logout', { method: 'POST', headers: { origin } })).status;
    assert.equal(await pruefen(a!, A.appUrl), 200);
    assert.equal(await pruefen(a!, B.appUrl), 403);
    assert.equal(await pruefen(b!, B.appUrl), 200);
    assert.equal(await pruefen(b!, A.appUrl), 403);
  });

  it('ein tatsächlich versendeter Link trägt die Herkunft der Instanz (absoluteUrl)', optionen, async () => {
    for (const [instanz, erwartet, adresse] of [[a!, A, ADRESSEN.A], [b!, B, ADRESSEN.B]] as const) {
      const antwort = await anfrage(instanz.port, '/api/public/newsletter', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: adresse }),
      });
      assert.equal(antwort.status, 201, antwort.text);
      const mail = mailsIn(instanz.cacheDir).find((m) => m.to.includes(adresse));
      assert.ok(mail, `Instanz ${instanz.name}: keine Nachricht im Postausgang`);
      const links = [...mail.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!.replace(/&amp;/g, '&'));
      const bestaetigen = links.find((l) => l.includes('/newsletter/bestaetigen'));
      assert.ok(bestaetigen, `Instanz ${instanz.name}: kein Bestätigungslink`);
      assert.equal(new URL(bestaetigen).origin, erwartet.appUrl);
      const andere = erwartet === A ? B.appUrl : A.appUrl;
      assert.ok(!mail.html.includes(andere), `Instanz ${instanz.name} nennt die Herkunft der anderen`);
      assert.ok(!mail.html.includes('localhost'), `Instanz ${instanz.name} nennt localhost`);
      ohneMarker(mail.html, `Mail von ${instanz.name}`, [datenbank!]);
    }
  });

  it('zwischenspeicherbares HTML trägt keinen Laufzeitwert', optionen, async () => {
    // Die Startseite ist statisch vorgerendert. Stünde eine Kennung darin,
    // wäre sie beim Bau eingesetzt — und läge in jedem CDN-Zwischenspeicher.
    for (const [instanz, erwartet] of [[a!, A], [b!, B]] as const) {
      const { status, text: html } = await anfrage(instanz.port, '/');
      assert.equal(status, 200);
      assert.ok(!html.includes(erwartet.ga) && !html.includes(erwartet.gtm), `Instanz ${instanz.name}: Kennung im HTML`);
      assert.ok(!html.includes(erwartet.appUrl), `Instanz ${instanz.name}: Laufzeitherkunft im statischen HTML`);
      ohneMarker(html, `Startseite von ${instanz.name}`, [datenbank!]);
    }
  });

  it('die kanonische Domain ist bewusst Bauzeit — in beiden Instanzen dieselbe', optionen, async () => {
    // src/lib/seiten-url.ts: Canonical, Sitemap und robots.txt der statischen
    // Website nennen die Produktdomain, gleich für jede Umgebung.
    const robotsA = (await anfrage(a!.port, '/robots.txt')).text;
    const robotsB = (await anfrage(b!.port, '/robots.txt')).text;
    assert.match(robotsA, /sitemap/i);
    assert.equal(robotsA, robotsB);
    assert.ok(!robotsA.includes(A.appUrl) && !robotsA.includes(B.appUrl));
  });

  it('der Bau ist danach derselbe — kein Neubau, keine Veränderung', optionen, () => {
    assert.equal(readFileSync(join(WURZEL, DIST, 'BUILD_ID'), 'utf8').trim(), buildIdVorher);
    assert.equal(statSync(join(WURZEL, DIST, 'BUILD_ID')).mtimeMs, buildIdZeitVorher);
  });
});
