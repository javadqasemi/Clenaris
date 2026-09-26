import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { BASE_URL, get, requireServer } from '../helpers/client';
import { loginAll, type AccountName } from '../helpers/accounts';
import { testDb, testDbSchliessen } from '../helpers/testdb';
import { PRUEF_SICHERHEITSBERICHT_TOKEN } from '../helpers/webhooks';

/**
 * Berichtseingang der Sicherheitszentrale (2026-09-26):
 * `POST /api/cron/security-report` und die Anzeige in `/admin/sicherheit`.
 *
 * Geprüft wird die Tür, nicht die Prüfungen dahinter: eigenes Token (nicht
 * `CRON_SECRET`), begrenzte Grösse und Felder, gespeichert und als Text
 * gezeigt, ein kritischer Bericht einmal als Sicherheitsereignis — und dass
 * die Seite nur der Systemverantwortung gehört.
 */

let jars: Record<AccountName, string>;
const MARKE = `Prüfreihe-${Date.now()}`;

function bericht(ueber: Record<string, unknown> = {}) {
  return {
    quelle: 'EXTERNAL_MONITOR',
    status: 'OK',
    erstelltAm: new Date().toISOString(),
    zusammenfassung: `${MARKE}: alles erreichbar`,
    kennzahlen: { erreichbar: true, antwortMs: 123, tlsTageBisAblauf: 61 },
    ...ueber,
  };
}

async function senden(body: unknown, token: string | null = PRUEF_SICHERHEITSBERICHT_TOKEN, roh?: string) {
  const r = await fetch(`${BASE_URL}/api/cron/security-report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: roh ?? JSON.stringify(body),
  });
  return { status: r.status, text: await r.text() };
}

async function aufraeumen() {
  const db = testDb();
  if (!db) return;
  await db.securityReport.deleteMany({ where: { summary: { startsWith: 'Prüfreihe-' } } });
  await db.securityEvent.deleteMany({ where: { kind: 'SECURITY_REPORT_CRITICAL', summary: { contains: 'Prüfreihe-' } } });
}

before(async () => {
  await requireServer();
  jars = await loginAll();
  await aufraeumen();
});

after(async () => {
  await aufraeumen();
  await testDbSchliessen();
});

describe('Berichtseingang', () => {
  it('ohne Token, mit falschem Token und mit CRON_SECRET: 401', async () => {
    assert.equal((await senden(bericht(), null)).status, 401);
    assert.equal((await senden(bericht(), 'falsch')).status, 401);
    const cron = process.env.CRON_SECRET ?? 'dev-cron-secret';
    assert.equal((await senden(bericht(), cron)).status, 401, 'CRON_SECRET öffnet den Berichtseingang');
  });

  it('gültiger Bericht: 201 und gespeichert', async (t) => {
    const r = await senden(bericht());
    assert.equal(r.status, 201, r.text);
    const db = testDb();
    if (!db) return t.skip('keine Testdatenbank');
    const gespeichert = await db.securityReport.findFirst({ where: { summary: `${MARKE}: alles erreichbar` } });
    assert.equal(gespeichert?.source, 'EXTERNAL_MONITOR');
    assert.equal(gespeichert?.status, 'OK');
  });

  it('das Token des Berichtseingangs löst keine geplanten Läufe aus', async () => {
    for (const lauf of ['/api/cron/hourly', '/api/cron/daily']) {
      const r = await fetch(`${BASE_URL}${lauf}`, { headers: { authorization: `Bearer ${PRUEF_SICHERHEITSBERICHT_TOKEN}` } });
      assert.equal(r.status, 401, lauf);
    }
  });

  it('… liest aber den Betriebszustand für die Überwachung: Läufe, Schadsoftwareprüfer, Sicherung, Wiederherstellung', async (t) => {
    const ohne = await fetch(`${BASE_URL}/api/cron/status`);
    assert.equal(ohne.status, 401);
    const falsch = await fetch(`${BASE_URL}/api/cron/status`, { headers: { authorization: 'Bearer falsch' } });
    assert.equal(falsch.status, 401);

    const db = testDb();
    if (!db) return t.skip('keine Testdatenbank');
    // Eine Sicherung und eine bestandene Probe melden — getrennt ausgewertet,
    // obwohl beide unter BACKUP laufen.
    assert.equal((await senden(bericht({ quelle: 'BACKUP', zusammenfassung: `${MARKE}: Sicherung`, kennzahlen: { backupAlterStunden: 0 } }))).status, 201);
    assert.equal((await senden(bericht({ quelle: 'BACKUP', zusammenfassung: `${MARKE}: Probe`, kennzahlen: { wiederherstellungErgebnis: 'bestanden' } }))).status, 201);

    const r = await fetch(`${BASE_URL}/api/cron/status`, { headers: { authorization: `Bearer ${PRUEF_SICHERHEITSBERICHT_TOKEN}` } });
    // Der Statuscode sagt weiterhin nur etwas über die Läufe (200 oder 503).
    assert.ok([200, 503].includes(r.status), `HTTP ${r.status}`);
    const zustand = (await r.json()) as {
      gesund: boolean;
      betrieb: {
        schadsoftwarepruefer: { eingerichtet: boolean; art: string };
        sicherung: { frisch: boolean; alterStunden: number | null };
        wiederherstellung: { frisch: boolean; alterStunden: number | null };
      };
    };
    assert.equal(typeof zustand.gesund, 'boolean');
    assert.equal(typeof zustand.betrieb.schadsoftwarepruefer.eingerichtet, 'boolean');
    assert.equal(zustand.betrieb.sicherung.frisch, true);
    assert.equal(zustand.betrieb.sicherung.alterStunden, 0);
    assert.equal(zustand.betrieb.wiederherstellung.frisch, true);
    // Keine Inhalte: kein Pfad, kein Hash, keine Verbindungsangabe.
    assert.doesNotMatch(JSON.stringify(zustand), /postgres|\.dump|sha256|password/i);
  });

  it('ungültige Inhalte: 422 — unbekannte Quelle, zu viele Befunde, zu lange Texte, Zeit in der Zukunft', async () => {
    assert.equal((await senden(bericht({ quelle: 'SHELL' }))).status, 422);
    const viele = Array.from({ length: 201 }, (_, i) => ({ titel: `Befund ${i}`, schwere: 'info' }));
    assert.equal((await senden(bericht({ befunde: viele }))).status, 422);
    assert.equal((await senden(bericht({ zusammenfassung: 'x'.repeat(501) }))).status, 422);
    assert.equal((await senden(bericht({ erstelltAm: new Date(Date.now() + 3 * 86_400_000).toISOString() }))).status, 422);
    assert.equal((await senden(bericht({ kennzahlen: { 'bad key!': 1 } }))).status, 422);
  });

  it('kein JSON: 400; mehr als 512 kB: 400', async () => {
    assert.equal((await senden(null, PRUEF_SICHERHEITSBERICHT_TOKEN, '{kein json')).status, 400);
    const gross = JSON.stringify(bericht({ zusammenfassung: 'kurz', auffuellung: 'x'.repeat(600 * 1024) }));
    assert.equal((await senden(null, PRUEF_SICHERHEITSBERICHT_TOKEN, gross)).status, 400);
  });

  it('kritisch: ein Sicherheitsereignis beim Wechsel, nicht bei jedem weiteren Bericht', async (t) => {
    const db = testDb();
    if (!db) return t.skip('keine Testdatenbank');
    const kritisch = bericht({ quelle: 'ZAP_BASELINE', status: 'KRITISCH', zusammenfassung: `${MARKE}: Kopfzeile fehlt`, befunde: [{ titel: 'Content-Security-Policy fehlt', schwere: 'hoch' }] });
    assert.equal((await senden(kritisch)).status, 201);
    assert.equal((await senden(kritisch)).status, 201);
    const ereignisse = await db.securityEvent.count({ where: { kind: 'SECURITY_REPORT_CRITICAL', summary: { contains: MARKE } } });
    assert.equal(ereignisse, 1);
  });
});

describe('Anzeige in der Sicherheitszentrale', () => {
  it('die Systemverantwortung sieht Quelle, Zustand und Kennzahlen — Markup als Text', async () => {
    assert.equal((await senden(bericht({ quelle: 'BACKUP', zusammenfassung: `${MARKE}: <script>alert(1)</script>`, kennzahlen: { backupAlterStunden: 3 } }))).status, 201);
    const seite = await get('/admin/sicherheit', { jar: jars.super });
    assert.equal(seite.status, 200);
    const html = seite.text.replace(/<!-- -->/g, '');
    assert.ok(html.includes('data-sicherheitsberichte'), 'Abschnitt fehlt');
    assert.ok(html.includes('data-quelle="BACKUP"'));
    assert.ok(html.includes(`${MARKE}: &lt;script&gt;alert(1)&lt;/script&gt;`), 'Zusammenfassung nicht maskiert');
    assert.ok(!html.includes(`${MARKE}: <script>`), 'Markup aus einem Bericht wurde als HTML ausgeliefert');
    assert.ok(html.includes('Letzte Sicherung vor'));
    assert.ok(html.includes('Content-Security-Policy fehlt'), 'hoher Befund nicht aufgeführt');
  });

  /** Die Tabellenzeile einer Quelle aus dem ausgelieferten HTML. */
  const zeileVon = (html: string, quelle: string): string =>
    [...html.matchAll(/<tr[^>]*data-quelle="(\w+)"[\s\S]*?<\/tr>/g)].find((m) => m[1] === quelle)?.[0] ?? '';

  it('eine Quelle ohne Bericht heisst „Noch nie gemeldet", nicht „in Ordnung"', async (t) => {
    const db = testDb();
    if (!db) return t.skip('keine Testdatenbank');
    // Nur in der Testdatenbank: Die Quelle wird geleert, damit der Fall
    // eindeutig ist.
    await db.securityReport.deleteMany({ where: { source: 'HOST_INTEGRITY' } });
    const html = (await get('/admin/sicherheit', { jar: jars.super })).text.replace(/<!-- -->/g, '');
    assert.match(zeileVon(html, 'HOST_INTEGRITY'), /Noch nie gemeldet/);
  });

  it('ein grüner Bericht, der zu alt ist, heisst „Ausgeblieben"', async (t) => {
    const db = testDb();
    if (!db) return t.skip('keine Testdatenbank');
    await db.securityReport.deleteMany({ where: { source: 'DEPENDENCY_CHECK' } });
    const org = await db.organization.findFirstOrThrow({ where: { slug: process.env.ORGANIZATION_SLUG ?? 'clenaris' }, select: { id: true } });
    const vor3Tagen = new Date(Date.now() - 3 * 86_400_000);
    await db.securityReport.create({
      data: { organizationId: org.id, source: 'DEPENDENCY_CHECK', status: 'OK', summary: `${MARKE}: alt`, details: {}, reportedAt: vor3Tagen, receivedAt: vor3Tagen },
    });
    const zeile = zeileVon((await get('/admin/sicherheit', { jar: jars.super })).text.replace(/<!-- -->/g, ''), 'DEPENDENCY_CHECK');
    assert.match(zeile, /Ausgeblieben/);
    assert.doesNotMatch(zeile, /In Ordnung/);
  });

  // Wie in `sicherheitszentrum.test.ts`: Die Seite antwortet 404, die
  // Middleware leitet bei manchen Rollen schon vorher um — beides ist richtig,
  // beides ist nicht 200, und kein Bericht darf durchscheinen.
  it('Administration und Betriebsleitung sehen die Berichte nicht', async () => {
    for (const rolle of ['admin', 'manager'] as AccountName[]) {
      const r = await get('/admin/sicherheit', { jar: jars[rolle], redirect: 'manual' });
      assert.notEqual(r.status, 200, rolle);
      assert.ok(!r.text.includes('data-sicherheitsberichte') && !r.text.includes(MARKE), `${rolle}: Berichtsinhalt sichtbar`);
    }
  });
});
