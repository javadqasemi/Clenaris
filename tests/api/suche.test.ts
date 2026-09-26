import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { data, get, requireServer } from '../helpers/client';
import { loginAll, type AccountName } from '../helpers/accounts';
import { eigeneOrganisationId, fremdeOrganisation, testDb, testDbSchliessen } from '../helpers/testdb';

/**
 * Wave 17 — globale Suche: findet, was die Rolle lesen darf, und nur das.
 *
 * Vier Fragen: Findet sie einen bekannten Datensatz? Bleiben Bereiche ohne
 * Leseberechtigung leer? Findet sie Daten einer fremden Organisation (sie
 * darf nicht)? Macht ein sensibles Feld einen Treffer (es darf nicht)?
 */

type Antwort = { data: { q: string; treffer: { art: string; id: string; titel: string }[] } };

let jars: Record<AccountName, string>;
const RUN = Date.now();
const FREMD = `Suchfremd${RUN}`;
/** Bezeichnung eines Objekts, an dem kein Einsatz der Demo-Mitarbeiterin hängt. */
const OBJEKT = `Suchobjekt${RUN}`;
let fremdeKundschaft = '';
let eigenesObjekt = '';

before(async () => {
  await requireServer();
  jars = await loginAll();
  const db = testDb();
  const org = await fremdeOrganisation();
  if (db && org) {
    fremdeKundschaft = (
      await db.customer.create({ data: { organizationId: org, number: `K-SUCH-${RUN}`, firstName: 'Fremd', lastName: FREMD, email: `such.${RUN}@example.ch` } })
    ).id;
    // Dasselbe Wort auch als Objekt der fremden Organisation — die Suche nach
    // Objekten darf über die Kundschaft nicht in einen anderen Mandanten greifen.
    await db.property.create({ data: { customerId: fremdeKundschaft, label: `${FREMD} Objekt` } });
  }
  if (db) {
    const eigen = await eigeneOrganisationId();
    const kunde = eigen ? await db.customer.findFirst({ where: { organizationId: eigen, deletedAt: null }, select: { id: true } }) : null;
    if (kunde) eigenesObjekt = (await db.property.create({ data: { customerId: kunde.id, label: OBJEKT } })).id;
  }
});

after(async () => {
  const db = testDb();
  if (eigenesObjekt) await db?.property.delete({ where: { id: eigenesObjekt } }).catch(() => undefined);
  if (fremdeKundschaft) {
    await db?.property.deleteMany({ where: { customerId: fremdeKundschaft } }).catch(() => undefined);
    await db?.customer.delete({ where: { id: fremdeKundschaft } }).catch(() => undefined);
  }
  await testDbSchliessen();
});

describe('Globale Suche', () => {
  it('findet eine bekannte Kundschaft über Namen und Nummer', async () => {
    const kunden = data(await get<{ data: { id: string; number: string; lastName: string }[] }>('/api/customers?pageSize=1', { jar: jars.admin }));
    const k = kunden[0]!;
    const perName = data(await get<Antwort>(`/api/search?q=${encodeURIComponent(k.lastName)}`, { jar: jars.admin }));
    assert.ok(perName.treffer.some((t) => t.id === k.id && t.art === 'Kundschaft'), JSON.stringify(perName).slice(0, 300));
    const perNummer = data(await get<Antwort>(`/api/search?q=${encodeURIComponent(k.number)}`, { jar: jars.admin }));
    assert.ok(perNummer.treffer.some((t) => t.id === k.id));
  });

  it('höchstens fünf Treffer je Bereich', async () => {
    const breit = data(await get<Antwort>('/api/search?q=er', { jar: jars.admin }));
    const jeArt = new Map<string, number>();
    for (const t of breit.treffer) jeArt.set(t.art, (jeArt.get(t.art) ?? 0) + 1);
    for (const [art, n] of jeArt) assert.ok(n <= 5, `${art}: ${n}`);
  });

  it('zu kurze Anfrage: 422', async () => {
    assert.equal((await get('/api/search?q=a', { jar: jars.admin })).status, 422);
  });

  it('Bereiche ohne Leseberechtigung bleiben leer (Mitarbeitende: keine Rechnungen, keine Offerten)', async () => {
    const r = await get<Antwort>('/api/search?q=RE-', { jar: jars.employee });
    assert.equal(r.status, 200);
    const arten = new Set(data(r).treffer.map((t) => t.art));
    for (const verboten of ['Rechnung', 'Offerte', 'Vertrag', 'Personal', 'Reklamation', 'Material', 'Gerät']) {
      assert.ok(!arten.has(verboten), `Mitarbeitende finden ${verboten}`);
    }
  });

  it('die Kundschaft hat keine globale Suche', async () => {
    assert.equal((await get('/api/search?q=Reinigung', { jar: jars.customer })).status, 403);
  });

  it('eine fremde Organisation bleibt unsichtbar', async (t) => {
    if (!fremdeKundschaft) return t.skip('keine fremde Organisation');
    const r = data(await get<Antwort>(`/api/search?q=${FREMD}`, { jar: jars.admin }));
    assert.equal(r.treffer.length, 0, JSON.stringify(r));
  });

  // --- Produktsprint 2026-09-26: Buchungen, Objekte, Dokumente -------------

  it('findet eine Buchung über ihre Nummer', async () => {
    const liste = data(await get<{ data: { id: string; number: string }[] }>('/api/bookings?pageSize=1', { jar: jars.admin }));
    const buchung = liste[0];
    assert.ok(buchung, 'keine Buchung im Demobestand');
    const r = data(await get<Antwort>(`/api/search?q=${encodeURIComponent(buchung.number)}`, { jar: jars.admin }));
    assert.ok(r.treffer.some((t) => t.art === 'Buchung' && t.id === buchung.id), JSON.stringify(r).slice(0, 300));
  });

  it('findet ein Objekt für das Büro — nicht aber für Mitarbeitende ohne Einsatz dort', async (t) => {
    if (!eigenesObjekt) return t.skip('keine Testdatenbank');
    const buero = data(await get<Antwort>(`/api/search?q=${OBJEKT}`, { jar: jars.admin }));
    assert.ok(buero.treffer.some((x) => x.art === 'Objekt' && x.id === eigenesObjekt), JSON.stringify(buero));
    // `property:read` besitzen auch Mitarbeitende — die Suche muss dieselbe
    // Sichtbarkeitsbedingung anwenden wie die Objektliste.
    const mitarbeitende = data(await get<Antwort>(`/api/search?q=${OBJEKT}`, { jar: jars.employee }));
    assert.ok(!mitarbeitende.treffer.some((x) => x.id === eigenesObjekt), 'Mitarbeitende finden ein fremdes Objekt');
  });

  it('Objekte einer fremden Organisation bleiben unsichtbar', async (t) => {
    if (!fremdeKundschaft) return t.skip('keine fremde Organisation');
    const r = data(await get<Antwort>(`/api/search?q=${FREMD}`, { jar: jars.super }));
    assert.equal(r.treffer.length, 0, JSON.stringify(r));
  });

  it('Mitarbeitende finden keine Buchungen und keine Dokumente', async () => {
    const r = await get<Antwort>('/api/search?q=er', { jar: jars.employee });
    assert.equal(r.status, 200);
    const arten = new Set(data(r).treffer.map((x) => x.art));
    for (const verboten of ['Buchung', 'Dokument']) assert.ok(!arten.has(verboten), `Mitarbeitende finden ${verboten}`);
  });

  it('eine leere Trefferliste ist eine Antwort, kein Fehler', async () => {
    const r = await get<Antwort>(`/api/search?q=${encodeURIComponent(`nichts-${RUN}`)}`, { jar: jars.admin });
    assert.equal(r.status, 200);
    assert.deepEqual(data(r).treffer, []);
  });

  it('sensible Felder machen keinen Treffer (AHV-Nummer, IBAN)', async () => {
    for (const q of ['756.', 'CH93']) {
      const r = data(await get<Antwort>(`/api/search?q=${encodeURIComponent(q)}`, { jar: jars.admin }));
      assert.ok(!r.treffer.some((t) => t.art === 'Personal'), `${q} findet Personal`);
    }
  });
});
