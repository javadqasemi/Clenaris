import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { call, get, requireServer } from '../helpers/client';
import { loginAll, type AccountName } from '../helpers/accounts';
import { rateLimitResetAvailable, resetRateLimits } from '../helpers/rate-limit';
import { eigeneOrganisationId, fremdeOrganisation, testDb, testDbGrund, testDbSchliessen } from '../helpers/testdb';

/**
 * Eigene Besuchsmessung (2026-09-28) — über HTTP gegen den laufenden Server.
 *
 * Was hier belegt wird, ist die Datenschutzaussage selbst, und zwar am
 * **Bestand in der Datenbank**, nicht am Statuscode: Der Endpunkt antwortet
 * absichtlich immer 204, ob er speichert oder verwirft. Ein Test, der nur den
 * Statuscode prüfte, könnte eine durchgelassene Rechnungsadresse nicht von
 * einer verworfenen unterscheiden.
 *
 *  • gültiger Stapel → gespeichert, Pfad ohne Abfrage, UTM in eigenen Spalten;
 *  • Token-Segmente maskiert, App-Bereiche verworfen;
 *  • `Sec-GPC: 1` und `DNT: 1` verwerfen alles;
 *  • Übergrösse, unbekanntes Feld, falscher Name → 422; fremde Herkunft → 403;
 *  • keine IP, kein User-Agent, keine rohe Sitzungskennung in der Tabelle;
 *  • Auswertung nur mit `traffic:read`, nur die eigene Organisation;
 *  • Aufbewahrung: der Nachtlauf löscht nach 13 Monaten, idempotent;
 *  • das Kontingent `traffic` greift.
 *
 * Alle Prüfzeilen tragen eine Marke aus Buchstaben (Ziffernfolgen würden als
 * Token maskiert) und werden vorher und nachher entfernt.
 */

let jars: Record<AccountName, string>;
let eigeneOrg = '';
let fremdeOrg = '';

const buchstaben = (n: number) =>
  Array.from(randomBytes(n), (b) => String.fromCharCode(97 + (b % 26))).join('');
const MARKE = `pruefverkehr${buchstaben(8)}`;
const SITZUNG = `Pruef_${buchstaben(12)}-Sitzung`;
const UA_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

const melden = (koerper: unknown, kopf: Record<string, string> = {}) =>
  call('POST', '/api/public/traffic', {
    body: koerper,
    headers: { 'user-agent': UA_CHROME, ...kopf },
    retries: 0,
  });

async function aufraeumen() {
  const db = testDb();
  if (!db) return;
  await db.trafficEvent.deleteMany({
    where: {
      OR: [
        { path: { contains: MARKE } },
        { utmCampaign: { startsWith: MARKE } },
        { utmSource: { startsWith: MARKE } },
      ],
    },
  });
}

/** Zeilen dieser Prüfung in der eigenen Organisation. */
async function zeilen(where: Record<string, unknown>) {
  return testDb()!.trafficEvent.findMany({ where: { organizationId: eigeneOrg, ...where } });
}

before(async () => {
  await requireServer();
  jars = await loginAll();
  eigeneOrg = (await eigeneOrganisationId()) ?? '';
  fremdeOrg = (await fremdeOrganisation()) ?? '';
  await aufraeumen();
});

after(async () => {
  await aufraeumen();
  resetRateLimits();
  await testDbSchliessen();
});

describe('Besuchsmessung — Erfassen und Bereinigen', () => {
  it('nimmt einen gültigen Stapel an und speichert ihn bereinigt', async (t) => {
    if (!testDb()) return t.skip(testDbGrund());
    const antwort = await melden({
      sitzung: SITZUNG,
      ereignisse: [
        {
          name: 'PAGE_VIEW',
          pfad: `/${MARKE}/seite?nr=BK-2026-0001&t=geheim&utm_source=${MARKE}quelle&utm_medium=CPC&utm_campaign=${MARKE}`,
          referrer: 'https://www.google.ch/search?q=reinigung+bern',
          einstieg: true,
        },
        { name: 'PAGE_VIEW', pfad: `/${MARKE}/zweite` },
        { name: 'CONTACT_FORM', pfad: `/${MARKE}/zweite` },
      ],
    });
    assert.equal(antwort.status, 204, antwort.text);

    const einstieg = await zeilen({ path: `/${MARKE}/seite` });
    assert.equal(einstieg.length, 1);
    const e = einstieg[0]!;
    assert.equal(e.eventName, 'PAGE_VIEW');
    assert.equal(e.landing, true);
    assert.equal(e.referrerHost, 'google.ch');
    assert.equal(e.utmSource, `${MARKE}quelle`);
    assert.equal(e.utmMedium, 'cpc');
    assert.equal(e.utmCampaign, MARKE);
    assert.equal(e.device, 'DESKTOP');
    assert.equal(e.browser, 'CHROME');
    assert.ok(!e.path.includes('?') && !e.path.includes('geheim'), e.path);

    const weitere = await zeilen({ path: `/${MARKE}/zweite` });
    assert.equal(weitere.length, 2);
    for (const z of weitere) {
      assert.equal(z.landing, false, 'nur die erste Seite ist Einstieg');
      assert.equal(z.referrerHost, null, 'Herkunft nur beim Einstieg');
      assert.equal(z.sessionHash, e.sessionHash, 'derselbe Stapel, dieselbe Sitzung');
    }
  });

  it('maskiert Token-Segmente und behält keine Abfrage', async (t) => {
    if (!testDb()) return t.skip(testDbGrund());
    const token = 'AbCdEf0123456789xyzABCDEFghijk_-1234567';
    const antwort = await melden({
      sitzung: SITZUNG,
      ereignisse: [
        { name: 'PAGE_VIEW', pfad: `/offerte/${token}?utm_campaign=${MARKE}offerte` },
        { name: 'PAGE_VIEW', pfad: `/rechnung/kurz?utm_campaign=${MARKE}rechnung` },
        { name: 'PAGE_VIEW', pfad: `/${MARKE}/${token}` },
      ],
    });
    assert.equal(antwort.status, 204, antwort.text);

    const offerte = await zeilen({ utmCampaign: `${MARKE}offerte` });
    assert.deepEqual(offerte.map((z) => z.path), ['/offerte/:token']);
    const rechnung = await zeilen({ utmCampaign: `${MARKE}rechnung` });
    assert.deepEqual(rechnung.map((z) => z.path), ['/rechnung/:token']);
    const allgemein = await zeilen({ path: { startsWith: `/${MARKE}/:` } });
    assert.deepEqual(allgemein.map((z) => z.path), [`/${MARKE}/:token`]);

    // Nirgends in der Tabelle steht der Token — auch nicht in einer anderen Spalte.
    const treffer = await testDb()!.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*) AS n FROM traffic_events WHERE row_to_json(traffic_events)::text LIKE ${`%${token}%`}
    `;
    assert.equal(Number(treffer[0]?.n ?? 0), 0);
  });

  it('verwirft App-Bereiche ganz', async (t) => {
    if (!testDb()) return t.skip(testDbGrund());
    const antwort = await melden({
      sitzung: SITZUNG,
      ereignisse: ['/admin/kunden', '/portal/einsaetze', '/konto/rechnungen', '/api/public/traffic', '/auth/passwort-neu', '/signieren/abc'].map(
        (pfad) => ({ name: 'PAGE_VIEW', pfad: `${pfad}?utm_campaign=${MARKE}app` }),
      ),
    });
    assert.equal(antwort.status, 204, antwort.text);
    assert.equal((await zeilen({ utmCampaign: `${MARKE}app` })).length, 0);
  });

  it('verwirft alles bei Sec-GPC: 1 und bei DNT: 1', async (t) => {
    if (!testDb()) return t.skip(testDbGrund());
    const signale: Record<string, string>[] = [{ 'sec-gpc': '1' }, { dnt: '1' }];
    for (const kopf of signale) {
      const antwort = await melden(
        { sitzung: SITZUNG, ereignisse: [{ name: 'PAGE_VIEW', pfad: `/${MARKE}/signal` }] },
        kopf,
      );
      assert.equal(antwort.status, 204, antwort.text);
    }
    assert.equal((await zeilen({ path: `/${MARKE}/signal` })).length, 0);
  });

  it('verwirft Automaten (Bot-User-Agent)', async (t) => {
    if (!testDb()) return t.skip(testDbGrund());
    const antwort = await melden(
      { sitzung: SITZUNG, ereignisse: [{ name: 'PAGE_VIEW', pfad: `/${MARKE}/bot` }] },
      { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
    );
    assert.equal(antwort.status, 204);
    assert.equal((await zeilen({ path: `/${MARKE}/bot` })).length, 0);
  });

  it('speichert keine IP, keinen User-Agent und keine rohe Sitzungskennung', async (t) => {
    const db = testDb();
    if (!db) return t.skip(testDbGrund());

    const spalten = await db.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'traffic_events' ORDER BY column_name
    `;
    assert.deepEqual(
      spalten.map((s) => s.column_name).sort(),
      [
        'browser', 'day', 'device', 'eventName', 'id', 'landing', 'occurredAt', 'organizationId', 'path',
        'referrerHost', 'sessionHash', 'utmCampaign', 'utmMedium', 'utmSource',
      ].sort(),
      'eine neue Spalte braucht eine Begründung in docs/TRAFFIC_ANALYTICS.md',
    );

    const gespeichert = await zeilen({ path: { startsWith: `/${MARKE}/` } });
    assert.ok(gespeichert.length > 0);
    for (const z of gespeichert) {
      const roh = JSON.stringify(z);
      assert.ok(!roh.includes(SITZUNG), 'rohe Sitzungskennung gespeichert');
      assert.ok(!roh.includes('Mozilla') && !roh.includes('Chrome/129'), 'User-Agent gespeichert');
      assert.ok(!/127\.0\.0\.1|::1|::ffff:/.test(roh), 'IP-Adresse gespeichert');
      assert.match(z.sessionHash, /^[0-9a-f]{64}$/);
    }
  });
});

describe('Besuchsmessung — Validierung und Herkunft', () => {
  const gueltig = { name: 'PAGE_VIEW', pfad: `/${MARKE}/validierung` };

  it('lehnt mehr als zwanzig Ereignisse mit 422 ab', async () => {
    const antwort = await melden({ sitzung: SITZUNG, ereignisse: Array.from({ length: 21 }, () => gueltig) });
    assert.equal(antwort.status, 422, antwort.text);
  });

  it('lehnt einen Pfad über 300 Zeichen, ein unbekanntes Feld, einen erfundenen Namen und eine falsche Sitzung mit 422 ab', async () => {
    const faelle = [
      { sitzung: SITZUNG, ereignisse: [{ ...gueltig, pfad: `/${'a'.repeat(300)}` }] },
      { sitzung: SITZUNG, ereignisse: [{ ...gueltig, ip: '203.0.113.7' }] },
      { sitzung: SITZUNG, ereignisse: [gueltig], userAgent: 'x' },
      { sitzung: SITZUNG, ereignisse: [{ ...gueltig, name: 'PURCHASE' }] },
      { sitzung: 'anna@example.ch', ereignisse: [gueltig] },
      { sitzung: SITZUNG, ereignisse: [] },
    ];
    for (const koerper of faelle) {
      const antwort = await melden(koerper);
      assert.equal(antwort.status, 422, `${JSON.stringify(koerper).slice(0, 120)} → ${antwort.status}`);
    }
  });

  it('weist eine fremde Herkunft ab (403)', async () => {
    const antwort = await melden(
      { sitzung: SITZUNG, ereignisse: [gueltig] },
      { origin: 'https://boese.example' },
    );
    assert.equal(antwort.status, 403, antwort.text);
  });
});

describe('Besuchsmessung — Auswertung und Rechte', () => {
  it('ohne Anmeldung 401, Mitarbeitende und Kundschaft 403', async () => {
    assert.equal((await get('/api/traffic')).status, 401);
    assert.equal((await get('/api/traffic', { jar: jars.employee })).status, 403);
    assert.equal((await get('/api/traffic', { jar: jars.customer })).status, 403);
  });

  it('Verwaltung und Betriebsleitung lesen die Auswertung', async () => {
    for (const rolle of ['super', 'admin', 'manager'] as const) {
      const antwort = await get<{ data: Record<string, unknown> }>('/api/traffic?zeitraum=heute', { jar: jars[rolle] });
      assert.equal(antwort.status, 200, `${rolle}: ${antwort.text.slice(0, 200)}`);
      const d = antwort.payload.data;
      for (const feld of ['seitenansichten', 'sitzungen', 'konversionsrate', 'topSeiten', 'utmKampagne', 'geraete', 'browser', 'konversionen']) {
        assert.ok(feld in d, `${rolle}: Feld ${feld} fehlt`);
      }
    }
  });

  it('zeigt die gespeicherten Ereignisse in der Auswertung', async (t) => {
    if (!testDb()) return t.skip(testDbGrund());
    const antwort = await get<{
      data: { utmKampagne: { schluessel: string; anzahl: number }[]; konversionen: { name: string; ereignisse: number }[] };
    }>('/api/traffic?zeitraum=heute', { jar: jars.admin });
    assert.equal(antwort.status, 200);
    const d = antwort.payload.data;
    assert.ok(d.utmKampagne.some((z) => z.schluessel === MARKE && z.anzahl === 1), JSON.stringify(d.utmKampagne));
    assert.ok((d.konversionen.find((k) => k.name === 'CONTACT_FORM')?.ereignisse ?? 0) >= 1);
  });

  it('lehnt einen falsch geformten Zeitraum mit 422 ab', async () => {
    const antwort = await get('/api/traffic?zeitraum=ewig', { jar: jars.admin });
    assert.equal(antwort.status, 422, antwort.text);
  });

  it('zählt nur die eigene Organisation', async (t) => {
    const db = testDb();
    if (!db || !fremdeOrg) return t.skip(testDbGrund());
    const lesen = async () =>
      (await get<{ data: { sitzungen: number; utmKampagne: { schluessel: string }[]; einstiegsseiten: { schluessel: string }[] } }>(
        '/api/traffic?zeitraum=heute',
        { jar: jars.admin },
      )).payload.data;

    const vorher = await lesen();
    const heute = new Date(`${new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich' }).format(new Date())}T00:00:00.000Z`);
    await db.trafficEvent.createMany({
      data: Array.from({ length: 30 }, (_, i) => ({
        organizationId: fremdeOrg,
        day: heute,
        path: `/${MARKE}/fremd`,
        eventName: 'PAGE_VIEW' as const,
        sessionHash: randomBytes(32).toString('hex'),
        landing: true,
        utmCampaign: `${MARKE}fremd`,
        device: 'MOBILE' as const,
        browser: 'SAFARI' as const,
        referrerHost: i === 0 ? 'fremd.example' : null,
      })),
    });
    const nachher = await lesen();

    assert.equal(nachher.sitzungen, vorher.sitzungen, 'fremde Sitzungen mitgezählt');
    assert.ok(!nachher.utmKampagne.some((z) => z.schluessel === `${MARKE}fremd`), 'fremde Kampagne sichtbar');
    assert.ok(!nachher.einstiegsseiten.some((z) => z.schluessel === `/${MARKE}/fremd`), 'fremde Einstiegsseite sichtbar');
  });

  it('die Seite /admin/auswertungen/website antwortet der Verwaltung, nicht dem Personal', async () => {
    const admin = await get('/admin/auswertungen/website?zeitraum=7tage', { jar: jars.admin });
    assert.equal(admin.status, 200);
    assert.match(admin.text, /Website-Besuche/);
    const personal = await get('/admin/auswertungen/website', { jar: jars.employee });
    assert.notEqual(personal.status, 200);
  });
});

describe('Besuchsmessung — Aufbewahrung', () => {
  it('der Nachtlauf löscht Ereignisse älter als 13 Monate, idempotent', async (t) => {
    const db = testDb();
    if (!db || !eigeneOrg) return t.skip(testDbGrund());
    const vorMonaten = (monate: number) => {
      const d = new Date();
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - monate, 1));
    };
    const zeile = (day: Date, suffix: string) => ({
      organizationId: eigeneOrg,
      day,
      path: `/${MARKE}/${suffix}`,
      eventName: 'PAGE_VIEW' as const,
      sessionHash: randomBytes(32).toString('hex'),
      device: 'DESKTOP' as const,
      browser: 'CHROME' as const,
    });
    await db.trafficEvent.createMany({ data: [zeile(vorMonaten(15), 'alt'), zeile(vorMonaten(11), 'jung')] });

    const secret = process.env.CRON_SECRET ?? 'dev-cron-secret';
    for (let i = 0; i < 2; i++) {
      const lauf = await get('/api/cron/daily', { headers: { authorization: `Bearer ${secret}` } });
      assert.equal(lauf.status, 200, lauf.text.slice(0, 300));
    }
    assert.equal((await zeilen({ path: `/${MARKE}/alt` })).length, 0, 'älter als 13 Monate nicht gelöscht');
    assert.equal((await zeilen({ path: `/${MARKE}/jung` })).length, 1, 'jünger als 13 Monate gelöscht');
  });
});

describe('Besuchsmessung — Kontingent', () => {
  it('die Route erklärt das Kontingent „traffic" mit 120 je Minute', () => {
    const wurzel = join(__dirname, '..', '..');
    const route = readFileSync(join(wurzel, 'src', 'app', 'api', 'public', 'traffic', 'route.ts'), 'utf8');
    const limits = readFileSync(join(wurzel, 'src', 'lib', 'rate-limit.ts'), 'utf8');
    assert.match(route, /rateLimit:\s*'traffic'/);
    assert.match(limits, /traffic:\s*\{\s*limit:\s*120,\s*windowSeconds:\s*60\s*\}/);
  });

  it('greift nach 120 Meldungen je Minute (429)', async (t) => {
    // Nur mit rücksetzbarem Zähler: Sonst sperrte diese Prüfung den Endpunkt
    // für die nächste Minute, und jede spätere Datei wartete darauf.
    if (!rateLimitResetAvailable()) return t.skip('Zähler des Testservers nicht rücksetzbar');
    resetRateLimits();
    // Mit Sec-GPC, damit keine Zeile entsteht — gezählt wird trotzdem.
    const koerper = { sitzung: SITZUNG, ereignisse: [{ name: 'PAGE_VIEW', pfad: `/${MARKE}/kontingent` }] };
    let gesperrt = 0;
    for (let i = 0; i < 125; i++) {
      const antwort = await melden(koerper, { 'sec-gpc': '1' });
      if (antwort.status === 429) gesperrt += 1;
    }
    resetRateLimits();
    assert.ok(gesperrt >= 1, 'kein 429 nach 125 Meldungen');
  });
});
