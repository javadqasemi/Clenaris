import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { get, post, requireServer } from '../helpers/client';
import { loginAll, type AccountName } from '../helpers/accounts';
import { eigeneOrganisationId, testDb, testDbSchliessen } from '../helpers/testdb';

/**
 * Obergrenzen der Listen und Zeiträume (Phase 23, 2026-09-27).
 *
 * Jede Prüfung hier stand vorher ungebremst: Kalender und Exporte nahmen
 * jeden Zeitraum an, die Benutzerliste lud alle Konten samt gelöschten, das
 * Portal liess mit `?alle=1` die Grenze ganz fallen. Geprüft wird, dass die
 * Grenze greift — und dass die Oberfläche sie im Alltag nicht erreicht.
 */

let jars: Record<AccountName, string>;

before(async () => {
  await requireServer();
  jars = await loginAll();
});

after(async () => {
  await testDbSchliessen();
});

const tag = (versatz: number) => new Date(Date.now() + versatz * 86_400_000).toISOString();

describe('Obergrenzen', { concurrency: 1 }, () => {
  it('Kalender: sechs Wochen ja, zehn Jahre nein', async () => {
    const monat = await get(`/api/jobs/calendar?from=${tag(-7)}&to=${tag(35)}`, { jar: jars.admin });
    assert.equal(monat.status, 200, monat.text);
    const jahrzehnt = await get(`/api/jobs/calendar?from=${tag(-3650)}&to=${tag(0)}`, { jar: jars.admin });
    assert.equal(jahrzehnt.status, 422, jahrzehnt.text);
  });

  it('Exporte: ein Jahr ja, mehr nein — auch der Buchhaltungsexport', async () => {
    const jahr = new Date().getUTCFullYear();
    assert.equal((await get(`/api/exports/rechnungen?from=${jahr}-01-01&to=${jahr}-12-31`, { jar: jars.admin })).status, 200);
    const zuLang = await get(`/api/exports/rechnungen?from=${jahr - 5}-01-01&to=${jahr}-12-31`, { jar: jars.admin });
    assert.equal(zuLang.status, 422, zuLang.text);
    const buchhaltung = await post('/api/exports/buchhaltung', { format: 'csv', periodFrom: `${jahr - 3}-01-01`, periodTo: `${jahr}-12-31` }, { jar: jars.admin });
    assert.equal(buchhaltung.status, 422, buchhaltung.text);
  });

  it('Benutzerkonten: seitenweise mit Gesamtzahl, höchstens 100 je Seite', async () => {
    const eine = await get<{ data: { id: string }[]; meta: { total: number; pageSize: number; totalPages: number } }>('/api/users?pageSize=1', {
      jar: jars.super,
    });
    assert.equal(eine.status, 200, eine.text);
    assert.equal(eine.payload.data.length, 1);
    assert.ok(eine.payload.meta.total >= 5, `Gesamtzahl ${eine.payload.meta.total}`);
    assert.equal(eine.payload.meta.totalPages, eine.payload.meta.total);
    const zweite = await get<{ data: { id: string }[] }>('/api/users?pageSize=1&page=2', { jar: jars.super });
    assert.notEqual(zweite.payload.data[0]?.id, eine.payload.data[0]?.id, 'Seite 2 wiederholt Seite 1');
    assert.equal((await get('/api/users?pageSize=500', { jar: jars.super })).status, 422);
    // Die Seite selbst blättert und sucht auf dem Server.
    const seite = await get('/admin/benutzer?q=anna', { jar: jars.super });
    assert.equal(seite.status, 200);
    assert.ok(seite.text.includes('anna.keller@clenaris.ch'), 'Suche findet die Demo-Mitarbeiterin nicht');
    assert.ok(!seite.text.includes('nicole.wyss@example.ch'), 'Suche filtert nicht');
  });

  it('Portal: „alle Einsätze" antwortet, auch mit Grenze', async () => {
    const r = await get('/portal/einsaetze?alle=1', { jar: jars.employee });
    assert.equal(r.status, 200);
  });

  it('Papierkorb: die Beschriftung kommt aus der Listenabfrage, nicht aus einer Abfrage je Zeile', async (t) => {
    const db = testDb();
    if (!db) return t.skip('keine Testdatenbank');
    const org = (await eigeneOrganisationId())!;
    const nummer = `K-GRENZE-${Date.now()}`;
    const kunde = await db.customer.create({
      data: { organizationId: org, number: nummer, firstName: 'Papier', lastName: 'Korb', email: `${nummer.toLowerCase()}@example.ch`, deletedAt: new Date() },
    });
    try {
      const r = await get('/admin/papierkorb', { jar: jars.admin });
      assert.equal(r.status, 200);
      assert.ok(r.text.replace(/<!-- -->/g, '').includes(`${nummer} · Papier Korb`), 'Beschriftung der gelöschten Kundschaft fehlt');
    } finally {
      await db.customer.delete({ where: { id: kunde.id } });
    }
  });
});
