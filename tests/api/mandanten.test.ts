import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { del, get, patch, post, requireServer } from '../helpers/client';
import { loginAll, type AccountName } from '../helpers/accounts';
import { fremdeOrganisation, testDb, testDbGrund, testDbSchliessen } from '../helpers/testdb';

/**
 * Wave 16 — Mandantentrennung, bewiesen an einer fremden Organisation.
 *
 * Clenaris läuft einmandantig, ist aber mehrmandantig modelliert: Jede
 * Abfrage soll nach `organizationId` filtern. Mit nur einer Organisation im
 * Bestand ist ein fehlender Filter unsichtbar. Diese Reihe legt deshalb
 * Datensätze unter einer **fremden** Organisation an (`fremdeOrganisation()`)
 * und prüft je Bereich drei Dinge:
 *
 *  1. Die Liste der eigenen Organisation enthält den fremden Datensatz nicht
 *     — geprüft an der Antwort, nicht am Statuscode.
 *  2. Der fremde Datensatz existiert für Einzelansicht, Änderung und Löschen
 *     nicht (404; 403 nur, wo die Rolle ohnehin nicht darf).
 *  3. Ein Schreibvorgang, der auf einen fremden Datensatz **verweist**
 *     (Offerte an fremde Kundschaft), wird abgewiesen — sonst entstünde ein
 *     eigener Datensatz mit fremdem Bezug.
 *
 * Die fremden Datensätze tragen die Marke `MANDANT-PRUEF` und werden vorher
 * und nachher entfernt.
 */

let jars: Record<AccountName, string>;
const RUN = Date.now();
const MARKE = 'MANDANT-PRUEF';
let org = '';
const fremd: Record<string, string> = {};

async function aufraeumen() {
  const db = testDb();
  if (!db || !org) return;
  await db.task.deleteMany({ where: { title: { startsWith: MARKE } } });
  await db.job.deleteMany({ where: { organizationId: org, title: { startsWith: MARKE } } });
  await db.invoice.deleteMany({ where: { organizationId: org, billToName: { startsWith: MARKE } } });
  await db.quote.deleteMany({ where: { organizationId: org, title: { startsWith: MARKE } } });
  await db.lead.deleteMany({ where: { organizationId: org, lastName: MARKE } });
  await db.expense.deleteMany({ where: { organizationId: org, description: { startsWith: MARKE } } });
  await db.supplier.deleteMany({ where: { organizationId: org, name: { startsWith: MARKE } } });
  await db.property.deleteMany({ where: { label: { startsWith: MARKE } } });
  await db.customer.deleteMany({ where: { organizationId: org, lastName: MARKE } });
  await db.user.deleteMany({ where: { email: { endsWith: KONTO_DOMAIN } } });
}

/** Konten der Mandantenreihe — an der Domain erkennbar und wegräumbar. */
const KONTO_DOMAIN = '@mandant-pruef.example.ch';
const KONTO_PASSWORT = 'Mandant-Pruefung-2026!';

before(async () => {
  await requireServer();
  jars = await loginAll();
  const db = testDb();
  assert.ok(db, `kein Zugang zur Testdatenbank: ${testDbGrund()}`);
  org = (await fremdeOrganisation())!;
  await aufraeumen();

  const kunde = await db.customer.create({
    data: { organizationId: org, number: `K-FREMD-${RUN}`, firstName: 'Fremd', lastName: MARKE, email: `mandant.${RUN}@example.ch`, companyName: `${MARKE} AG` },
  });
  fremd.customer = kunde.id;
  fremd.property = (await db.property.create({ data: { customerId: kunde.id, label: `${MARKE} Objekt` } })).id;
  fremd.lead = (await db.lead.create({ data: { organizationId: org, number: `L-FREMD-${RUN}`, firstName: 'Fremd', lastName: MARKE, email: `mandant.lead.${RUN}@example.ch` } })).id;
  fremd.quote = (await db.quote.create({ data: { organizationId: org, number: `OF-FREMD-${RUN}`, title: `${MARKE} Offerte`, validUntil: new Date(Date.now() + 30 * 86_400_000), customerId: kunde.id } })).id;
  fremd.job = (
    await db.job.create({
      data: { organizationId: org, number: `JB-FREMD-${RUN}`, customerId: kunde.id, title: `${MARKE} Einsatz`, scheduledStart: new Date(), scheduledEnd: new Date(Date.now() + 3_600_000) },
    })
  ).id;
  fremd.invoice = (
    await db.invoice.create({
      data: {
        organizationId: org,
        number: `ENTWURF-FREMD-${RUN}`,
        customerId: kunde.id,
        issueDate: new Date(),
        dueDate: new Date(Date.now() + 30 * 86_400_000),
        billToName: `${MARKE} Empfänger`,
        billToStreet: 'Fremdweg 1',
        billToZip: '3000',
        billToCity: 'Bern',
      },
    })
  ).id;
  fremd.expense = (await db.expense.create({ data: { organizationId: org, description: `${MARKE} Ausgabe`, expenseDate: new Date(), netAmount: 10, grossAmount: 10.81 } })).id;
  fremd.supplier = (await db.supplier.create({ data: { organizationId: org, name: `${MARKE} Lieferant` } })).id;
  fremd.thread = (
    await db.messageThread.create({
      data: { organizationId: org, customerId: kunde.id, subject: `${MARKE} Verlauf`, messages: { create: { authorType: 'CUSTOMER', body: `${MARKE} Nachricht` } } },
    })
  ).id;
  fremd.task = (await db.task.create({ data: { organizationId: org, customerId: kunde.id, title: `${MARKE} Aufgabe` } })).id;
});

after(async () => {
  await aufraeumen();
  await testDbSchliessen();
});

const BEREICHE: { name: string; liste: string; detail: (id: string) => string; schluessel: keyof typeof fremd; aendern?: Record<string, unknown> }[] = [
  { name: 'Kundschaft', liste: '/api/customers?pageSize=100', detail: (id) => `/api/customers/${id}`, schluessel: 'customer', aendern: { notes: 'übernommen' } },
  { name: 'Objekte', liste: '/api/properties?pageSize=100', detail: (id) => `/api/properties/${id}`, schluessel: 'property', aendern: { label: 'übernommen' } },
  { name: 'Anfragen', liste: '/api/leads?pageSize=100', detail: (id) => `/api/leads/${id}`, schluessel: 'lead', aendern: { message: 'übernommen' } },
  { name: 'Offerten', liste: '/api/quotes?pageSize=100', detail: (id) => `/api/quotes/${id}`, schluessel: 'quote', aendern: { title: 'übernommen' } },
  { name: 'Einsätze', liste: '/api/jobs?pageSize=100', detail: (id) => `/api/jobs/${id}`, schluessel: 'job', aendern: { title: 'übernommen' } },
  { name: 'Rechnungen', liste: '/api/invoices?pageSize=100', detail: (id) => `/api/invoices/${id}`, schluessel: 'invoice', aendern: { notes: 'übernommen' } },
  { name: 'Ausgaben', liste: '/api/expenses?pageSize=100', detail: (id) => `/api/expenses/${id}`, schluessel: 'expense', aendern: { description: 'übernommen' } },
  { name: 'Lieferanten', liste: '/api/suppliers?pageSize=100', detail: (id) => `/api/suppliers/${id}`, schluessel: 'supplier', aendern: { name: 'übernommen' } },
  // 2026-09-27: Verläufe hatten keine Organisation, und Liste wie Einzelansicht
  // filterten nicht danach — das Büro las die Korrespondenz jeder Organisation.
  { name: 'Nachrichten', liste: '/api/messages?status=all', detail: (id) => `/api/messages/${id}`, schluessel: 'thread' },
  // Ebenso Aufgaben: keine Spalte, kein Filter — fremde Aufgaben liessen sich
  // lesen, ändern (200) und löschen.
  { name: 'Aufgaben', liste: '/api/tasks?pageSize=100', detail: (id) => `/api/tasks/${id}`, schluessel: 'task', aendern: { title: 'übernommen' } },
];

/** Prisma-Modell je Schlüssel, wo der Name abweicht. */
const MODELL: Record<string, string> = { thread: 'messageThread' };

describe('Fremde Daten erscheinen nicht und lassen sich nicht anfassen', () => {
  for (const b of BEREICHE) {
    it(`${b.name}: nicht in der Liste, nicht einzeln, nicht änderbar, nicht löschbar`, async () => {
      const id = fremd[b.schluessel]!;
      const liste = await get(b.liste, { jar: jars.admin });
      assert.equal(liste.status, 200, `${b.liste}: ${liste.status}`);
      assert.ok(!liste.text.includes(id), `${b.name}: der fremde Datensatz steht in der Liste`);
      assert.ok(!liste.text.includes(MARKE), `${b.name}: die fremde Marke steht in der Liste`);

      const einzeln = await get(b.detail(id), { jar: jars.admin });
      assert.ok([404, 405].includes(einzeln.status), `${b.name} GET: ${einzeln.status}`);
      if (b.aendern) {
        const aenderung = await patch(b.detail(id), b.aendern, { jar: jars.admin });
        assert.ok([404, 405].includes(aenderung.status), `${b.name} PATCH: ${aenderung.status}`);
      }
      const loeschen = await del(b.detail(id), { jar: jars.admin });
      assert.ok([404, 405].includes(loeschen.status), `${b.name} DELETE: ${loeschen.status}`);

      const unveraendert = await (testDb() as unknown as Record<string, { findUnique: (a: unknown) => Promise<{ deletedAt?: Date | null } | null> }>)[
        MODELL[b.schluessel] ?? b.schluessel
      ]!.findUnique({ where: { id } });
      assert.ok(unveraendert, `${b.name}: der fremde Datensatz existiert noch`);
      assert.ok(!unveraendert.deletedAt, `${b.name}: der fremde Datensatz wurde nicht (weich) gelöscht`);
    });
  }
});

describe('Verweise auf fremde Datensätze werden abgewiesen', () => {
  const inZukunft = (tage: number) => new Date(Date.now() + tage * 86_400_000).toISOString().slice(0, 10);

  it('Offerte an fremde Kundschaft', async () => {
    const r = await post('/api/quotes', { customerId: fremd.customer, title: 'Querverweis', validUntil: inZukunft(10), items: [{ name: 'Reinigung', quantity: 1, unitPrice: 10 }] }, { jar: jars.admin });
    assert.equal(r.status, 404, r.text);
  });

  it('Rechnung an fremde Kundschaft', async () => {
    const r = await post('/api/invoices', { customerId: fremd.customer, items: [{ name: 'Reinigung', quantity: 1, unitPrice: 10 }] }, { jar: jars.admin });
    assert.equal(r.status, 404, r.text);
  });

  it('Besichtigung und Reklamation für fremde Kundschaft', async () => {
    assert.equal((await post('/api/site-visits', { customerId: fremd.customer, scheduledAt: new Date().toISOString() }, { jar: jars.admin })).status, 404);
    assert.equal((await post('/api/complaints', { customerId: fremd.customer, title: 'Querverweis', description: 'x' }, { jar: jars.admin })).status, 404);
  });

  it('Antwort in einen fremden Verlauf', async () => {
    const r = await post(`/api/messages/${fremd.thread}`, { body: 'Querverweis' }, { jar: jars.admin });
    assert.equal(r.status, 404, r.text);
    assert.equal(await testDb()!.message.count({ where: { threadId: fremd.thread } }), 1, 'die Antwort steht im fremden Verlauf');
  });

  it('Aufgabe an fremder Kundschaft', async () => {
    const r = await post('/api/tasks', { title: `${MARKE} Querverweis`, customerId: fremd.customer }, { jar: jars.admin });
    assert.equal(r.status, 404, r.text);
    assert.equal(await testDb()!.task.count({ where: { title: `${MARKE} Querverweis` } }), 0, 'die Aufgabe entstand trotzdem');
  });

  it('Objekt der fremden Kundschaft an eigener Offerte', async () => {
    const eigene = await get<{ data: { id: string }[] }>('/api/customers?pageSize=1', { jar: jars.admin });
    const kunde = eigene.payload.data[0]!.id;
    const r = await post(
      '/api/quotes',
      { customerId: kunde, propertyId: fremd.property, title: 'Querverweis', validUntil: inZukunft(10), items: [{ name: 'Reinigung', quantity: 1, unitPrice: 10 }] },
      { jar: jars.admin },
    );
    assert.equal(r.status, 404, r.text);
  });
});

/**
 * Die Gegenrichtung (2026-09-27): nicht „die eigene Person sieht fremde
 * Daten", sondern „eine **fremde** Person handelt in dieser Installation".
 *
 * Bis dahin fehlte der Fall, und genau dort lag die Lücke: Jede Route löste
 * die Organisation über `getOrganizationId()` auf, die Sitzung wurde nie
 * damit verglichen. Ein Administrator einer anderen Organisation meldete sich
 * an und verwaltete die Daten dieser. Geprüft wird an echten Konten, nicht an
 * nachgebauten Tokens: eines, das von Anfang an fremd ist, und eines, das
 * mitten in einer gültigen Sitzung die Organisation wechselt.
 */
describe('Konten einer fremden Organisation handeln hier nicht', () => {
  async function konto(organizationId: string, name: string): Promise<{ id: string; email: string }> {
    const db = testDb()!;
    const { hashPassword } = await import('../../src/lib/auth/password');
    const email = `${name}.${RUN}${KONTO_DOMAIN}`;
    const user = await db.user.create({
      data: {
        organizationId,
        email,
        passwordHash: await hashPassword(KONTO_PASSWORT),
        firstName: 'Mandant',
        lastName: name,
        role: 'ADMIN',
        status: 'ACTIVE',
      },
    });
    return { id: user.id, email };
  }

  it('ein Administrator der fremden Organisation kann sich nicht anmelden — dieselbe Meldung wie beim falschen Passwort', async () => {
    const fremderAdmin = await konto(org, 'fremd');
    const anmeldung = await post<{ error: { message: string } }>('/api/auth/login', { email: fremderAdmin.email, password: KONTO_PASSWORT });
    assert.equal(anmeldung.status, 401, anmeldung.text);
    const falsch = await post<{ error: { message: string } }>('/api/auth/login', { email: fremderAdmin.email, password: 'falsch-falsch-falsch' });
    assert.equal(anmeldung.payload.error.message, falsch.payload.error.message, 'Die Anmeldung verrät nicht, dass das Konto anderswo existiert');
    assert.equal(anmeldung.cookies, '', 'Kein Cookie für ein fremdes Konto');
  });

  it('wechselt ein Konto die Organisation, endet die laufende Sitzung sofort — Endpunkt, Seite und Erneuerung', async () => {
    const db = testDb()!;
    const { eigeneOrganisationId } = await import('../helpers/testdb');
    const eigene = (await eigeneOrganisationId())!;
    const wechsler = await konto(eigene, 'wechsel');

    const anmeldung = await post('/api/auth/login', { email: wechsler.email, password: KONTO_PASSWORT });
    assert.equal(anmeldung.status, 200, anmeldung.text);
    const jar = anmeldung.cookies;
    assert.equal((await get('/api/customers?pageSize=1', { jar })).status, 200, 'Vorher: die eigene Organisation ist erreichbar');

    await db.user.update({ where: { id: wechsler.id }, data: { organizationId: org } });

    // Dasselbe, noch gültige Zugangstoken — die Datenbank entscheidet.
    assert.equal((await get('/api/customers?pageSize=1', { jar })).status, 401, 'Endpunkt: keine Sitzung mehr');
    const seite = await get('/admin/kunden', { jar });
    assert.ok([302, 303, 307].includes(seite.status), `Seite: Weiterleitung zur Anmeldung erwartet, war ${seite.status}`);
    assert.equal((await post('/api/auth/refresh', undefined, { jar })).status, 401, 'Erneuerung: kein neues Token für ein fremdes Konto');
  });
});

describe('Kundenkonto', () => {
  it('sieht keine fremden Objekte und Rechnungen', async () => {
    for (const pfad of ['/api/properties', '/api/invoices']) {
      const r = await get(pfad, { jar: jars.customer });
      if (r.status === 403) continue;
      assert.ok(!r.text.includes(MARKE), `${pfad}: fremde Marke sichtbar`);
    }
  });
});
