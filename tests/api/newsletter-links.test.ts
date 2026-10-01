import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { get, post, requireServer } from '../helpers/client';
import { resetRateLimits } from '../helpers/rate-limit';
import { eigeneOrganisationId, fremdeOrganisation, schutzfreiAufraeumen, testDb, testDbGrund, testDbSchliessen } from '../helpers/testdb';

/**
 * Newsletter-Links: Erst der Klick schreibt, nicht der Seitenaufruf
 * (2026-09-27).
 *
 * Befund: Die Seiten `/newsletter/bestaetigen` und `/newsletter/abmelden`
 * schrieben beim Laden — ohne Organisation im `where` und ohne
 * Protokollzeile. Mailfilter rufen Links in E-Mails vorab auf; damit wurde
 * eine Anmeldung ohne die Person bestätigt (das Double-Opt-in bewies nichts)
 * und ein Abonnent ohne sein Zutun ausgetragen. Gegen den alten Stand
 * scheitert der erste Fall jedes Blocks: Nach dem blossen Seitenaufruf stand
 * `confirmed: true` bzw. `unsubscribedAt`.
 *
 * Die Einträge werden direkt in der Testdatenbank angelegt — der Anmeldeweg
 * selbst ist in `protokollpflicht` und `nebenlaeufigkeit` geprüft, und ein
 * Aufruf über das Formular verbrauchte hier das stündliche Newsletter-Limit.
 */

const db = testDb();
const MARKE = 'newsletter-links-pruef';
const ohneDb = { skip: db ? false : `Keine Testdatenbank: ${testDbGrund()}` };
let orgId = '';

async function aufraeumen() {
  if (!db) return;
  const eintraege = await db.newsletterSubscriber.findMany({ where: { email: { startsWith: MARKE } }, select: { id: true } });
  const ids = eintraege.map((e) => e.id);
  // Das Prüfprotokoll lässt sich nur fortschreiben (seit 2026-09-30) — den
  // eigenen Prüfbestand entfernt nur `schutzfreiAufraeumen`.
  if (ids.length) await schutzfreiAufraeumen((tx) => tx.auditLog.deleteMany({ where: { entity: 'NewsletterSubscriber', entityId: { in: ids } } }));
  await db.newsletterSubscriber.deleteMany({ where: { email: { startsWith: MARKE } } });
}

async function eintrag(teil: string, daten: { organizationId?: string; confirmed?: boolean; confirmToken?: string | null } = {}) {
  return db!.newsletterSubscriber.create({
    data: {
      organizationId: daten.organizationId ?? orgId,
      email: `${MARKE}.${teil}.${Date.now()}@example.ch`,
      confirmed: daten.confirmed ?? false,
      confirmToken: daten.confirmToken === undefined ? `bestaetigung-${teil}-${Date.now()}-pruef` : daten.confirmToken,
      unsubscribeToken: `abmeldung-${teil}-${Date.now()}-pruef`,
    },
  });
}

const protokoll = (id: string) => db!.auditLog.findMany({ where: { entity: 'NewsletterSubscriber', entityId: id } });

before(async () => {
  await requireServer();
  await resetRateLimits();
  orgId = (await eigeneOrganisationId()) ?? '';
  await aufraeumen();
});

after(async () => {
  await aufraeumen();
  await testDbSchliessen();
});

describe('Newsletter bestätigen — erst der Klick', () => {
  it('der Seitenaufruf allein bestätigt nichts und bietet die Schaltfläche an', ohneDb, async () => {
    const e = await eintrag('seite');
    const seite = await get(`/newsletter/bestaetigen?token=${e.confirmToken}`);
    assert.equal(seite.status, 200);
    assert.match(seite.text, /Anmeldung bestätigen/);
    const nachher = await db!.newsletterSubscriber.findUniqueOrThrow({ where: { id: e.id } });
    assert.equal(nachher.confirmed, false, 'der Seitenaufruf (etwa eines Mailfilters) hat die Anmeldung bestätigt');
    assert.equal(nachher.confirmToken, e.confirmToken, 'der Seitenaufruf hat den Token verbraucht');
    assert.equal((await protokoll(e.id)).length, 0);
  });

  it('der Klick bestätigt, entwertet den Token, protokolliert ohne Person — ein zweiter Klick ist 404', ohneDb, async () => {
    const e = await eintrag('klick');
    const antwort = await post('/api/public/newsletter/bestaetigen', { token: e.confirmToken });
    assert.equal(antwort.status, 200, antwort.text);
    const nachher = await db!.newsletterSubscriber.findUniqueOrThrow({ where: { id: e.id } });
    assert.equal(nachher.confirmed, true);
    assert.equal(nachher.confirmToken, null);
    const zeilen = await protokoll(e.id);
    assert.equal(zeilen.length, 1);
    assert.equal(zeilen[0]!.action, 'UPDATE');
    assert.equal(zeilen[0]!.userId, null);
    assert.equal(zeilen[0]!.organizationId, orgId);
    assert.ok(!JSON.stringify(zeilen[0]).includes(e.email), 'die E-Mail-Adresse steht in der Protokollzeile');
    assert.equal((await post('/api/public/newsletter/bestaetigen', { token: e.confirmToken })).status, 404);
  });

  it('der Token einer fremden Organisation ist unbekannt (404) und ändert nichts', ohneDb, async () => {
    const fremd = await fremdeOrganisation();
    assert.ok(fremd);
    const e = await eintrag('fremd', { organizationId: fremd });
    assert.equal((await post('/api/public/newsletter/bestaetigen', { token: e.confirmToken })).status, 404);
    assert.equal((await db!.newsletterSubscriber.findUniqueOrThrow({ where: { id: e.id } })).confirmed, false);
    const seite = await get(`/newsletter/bestaetigen?token=${e.confirmToken}`);
    assert.match(seite.text, /Bestätigung fehlgeschlagen/, 'die Seite behandelt einen fremden Link als gültig');
  });
});

describe('Newsletter abmelden — erst der Klick', () => {
  it('der Seitenaufruf allein meldet nicht ab und bietet die Schaltfläche an', ohneDb, async () => {
    const e = await eintrag('abmelden-seite', { confirmed: true, confirmToken: null });
    const seite = await get(`/newsletter/abmelden?token=${e.unsubscribeToken}`);
    assert.equal(seite.status, 200);
    assert.match(seite.text, /Newsletter abbestellen/);
    const nachher = await db!.newsletterSubscriber.findUniqueOrThrow({ where: { id: e.id } });
    assert.equal(nachher.unsubscribedAt, null, 'der Seitenaufruf (etwa eines Mailfilters) hat abgemeldet');
    assert.equal(nachher.confirmed, true);
  });

  it('der Klick meldet ab und protokolliert einmal — ein zweiter Klick ändert nichts', ohneDb, async () => {
    const e = await eintrag('abmelden-klick', { confirmed: true, confirmToken: null });
    assert.equal((await post('/api/public/newsletter/abmelden', { token: e.unsubscribeToken })).status, 200);
    const nachher = await db!.newsletterSubscriber.findUniqueOrThrow({ where: { id: e.id } });
    assert.ok(nachher.unsubscribedAt);
    assert.equal(nachher.confirmed, false);
    assert.equal((await post('/api/public/newsletter/abmelden', { token: e.unsubscribeToken })).status, 200);
    const zeilen = await protokoll(e.id);
    assert.equal(zeilen.length, 1, 'eine zweite Abmeldung hat eine zweite Protokollzeile geschrieben');
    assert.equal(zeilen[0]!.action, 'DELETE');
    assert.equal(zeilen[0]!.userId, null);
  });

  it('ein unbekannter Link ist 404, und die Seite sagt es', ohneDb, async () => {
    assert.equal((await post('/api/public/newsletter/abmelden', { token: 'gibt-es-nicht-0000000000' })).status, 404);
    const seite = await get('/newsletter/abmelden?token=gibt-es-nicht-0000000000');
    assert.match(seite.text, /Abmeldung nicht möglich/);
  });
});
