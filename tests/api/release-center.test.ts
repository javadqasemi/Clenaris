import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BASE_URL, call, data, get, post, put, requireServer } from '../helpers/client';
import { ACCOUNTS, loginAll, type AccountName } from '../helpers/accounts';
import { eigeneOrganisationId, testDb, testDbSchliessen } from '../helpers/testdb';
import { PRUEF_AUSFUEHRER_SCHLUESSEL, PRUEF_AUSFUEHRER_TOKEN, PRUEF_SICHERHEITSBERICHT_TOKEN } from '../helpers/webhooks';
import { SIGNATUR_KOPF, ZEIT_KOPF, signieren } from '../../src/lib/release/ausfuehrer-signatur';

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
/** Versionen für den Block „Release-Ausführer". */
const AUSF = `9.${RUN % 1_000_000}.1`;
const AUSF_ROT = `9.${RUN % 1_000_000}.2`;
const AUSF_WERKZEUG = `9.${RUN % 1_000_000}.3`;
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
  // Auch Reste abgebrochener Läufe (andere RUN-Nummer): Ein liegengebliebener,
  // fälliger Prüfauftrag würde sonst vom Werkzeug im nächsten Lauf abgeholt.
  const releases = await db.release.findMany({
    where: { OR: [{ version: { in: [NEU, ALT, AUSF, AUSF_ROT, AUSF_WERKZEUG] } }, { summary: { startsWith: 'Prüfversion' } }] },
    select: { id: true },
  });
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

  /**
   * Bis 2026-09-27 hiess dieser Fall „kein Zustand behauptet eine Ausführung"
   * und verlangte genau drei Auftragszustände — richtig, solange es keinen
   * Ausführer gab. Seither gibt es ihn (Block unten), und die Zustände
   * DEPLOYING bis ROLLED_BACK haben einen Weg. Was bleibt und hier geprüft
   * wird: Die Anwendung selbst führt nichts aus — kein Auftrag trägt ein Ziel
   * oder einen Befehl, und kein Endpunkt der Oberfläche führt in einen
   * Ausführungszustand.
   */
  it('die Anwendung führt nichts aus: kein Ziel, kein Befehl, Ausführungszustände nur über den Ausführer', async (t) => {
    if (!db) return t.skip('keine Testdatenbank');
    const spalten = await db!.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'release_requests'`;
    const namen = spalten.map((s) => s.column_name.toLowerCase());
    for (const verboten of ['host', 'target', 'ziel', 'command', 'script', 'ssh']) {
      assert.ok(!namen.some((n) => n.includes(verboten)), `Spalte mit ${verboten}`);
    }
    const werte = await db!.$queryRaw<{ v: string }[]>`SELECT unnest(enum_range(NULL::"ReleaseRequestStatus"))::text AS v`;
    assert.deepEqual(werte.map((w) => w.v).sort(), ['APPROVED', 'CANCELLED', 'DEPLOYING', 'FAILED', 'ROLLED_BACK', 'SCHEDULED', 'SUCCEEDED']);
    // Kein Endpunkt nimmt eine Versionsbeschreibung an.
    assert.ok([404, 405].includes((await call('POST', '/api/system/releases', { jar: jars.super, body: { version: '99.0.0' } })).status));
  });
});

// ===========================================================================
//  Release-Ausführer (2026-09-27)
// ===========================================================================

/**
 * Die Schnittstelle, über die ein vertrauenswürdiger Ausführer ausserhalb der
 * Anwendung fällige Aufträge abholt, übernimmt und das Ergebnis meldet —
 * geprüft mit echten Signaturen gegen den Testserver (Umgebung `test`).
 */
describe('Release-Ausführer', { concurrency: 1 }, () => {
  const SUMME = createHash('sha256').update(`artefakt-${RUN}`).digest('hex');
  const COMMIT = createHash('sha1').update(`commit-${RUN}`).digest('hex');
  let org = '';
  let superId = '';
  let auftragId = '';
  let rotAuftragId = '';

  async function ausfuehrer(
    methode: 'GET' | 'POST',
    pfad: string,
    rumpf?: unknown,
    o: { token?: string | null; schluessel?: string; zeit?: number; signaturPfad?: string } = {},
  ) {
    const text = rumpf === undefined ? '' : JSON.stringify(rumpf);
    const zeit = o.zeit ?? Math.floor(Date.now() / 1000);
    const headers: Record<string, string> = {
      [ZEIT_KOPF]: String(zeit),
      [SIGNATUR_KOPF]: signieren(o.schluessel ?? PRUEF_AUSFUEHRER_SCHLUESSEL, { methode, pfad: o.signaturPfad ?? pfad, zeit, rumpf: text }),
    };
    if (o.token !== null) headers.authorization = `Bearer ${o.token ?? PRUEF_AUSFUEHRER_TOKEN}`;
    if (rumpf !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(`${BASE_URL}${pfad}`, { method: methode, headers, body: rumpf === undefined ? undefined : text });
    const inhalt = await r.text();
    let daten: Record<string, unknown> | null = null;
    try {
      daten = (JSON.parse(inhalt) as { data?: Record<string, unknown> }).data ?? null;
    } catch {
      /* kein JSON */
    }
    return { status: r.status, text: inhalt, daten };
  }

  const uebernahme = (ueber: Record<string, unknown> = {}) => ({
    auftragId,
    umgebung: 'test',
    ausfuehrer: 'pruefreihe/test',
    ausfuehrungsSchluessel: `lauf-${RUN}-eins`,
    artefaktSha256: SUMME,
    ciNachweis: `https://github.com/beispiel/clenaris/actions/runs/${RUN}`,
    ...ueber,
  });

  before(async () => {
    if (!db) return;
    org = (await eigeneOrganisationId())!;
    superId = (await db.user.findUniqueOrThrow({ where: { email: ACCOUNTS.super.email }, select: { id: true } })).id;
    const basis = {
      releasedAt: new Date(),
      summary: 'Prüfversion für den Release-Ausführer.',
      migrations: [],
      expectedDowntimeMinutes: 2,
      commit: COMMIT,
      artifactSha256: SUMME,
      artifactSizeBytes: 1024,
    };
    const gruen = await db.release.create({ data: { ...basis, version: AUSF, kind: 'MINOR', ciStatus: 'PASSED' } });
    const rot = await db.release.create({ data: { ...basis, version: AUSF_ROT, kind: 'MINOR', ciStatus: 'FAILED' } });
    // Terminiert und fällig — über die Oberfläche geht das nur 15 Minuten
    // voraus; die Prüfung legt den Zustand direkt an, wie er nach Ablauf wäre.
    const faellig = { organizationId: org, status: 'SCHEDULED' as const, fromVersion: '1.0.0', scheduledFor: new Date(Date.now() - 60_000), approvedById: superId, approvedAt: new Date(), scheduledById: superId, scheduledAt: new Date() };
    auftragId = (await db.releaseRequest.create({ data: { ...faellig, releaseId: gruen.id, toVersion: AUSF } })).id;
    rotAuftragId = (await db.releaseRequest.create({ data: { ...faellig, releaseId: rot.id, toVersion: AUSF_ROT } })).id;
  });

  it('ohne Token, ohne gültige Signatur, mit alter Zeit oder anderem Pfad: 401 — nichts übernommen', async (t) => {
    if (!db) return t.skip('keine Testdatenbank');
    const pfad = '/api/cron/release-auftraege/uebernehmen';
    assert.equal((await ausfuehrer('POST', pfad, uebernahme(), { token: null })).status, 401, 'ohne Token');
    assert.equal((await ausfuehrer('POST', pfad, uebernahme(), { token: 'falsch' })).status, 401, 'falsches Token');
    assert.equal((await ausfuehrer('POST', pfad, uebernahme(), { schluessel: 'falscher-schluessel' })).status, 401, 'falscher Schlüssel');
    assert.equal((await ausfuehrer('POST', pfad, uebernahme(), { zeit: Math.floor(Date.now() / 1000) - 600 })).status, 401, 'zehn Minuten alt');
    assert.equal(
      (await ausfuehrer('POST', pfad, uebernahme(), { signaturPfad: '/api/cron/release-auftraege/ergebnis' })).status,
      401,
      'Signatur für einen anderen Pfad',
    );
    // Das Cron-Geheimnis öffnet diese Tür nicht.
    assert.equal((await ausfuehrer('GET', '/api/cron/release-auftraege?umgebung=test', undefined, { token: process.env.CRON_SECRET ?? 'cron' })).status, 401);
    assert.equal((await db.releaseRequest.findUniqueOrThrow({ where: { id: auftragId } })).status, 'SCHEDULED');
  });

  it('fällige Aufträge: nur die eigene Umgebung, mit Rücksprung und Hindernis', async (t) => {
    if (!db) return t.skip('keine Testdatenbank');
    assert.equal((await ausfuehrer('GET', '/api/cron/release-auftraege?umgebung=production')).status, 422, 'fremde Umgebung');
    const r = await ausfuehrer('GET', '/api/cron/release-auftraege?umgebung=test');
    assert.equal(r.status, 200, r.text);
    const liste = (r.daten!.auftraege as { auftragId: string; commit: string; artefaktSha256: string; hindernis: string | null; ruecksprung: { aufVersion: string } }[]);
    const gruen = liste.find((a) => a.auftragId === auftragId);
    const rot = liste.find((a) => a.auftragId === rotAuftragId);
    assert.ok(gruen && rot, 'fällige Aufträge fehlen');
    assert.equal(gruen.hindernis, null);
    assert.equal(gruen.commit, COMMIT);
    assert.equal(gruen.artefaktSha256, SUMME);
    assert.equal(gruen.ruecksprung.aufVersion, '1.0.0');
    assert.match(rot.hindernis ?? '', /Prüfstufe/);
  });

  it('Übernahme: falsche Summe, CI rot, fremde Umgebung → 422; richtig → 200; Wiederholung → 200; zweiter Ausführer → 409', async (t) => {
    if (!db) return t.skip('keine Testdatenbank');
    const pfad = '/api/cron/release-auftraege/uebernehmen';
    assert.equal((await ausfuehrer('POST', pfad, uebernahme({ artefaktSha256: 'f'.repeat(64) }))).status, 422, 'falsche Summe');
    assert.equal((await ausfuehrer('POST', pfad, uebernahme({ auftragId: rotAuftragId }))).status, 422, 'CI nicht bestanden');
    assert.equal((await ausfuehrer('POST', pfad, uebernahme({ umgebung: 'production' }))).status, 422, 'fremde Umgebung');
    assert.equal((await db.releaseRequest.findUniqueOrThrow({ where: { id: auftragId } })).status, 'SCHEDULED');

    const erst = await ausfuehrer('POST', pfad, uebernahme());
    assert.equal(erst.status, 200, erst.text);
    assert.equal(erst.daten!.wiederholt, false);
    const nochmal = await ausfuehrer('POST', pfad, uebernahme());
    assert.equal(nochmal.status, 200, nochmal.text);
    assert.equal(nochmal.daten!.wiederholt, true);
    const zweiter = await ausfuehrer('POST', pfad, uebernahme({ ausfuehrungsSchluessel: `lauf-${RUN}-zwei`, ausfuehrer: 'pruefreihe/zweiter' }));
    assert.equal(zweiter.status, 409, zweiter.text);

    const zeile = await db.releaseRequest.findUniqueOrThrow({ where: { id: auftragId } });
    assert.equal(zeile.status, 'DEPLOYING');
    assert.equal(zeile.verifiedSha256, SUMME);
    assert.equal(zeile.environment, 'test');
    assert.match(zeile.ciEvidence ?? '', /actions\/runs/);
  });

  it('während der Ausführung: das Dashboard entscheidet nicht mit und zeigt die Ausführung', async (t) => {
    if (!db) return t.skip('keine Testdatenbank');
    const release = await db.release.findUniqueOrThrow({ where: { version: AUSF } });
    assert.equal(await zustandVon(release.id), 'DEPLOYING');
    assert.equal((await post(`/api/system/releases/${release.id}/freigabe`, undefined, { jar: jars.super })).status, 422);
    assert.equal((await put(`/api/system/releases/${release.id}/termin`, { scheduledFor: new Date(Date.now() + 86_400_000).toISOString() }, { jar: jars.super })).status, 422);
    const seite = (await get(`/admin/updates/${release.id}`, { jar: jars.super })).text.replace(/<!-- -->/g, '');
    for (const text of ['Wird installiert', 'In Ausführung', 'pruefreihe/test', 'CI-Lauf']) {
      assert.ok(seite.includes(text), `fehlt: ${text}`);
    }
  });

  it('Ergebnis: fremder Schlüssel 409, „erfolgreich" ohne Zielversion 422, fehlgeschlagen 200, Wiederholung 200, Widerspruch 409', async (t) => {
    if (!db) return t.skip('keine Testdatenbank');
    const pfad = '/api/cron/release-auftraege/ergebnis';
    const meldung = (ueber: Record<string, unknown>) => ({ auftragId, ausfuehrungsSchluessel: `lauf-${RUN}-eins`, ...ueber });
    assert.equal((await ausfuehrer('POST', pfad, meldung({ ausfuehrungsSchluessel: `lauf-${RUN}-zwei`, ergebnis: 'FAILED' }))).status, 409);
    assert.equal((await ausfuehrer('POST', pfad, meldung({ ergebnis: 'SUCCEEDED', laufendeVersion: '1.0.0' }))).status, 422);
    const fehl = await ausfuehrer('POST', pfad, meldung({ ergebnis: 'FAILED', meldung: 'Health Check meldete die alte Version.' }));
    assert.equal(fehl.status, 200, fehl.text);
    assert.equal((await ausfuehrer('POST', pfad, meldung({ ergebnis: 'FAILED' }))).daten?.wiederholt, true);
    assert.equal((await ausfuehrer('POST', pfad, meldung({ ergebnis: 'SUCCEEDED', laufendeVersion: AUSF }))).status, 409);
    const zeile = await db.releaseRequest.findUniqueOrThrow({ where: { id: auftragId } });
    assert.equal(zeile.status, 'FAILED');
    assert.ok(zeile.finishedAt);
  });

  it('Prüfprotokoll: Übernahme und Ergebnis, ohne Benutzer, mit Ausführer und Nachweis', async (t) => {
    if (!db) return t.skip('keine Testdatenbank');
    const eintraege = await db.auditLog.findMany({ where: { entity: 'ReleaseRequest', entityId: auftragId }, orderBy: { createdAt: 'asc' } });
    assert.deepEqual(
      eintraege.map((e) => (e.changes as { status?: { to: string } }).status?.to),
      ['DEPLOYING', 'FAILED'],
    );
    for (const e of eintraege) {
      assert.equal(e.userId, null);
      assert.equal((e.changes as { ausfuehrer?: string }).ausfuehrer, 'pruefreihe/test');
    }
    assert.equal((eintraege[0]!.changes as { artefaktSha256?: string }).artefaktSha256, SUMME);
    const alles = JSON.stringify(eintraege);
    assert.ok(!alles.includes(PRUEF_AUSFUEHRER_TOKEN) && !alles.includes(PRUEF_AUSFUEHRER_SCHLUESSEL), 'Geheimnis im Protokoll');
  });

  it('das Werkzeug scripts/release-ausfuehrer.ts: misst, übernimmt, meldet — mit derselben Signatur', async (t) => {
    if (!db) return t.skip('keine Testdatenbank');
    // Ein eigenes Artefakt: Bytes, Prüfsummendatei, Manifest — wie
    // `scripts/release-artefakt.ts` sie ablegt.
    const verzeichnis = mkdtempSync(join(tmpdir(), 'clenaris-ausfuehrer-'));
    const commit = createHash('sha1').update(`werkzeug-${RUN}`).digest('hex');
    const name = `clenaris-${commit.slice(0, 12)}`;
    const bytes = Buffer.from(`Prüfartefakt ${RUN}`);
    const summe = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(join(verzeichnis, `${name}.tar.gz`), bytes);
    writeFileSync(join(verzeichnis, `${name}.tar.gz.sha256`), `${summe}  ${name}.tar.gz\n`);
    writeFileSync(join(verzeichnis, `${name}.json`), JSON.stringify({ commit, auslieferbar: true, archivSha256: summe }));
    const release = await db.release.create({
      data: { version: AUSF_WERKZEUG, releasedAt: new Date(), kind: 'PATCH', summary: 'Prüfversion für das Werkzeug.', ciStatus: 'PASSED', commit, artifactSha256: summe },
    });
    const auftrag = await db.releaseRequest.create({
      data: { organizationId: org, releaseId: release.id, status: 'SCHEDULED', fromVersion: '1.0.0', toVersion: AUSF_WERKZEUG, scheduledFor: new Date(Date.now() - 60_000), approvedById: superId, approvedAt: new Date() },
    });
    // Der rote Auftrag liegt noch fällig da; das Werkzeug überspringt ihn mit Begründung.
    const umgebung = { ...process.env, CLENARIS_URL: BASE_URL, RELEASE_EXECUTOR_TOKEN: PRUEF_AUSFUEHRER_TOKEN, RELEASE_EXECUTOR_SIGNING_KEY: PRUEF_AUSFUEHRER_SCHLUESSEL, GITHUB_OUTPUT: '' };
    const werkzeug = (...args: string[]) =>
      spawnSync(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), 'scripts/release-ausfuehrer.ts', ...args], { env: umgebung, encoding: 'utf8' });
    try {
      const abholen = werkzeug('abholen', '--umgebung', 'test', '--artefakte', verzeichnis, '--ausfuehrer', 'pruefreihe/werkzeug', '--schluessel', `werkzeug-${RUN}-lauf`, '--ci-nachweis', `https://github.com/beispiel/clenaris/actions/runs/${RUN}`);
      assert.equal(abholen.status, 0, `${abholen.stdout}\n${abholen.stderr}`);
      assert.match(abholen.stdout, new RegExp(`auftrag=${auftrag.id}`));
      assert.match(abholen.stdout, /Übersprungen .*Prüfstufe/);
      assert.equal((await db.releaseRequest.findUniqueOrThrow({ where: { id: auftrag.id } })).status, 'DEPLOYING');

      const melden = werkzeug('melden', '--auftrag', auftrag.id, '--schluessel', `werkzeug-${RUN}-lauf`, '--ergebnis', 'ROLLED_BACK', '--meldung', 'Health Check fehlgeschlagen, Rücksprung.');
      assert.equal(melden.status, 0, `${melden.stdout}\n${melden.stderr}`);
      const zeile = await db.releaseRequest.findUniqueOrThrow({ where: { id: auftrag.id } });
      assert.equal(zeile.status, 'ROLLED_BACK');
      assert.equal(zeile.rollbackVersion, '1.0.0');

      // Ein Artefakt, dessen Bytes nicht zur Summe passen, wird nicht übernommen.
      const faelschung = await db.releaseRequest.create({
        data: { organizationId: org, releaseId: release.id, status: 'SCHEDULED', fromVersion: '1.0.0', toVersion: AUSF_WERKZEUG, scheduledFor: new Date(Date.now() - 60_000), approvedById: superId, approvedAt: new Date() },
      });
      writeFileSync(join(verzeichnis, `${name}.tar.gz`), Buffer.from('andere Bytes'));
      const falsch = werkzeug('abholen', '--umgebung', 'test', '--artefakte', verzeichnis, '--ausfuehrer', 'pruefreihe/werkzeug', '--schluessel', `werkzeug-${RUN}-zwei`, '--ci-nachweis', `https://github.com/beispiel/clenaris/actions/runs/${RUN}`);
      assert.notEqual(falsch.status, 0, 'eine falsche Summe wurde übernommen');
      assert.equal((await db.releaseRequest.findUniqueOrThrow({ where: { id: faelschung.id } })).status, 'SCHEDULED');
    } finally {
      rmSync(verzeichnis, { recursive: true, force: true });
    }
  });
});
