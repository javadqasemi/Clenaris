import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { BASE_URL, call, data, get, post, put, requireServer } from '../helpers/client';
import { ACCOUNTS, loginAll, type AccountName } from '../helpers/accounts';
import { testDb, testDbSchliessen } from '../helpers/testdb';
import { PRUEF_SICHERHEITSBERICHT_TOKEN } from '../helpers/webhooks';

/**
 * Update Center der Systemverantwortung (Produktsprint 2026-09-26).
 *
 * Geprüft wird, was eine Entscheidung ausmacht — wer sie treffen darf,
 * welche Übergänge es gibt, welche nicht, dass jede im Prüfprotokoll steht
 * und dass keine etwas *ausführt*. Die Versionen legt die Prüfung direkt in
 * der Testdatenbank an: Einen Endpunkt, der Versionen annimmt, gibt es
 * absichtlich nicht (`scripts/release-registrieren.ts`).
 */

const RUN = Date.now();
const NEU = `9.${RUN % 1_000_000}.0`;
const ALT = `0.0.${RUN % 1_000_000}`;
/** Eine gültig geformte Schweizer IBAN im Freitext — sie darf nicht ins Protokoll. */
const IBAN_IM_GRUND = 'CH93 0076 2011 6238 5295 7';
const db = testDb();
let jars: Record<AccountName, string>;
let neuId = '';
let altId = '';

type Uebersicht = { data: { laufend: string; releases: { release: { id: string; version: string }; zustand: string }[] } };
const zustandVon = async (id: string) =>
  data(await get<Uebersicht>('/api/system/releases', { jar: jars.super })).releases.find((r) => r.release.id === id)?.zustand;

async function aufraeumen() {
  if (!db) return;
  const releases = await db.release.findMany({ where: { version: { in: [NEU, ALT] } }, select: { id: true } });
  const ids = releases.map((r) => r.id);
  await db.releaseDeferral.deleteMany({ where: { releaseId: { in: ids } } });
  await db.releaseRequest.deleteMany({ where: { releaseId: { in: ids } } });
  await db.release.deleteMany({ where: { id: { in: ids } } });
}

before(async () => {
  await requireServer();
  jars = await loginAll();
  if (!db) return;
  await aufraeumen();
  const basis = {
    releasedAt: new Date(),
    summary: 'Prüfversion der Testreihe — Mehrfachleistungen, Update Center.',
    features: ['Buchungen mit mehreren Leistungen'],
    fixes: ['Verfügbarkeit berücksichtigt die Einsatzzeiten'],
    securityFixes: ['Sitzungsprüfung verschärft'],
    migrations: ['20260926100000_versionsverwaltung'],
    ciStatus: 'PASSED' as const,
    expectedDowntimeMinutes: 5,
    artifactSizeBytes: 48_000_000,
  };
  neuId = (await db.release.create({ data: { ...basis, version: NEU, kind: 'SECURITY', securitySeverity: 'HIGH' } })).id;
  altId = (await db.release.create({ data: { ...basis, version: ALT, kind: 'PATCH', securityFixes: [] } })).id;
});

after(async () => {
  await aufraeumen();
  await testDbSchliessen();
});

describe('Update Center', { concurrency: 1 }, () => {
  it('nur die Systemverantwortung — Seite und Endpunkte', async () => {
    assert.equal((await get('/api/system/releases', { jar: jars.super })).status, 200);
    for (const rolle of ['admin', 'manager', 'employee', 'customer'] as const) {
      assert.equal((await get('/api/system/releases', { jar: jars[rolle] })).status, 403, rolle);
    }
    assert.equal((await get('/api/system/releases')).status, 401);
    assert.equal((await get('/admin/updates', { jar: jars.super })).status, 200);
    const admin = await get('/admin/updates', { jar: jars.admin });
    assert.ok([307, 404].includes(admin.status), `Administration: HTTP ${admin.status}`);
  });

  it('die Administration kann nicht entscheiden', async (t) => {
    if (!db) return t.skip('keine Testdatenbank');
    assert.equal((await post(`/api/system/releases/${neuId}/freigabe`, undefined, { jar: jars.admin })).status, 403);
    assert.equal((await put(`/api/system/releases/${neuId}/termin`, { scheduledFor: new Date(Date.now() + 86_400_000).toISOString() }, { jar: jars.admin })).status, 403);
    assert.equal(await zustandVon(neuId), 'AVAILABLE');
  });

  it('das Dashboard meldet die neue Version der Systemverantwortung, sonst niemandem', async (t) => {
    if (!db) return t.skip('keine Testdatenbank');
    // React trennt benachbarte Textknoten im Server-HTML mit `<!-- -->`
    // („v" und die Nummer sind zwei Knoten) — vor dem Suchen entfernen.
    const html = (await get('/admin', { jar: jars.super })).text.replace(/<!-- -->/g, '');
    assert.ok(html.includes('Eine neue Clenaris-Version ist verfügbar'), 'Hinweis fehlt');
    assert.ok(html.includes(`v${NEU}`), 'Versionsnummer fehlt');
    const admin = await get('/admin', { jar: jars.admin });
    assert.ok(!admin.text.includes('Clenaris-Version'), 'die Administration sieht die Versionskarte');
  });

  it('die Detailansicht nennt Typ, Schwere, Sicherheitskorrekturen und Migrationen', async (t) => {
    if (!db) return t.skip('keine Testdatenbank');
    const seite = await get(`/admin/updates/${neuId}`, { jar: jars.super });
    assert.equal(seite.status, 200);
    for (const text of ['Sicherheitsupdate', 'Hoch', 'Sitzungsprüfung verschärft', '20260926100000_versionsverwaltung', 'ca. 5 Minuten']) {
      assert.ok(seite.text.includes(text), `fehlt: ${text}`);
    }
  });

  it('Sicherheitsupdates: Sicherheitsversion zum Entscheiden, Abhängigkeitsbefunde nur zur Einsicht', async (t) => {
    if (!db) return t.skip('keine Testdatenbank');
    const advisory = `GHSA-pruef-${RUN % 100000}`;
    const bericht = await fetch(`${BASE_URL}/api/cron/security-report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${PRUEF_SICHERHEITSBERICHT_TOKEN}` },
      body: JSON.stringify({
        quelle: 'SECURITY_CHECK',
        status: 'WARNUNG',
        erstelltAm: new Date().toISOString(),
        zusammenfassung: `Prüfreihe-${RUN}: Update Center`,
        befunde: [{ id: advisory, titel: 'pruefpaket (high): Prüflücke', schwere: 'hoch', details: 'Behebung: pruefpaket@2.0.0 (Hauptversion)' }],
      }),
    });
    assert.equal(bericht.status, 201, await bericht.text());
    try {
      const html = (await get('/admin/updates', { jar: jars.super })).text.replace(/<!-- -->/g, '');
      // Der Abschnitt reicht bis zur Überschrift der Versionsliste.
      const start = html.indexOf('data-sicherheitsupdates');
      assert.ok(start > 0, 'Abschnitt Sicherheitsupdates fehlt');
      const ende = html.indexOf('>Versionen<', start);
      const abschnitt = html.slice(start, ende > start ? ende : start + 8000);
      assert.ok(abschnitt.includes(`v${NEU}`), 'Sicherheitsversion fehlt');
      assert.ok(abschnitt.includes('prüfen, freigeben oder terminieren'));
      assert.ok(abschnitt.includes(`href="/admin/updates/${neuId}"`), 'kein Weg zur Entscheidung');
      assert.ok(abschnitt.includes(advisory) && abschnitt.includes('Prüflücke'), 'Abhängigkeitsbefund fehlt');
      // Einsicht, keine Handlung: im Abschnitt weder Formular noch Knopf —
      // entschieden wird auf der Detailseite.
      assert.ok(!/<form|<button/.test(abschnitt), 'Handlungselement im Abschnitt Sicherheitsupdates');
    } finally {
      await db!.securityReport.deleteMany({ where: { summary: `Prüfreihe-${RUN}: Update Center` } });
    }
  });

  it('freigeben → terminieren → verschieben → stornieren, und wieder freigeben', async (t) => {
    if (!db) return t.skip('keine Testdatenbank');
    const frei = await post<{ data: { status: string; fromVersion: string; toVersion: string } }>(`/api/system/releases/${neuId}/freigabe`, undefined, { jar: jars.super });
    assert.equal(frei.status, 200, frei.text);
    assert.equal(data(frei).status, 'APPROVED');
    assert.equal(data(frei).toVersion, NEU);
    assert.equal(await zustandVon(neuId), 'APPROVED');

    const morgen = new Date(Date.now() + 86_400_000).toISOString();
    const termin = await put<{ data: { status: string } }>(`/api/system/releases/${neuId}/termin`, { scheduledFor: morgen }, { jar: jars.super });
    assert.equal(termin.status, 200, termin.text);
    assert.equal(data(termin).status, 'SCHEDULED');

    const uebermorgen = new Date(Date.now() + 2 * 86_400_000).toISOString();
    assert.equal((await put(`/api/system/releases/${neuId}/termin`, { scheduledFor: uebermorgen }, { jar: jars.super })).status, 200);

    // Der Grund ist Freitext; die IBAN darin prüft unten, dass auch dieser Weg
    // ins Protokoll geschwärzt wird (bis 2026-09-27 ging er daran vorbei).
    const storno = await post<{ data: { status: string } }>(`/api/system/releases/${neuId}/termin/stornieren`, { grund: `Ferienzeit, Rückfragen an ${IBAN_IM_GRUND}` }, { jar: jars.super });
    assert.equal(storno.status, 200, storno.text);
    assert.equal(data(storno).status, 'CANCELLED');
    assert.equal(await zustandVon(neuId), 'AVAILABLE');

    // Nach dem Storno lässt sich die Version wieder freigeben — der stornierte
    // Auftrag bleibt als Nachweis, der partielle Index zählt nur offene.
    assert.equal((await post(`/api/system/releases/${neuId}/freigabe`, undefined, { jar: jars.super })).status, 200);
    const auftraege = await db!.releaseRequest.findMany({ where: { releaseId: neuId } });
    assert.deepEqual(auftraege.map((a) => a.status).sort(), ['APPROVED', 'CANCELLED']);
  });

  it('unzulässige Übergänge: 422', async (t) => {
    if (!db) return t.skip('keine Testdatenbank');
    // Schon freigegeben (aus dem Fall davor).
    assert.equal((await post(`/api/system/releases/${neuId}/freigabe`, undefined, { jar: jars.super })).status, 422);
    // Stornieren ohne Termin.
    assert.equal((await post(`/api/system/releases/${neuId}/termin/stornieren`, {}, { jar: jars.super })).status, 422);
    // Zurückstellen, obwohl freigegeben.
    assert.equal((await post(`/api/system/releases/${neuId}/zurueckstellen`, {}, { jar: jars.super })).status, 422);
    // Termin in der Vergangenheit.
    assert.equal((await put(`/api/system/releases/${neuId}/termin`, { scheduledFor: new Date(Date.now() - 60_000).toISOString() }, { jar: jars.super })).status, 422);
    // Eine ältere Version: keine Rückstufung über das Dashboard.
    assert.equal((await post(`/api/system/releases/${altId}/freigabe`, undefined, { jar: jars.super })).status, 422);
    assert.equal(await zustandVon(altId), 'OLDER');
    // Unbekannte Felder im Körper werden abgewiesen, nicht verworfen.
    assert.equal((await post(`/api/system/releases/${neuId}/termin/stornieren`, { ziel: '2.29.18.45' }, { jar: jars.super })).status, 422);
  });

  it('gleichzeitige Freigaben: genau eine gilt', async (t) => {
    if (!db) return t.skip('keine Testdatenbank');
    await db!.releaseRequest.deleteMany({ where: { releaseId: neuId } });
    const [a, b] = await Promise.all([
      post(`/api/system/releases/${neuId}/freigabe`, undefined, { jar: jars.super }),
      post(`/api/system/releases/${neuId}/freigabe`, undefined, { jar: jars.super }),
    ]);
    const status = [a.status, b.status].sort();
    assert.equal(status[0], 200, `${a.text} | ${b.text}`);
    assert.ok([409, 422].includes(status[1]!), `zweite Freigabe: HTTP ${status[1]}`);
    assert.equal(await db!.releaseRequest.count({ where: { releaseId: neuId, status: { in: ['APPROVED', 'SCHEDULED'] } } }), 1);
  });

  it('„Nicht jetzt" stellt eine verfügbare Version zurück', async (t) => {
    if (!db) return t.skip('keine Testdatenbank');
    await db!.releaseRequest.deleteMany({ where: { releaseId: neuId } });
    const r = await post(`/api/system/releases/${neuId}/zurueckstellen`, { tage: 3 }, { jar: jars.super });
    assert.equal(r.status, 200, r.text);
    const dashboard = await get('/admin', { jar: jars.super });
    assert.ok(dashboard.text.includes('Zurückgestellt bis'), 'das Dashboard drängt die zurückgestellte Version weiter vor');
  });

  it('jede Entscheidung steht im Prüfprotokoll — mit Person, Versionen und ohne Geheimnisse', async (t) => {
    if (!db) return t.skip('keine Testdatenbank');
    const person = await db!.user.findUnique({ where: { email: ACCOUNTS.super.email }, select: { id: true } });
    const eintraege = await db!.auditLog.findMany({
      where: { entity: { in: ['ReleaseRequest', 'ReleaseDeferral'] }, summary: { contains: NEU } },
      orderBy: { createdAt: 'asc' },
    });
    const texte = eintraege.map((e) => e.summary ?? '');
    for (const muster of [/freigegeben/, /terminiert/, /verschoben/, /storniert: Ferienzeit/, /zurückgestellt/]) {
      assert.ok(texte.some((s) => muster.test(s)), `kein Eintrag für ${muster}`);
    }
    for (const e of eintraege) {
      assert.equal(e.userId, person?.id);
      const changes = e.changes as Record<string, unknown>;
      assert.equal(changes.zielVersion, NEU);
      assert.ok(typeof changes.vonVersion === 'string');
      assert.ok(!JSON.stringify(changes).match(/token|secret|passw|ssh|key/i), 'Geheimnis im Protokoll');
    }
    // Die Freigaben schrieben ihren Eintrag direkt mit `tx.auditLog.create` —
    // an der Schwärzung vorbei. Die IBAN aus dem Stornogrund darf nirgends im
    // Protokoll stehen, weder in der Zusammenfassung noch in den Änderungen.
    const alles = JSON.stringify(eintraege.map((e) => [e.summary, e.changes]));
    assert.ok(!alles.includes(IBAN_IM_GRUND) && !alles.includes('CH9300762011623852957'), 'IBAN im Klartext im Prüfprotokoll');
    assert.ok(texte.some((s) => s.includes('[IBAN redigiert]')), 'der Stornogrund fehlt oder wurde nicht geschwärzt');
    const verschoben = eintraege.find((e) => /verschoben/.test(e.summary ?? ''));
    const termin = (verschoben?.changes as { termin?: { from: string | null; to: string } }).termin;
    assert.ok(termin?.from && termin.to && termin.from !== termin.to, 'alter und neuer Termin fehlen');
  });

  it('nichts wird ausgeführt: kein Auftrag trägt ein Ziel, kein Zustand behauptet eine Ausführung', async (t) => {
    if (!db) return t.skip('keine Testdatenbank');
    const spalten = await db!.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'release_requests'`;
    const namen = spalten.map((s) => s.column_name.toLowerCase());
    for (const verboten of ['host', 'target', 'ziel', 'command', 'script', 'ssh']) {
      assert.ok(!namen.some((n) => n.includes(verboten)), `Spalte mit ${verboten}`);
    }
    const werte = await db!.$queryRaw<{ v: string }[]>`SELECT unnest(enum_range(NULL::"ReleaseRequestStatus"))::text AS v`;
    assert.deepEqual(werte.map((w) => w.v).sort(), ['APPROVED', 'CANCELLED', 'SCHEDULED']);
    // Kein Endpunkt nimmt eine Versionsbeschreibung an.
    assert.ok([404, 405].includes((await call('POST', '/api/system/releases', { jar: jars.super, body: { version: '99.0.0' } })).status));
  });
});
