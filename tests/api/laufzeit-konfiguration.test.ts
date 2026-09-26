import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
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
 *     tatsächlich versendeter Link (`absoluteUrl` im Postausgang).
 *
 * Ebene 3 überspringt sich örtlich, wenn kein Bau oder keine Testdatenbank
 * da ist — im CI (`CI` gesetzt) scheitert sie stattdessen: Dort ist sie der
 * Nachweis, und ein übersprungener Nachweis ist keiner.
 */

// Werte, die in keiner Antwort auftauchen dürfen. Jeder ist eindeutig genug,
// dass ein Treffer kein Zufall sein kann.
const MARKER = {
  DATABASE_URL: 'postgresql://marker-db-user:marker-db-passwort@marker-db-host:5432/marker_test',
  DIRECT_URL: 'postgresql://marker-direct:marker-direct-passwort@marker-db-host:5432/marker_test',
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
  SSH_PRIVATE_KEY: 'marker-ssh-privat',
  SENTRY_AUTH_TOKEN: 'marker-monitoring-token',
  GOOGLE_MAPS_SERVER_KEY: 'marker-maps-server',
  // Öffentlich benannt, aber nicht freigegeben: Auch ein `NEXT_PUBLIC_`-Name
  // reicht nicht, um in die Browser-Konfiguration zu gelangen.
  NEXT_PUBLIC_EVIL_SECRET: 'marker-oeffentlich-benannt',
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
    assert.deepEqual(Object.keys(konfiguration).sort(), ['analytics', 'appUrl']);
    assert.deepEqual(Object.keys(konfiguration.analytics).sort(), ['facebookPixelId', 'gaMeasurementId', 'gtmId']);
    assert.deepEqual(konfiguration, {
      appUrl: 'https://a.clenaris.example',
      analytics: { gaMeasurementId: 'G-ABC1234', gtmId: 'GTM-XYZ123', facebookPixelId: '1234567890' },
    });
    ohneMarker(JSON.stringify(konfiguration), 'Die Browser-Konfiguration');
  });

  it('das Schema lehnt jedes weitere Feld ab — auch eines, das jemand später dazuschreibt', () => {
    const erweitert = { appUrl: 'https://a.clenaris.example', analytics: {}, jwtSecret: MARKER.JWT_SECRET };
    assert.equal(PublicRuntimeConfigSchema.safeParse(erweitert).success, false);
    const verschachtelt = { appUrl: 'https://a.clenaris.example', analytics: { databaseUrl: MARKER.DATABASE_URL } };
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
  protokoll: string[];
}

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

function freierPort(): Promise<number> {
  return new Promise((ok, fehler) => {
    const server = createServer();
    server.once('error', fehler);
    server.listen(0, '127.0.0.1', () => {
      const adresse = server.address();
      const port = typeof adresse === 'object' && adresse ? adresse.port : 0;
      server.close(() => ok(port));
    });
  });
}

async function starten(name: 'A' | 'B', appUrl: string, ga: string, gtm: string, datenbank: string): Promise<Instanz> {
  const port = await freierPort();
  const cacheDir = mkdtempSync(join(tmpdir(), `clenaris-artefakt-${name.toLowerCase()}-`));
  const protokoll: string[] = [];
  // `next start` aus dem vorhandenen Bau — kein `build`, kein `npm`, keine
  // Korrektur. Die Umgebung ist vollständig benannt: die Instanzwerte, die
  // Marker-Geheimnisse (die nirgends auftauchen dürfen) und die
  // Testdatenbank. Ein leerer Resend-Schlüssel hält den Postausgang aktiv.
  const prozess = spawn(process.execPath, [join(WURZEL, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', String(port), '-H', '127.0.0.1'], {
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
  prozess.stdout?.on('data', (d: Buffer) => protokoll.push(d.toString()));
  prozess.stderr?.on('data', (d: Buffer) => protokoll.push(d.toString()));

  const bis = Date.now() + 90_000;
  while (Date.now() < bis) {
    if (prozess.exitCode !== null) break;
    try {
      const antwort = await anfrage(port, '/api/public/runtime-config');
      if (antwort.status === 200) return { name, appUrl, ga, gtm, port, cacheDir, prozess, protokoll };
    } catch {
      /* noch nicht bereit */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  prozess.kill();
  throw new Error(`Instanz ${name} kam nicht hoch:\n${protokoll.join('').slice(-3000)}`);
}

/**
 * Eine Anfrage an eine der beiden Instanzen, jedes Mal über eine **neue**
 * Verbindung (`agent: false`).
 *
 * `fetch` hält Verbindungen offen und nimmt sie wieder. Während Instanz B
 * startet, vergehen mehr als die fünf Sekunden, nach denen Next eine
 * ruhende Verbindung schliesst — die nächste Anfrage an A lief dann auf
 * eine tote Verbindung und scheiterte mit „fetch failed" (gemessen
 * 2026-09-27). Das ist eine Eigenheit des Prüfklienten, kein Befund.
 */
function anfrage(
  port: number,
  pfad: string,
  optionen: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; text: string }> {
  return new Promise((ok, fehler) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path: pfad, method: optionen.method ?? 'GET', headers: optionen.headers, agent: false, timeout: 30_000 },
      (res) => {
        const teile: Buffer[] = [];
        res.on('data', (d: Buffer) => teile.push(d));
        res.on('end', () => ok({ status: res.statusCode ?? 0, text: Buffer.concat(teile).toString('utf8') }));
        res.on('error', fehler);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`Zeitüberschreitung: ${pfad}`)));
    req.on('error', fehler);
    if (optionen.body) req.write(optionen.body);
    req.end();
  });
}

function beenden(instanz: Instanz | undefined): Promise<void> {
  if (!instanz || instanz.prozess.exitCode !== null) return Promise.resolve();
  return new Promise((ok) => {
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
    // Nacheinander: Zwei gleichzeitig startende Instanzen kämpfen um
    // denselben Bau-Zwischenspeicher nicht, aber um Speicher im CI-Läufer.
    a = await starten('A', A.appUrl, A.ga, A.gtm, datenbank!);
    b = await starten('B', B.appUrl, B.ga, B.gtm, datenbank!);
  });

  after(async () => {
    await Promise.all([beenden(a), beenden(b)]);
    for (const i of [a, b]) if (i) rmSync(i.cacheDir, { recursive: true, force: true });
    if (!voraussetzung) await aufraeumen();
    await testDbSchliessen();
  });

  it('Browser-Konfiguration: jede Instanz nennt ihre eigene Herkunft und Kennungen', optionen, async () => {
    for (const [instanz, erwartet] of [[a!, A], [b!, B]] as const) {
      const { status, text } = await anfrage(instanz.port, '/api/public/runtime-config');
      assert.equal(status, 200);
      const rumpf = JSON.parse(text) as { data: unknown };
      assert.deepEqual(rumpf.data, { appUrl: erwartet.appUrl, analytics: { gaMeasurementId: erwartet.ga, gtmId: erwartet.gtm } });
      ohneMarker(text, `Instanz ${instanz.name}`, [datenbank!]);
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
