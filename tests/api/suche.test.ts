import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { data, get, requireServer } from '../helpers/client';
import { loginAll, type AccountName } from '../helpers/accounts';
import { resetRateLimits } from '../helpers/rate-limit';
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

  /**
   * Bis 2026-09-27 durften Mitarbeitende suchen (`dashboard:view`) — und
   * fanden die ganze Kundschaft samt E-Mail (`customer:read`), mit Links nach
   * `/admin`, das sie nicht betreten dürfen. Die Suche gibt es in der
   * Oberfläche nur im Verwaltungsbereich; der Endpunkt verlangt jetzt dessen
   * Rollen, und `customer:read` ist der Rolle entzogen.
   */
  it('Mitarbeitende und Kundschaft haben keine globale Suche', async () => {
    for (const rolle of ['employee', 'customer'] as AccountName[]) {
      const r = await get('/api/search?q=er', { jar: jars[rolle] });
      assert.equal(r.status, 403, `${rolle}: ${r.status}`);
      assert.ok(!r.text.includes('/admin/'), `${rolle}: die Antwort enthält Verwaltungslinks`);
    }
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

  it('findet ein Objekt für das Büro', async (t) => {
    if (!eigenesObjekt) return t.skip('keine Testdatenbank');
    const buero = data(await get<Antwort>(`/api/search?q=${OBJEKT}`, { jar: jars.admin }));
    assert.ok(buero.treffer.some((x) => x.art === 'Objekt' && x.id === eigenesObjekt), JSON.stringify(buero));
  });

  it('Objekte einer fremden Organisation bleiben unsichtbar', async (t) => {
    if (!fremdeKundschaft) return t.skip('keine fremde Organisation');
    const r = data(await get<Antwort>(`/api/search?q=${FREMD}`, { jar: jars.super }));
    assert.equal(r.treffer.length, 0, JSON.stringify(r));
  });

  it('Bereiche ohne Leseberechtigung bleiben leer (Betriebsleitung: keine Dokumente)', async (t) => {
    const db = testDb();
    const org = await eigeneOrganisationId();
    if (!db || !org) return t.skip('keine Testdatenbank');
    // Ein eigenes Dokument statt eines Treffers aus dem Bestand: Die Prüfung
    // soll nicht davon abhängen, welche Titel der Demobestand gerade hat.
    const titel = `Suchdokument${RUN}`;
    const dokument = await db.managedDocument.create({ data: { organizationId: org, title: titel } });
    try {
      const buero = data(await get<Antwort>(`/api/search?q=${titel}`, { jar: jars.admin }));
      assert.ok(buero.treffer.some((x) => x.art === 'Dokument' && x.id === dokument.id), 'Vorbedingung: das Büro findet das Dokument');
      // Die Betriebsleitung hat `document:read` nicht.
      const leitung = data(await get<Antwort>(`/api/search?q=${titel}`, { jar: jars.manager }));
      assert.ok(!leitung.treffer.some((x) => x.art === 'Dokument'), 'die Betriebsleitung findet Dokumente');
    } finally {
      await db.managedDocument.delete({ where: { id: dokument.id } });
    }
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

/**
 * „Alle Treffer anzeigen" zeigt wirklich alle (2026-09-27).
 *
 * Die Vollansicht lief durch dieselbe Grenze von fünf Treffern je Bereich wie
 * die Vorschau in der Kopfzeile — der sechste Treffer war nirgends zu finden.
 * Geprüft mit 27 Kundinnen zu einem Suchwort: Vorschau fünf und `mehr`,
 * Übersicht zehn und ein Link „Weitere", Seite 1 des Bereichs 25, Seite 2 den
 * Rest — und jede der 27 genau einmal.
 */
describe('Globale Suche — Vollansicht blättert', () => {
  const WORT = `Seitenweise${RUN}`;
  const ids: string[] = [];

  before(async () => {
    const db = testDb();
    const org = await eigeneOrganisationId();
    if (!db || !org) return;
    for (let i = 0; i < 27; i += 1) {
      ids.push((await db.customer.create({ data: { organizationId: org, number: `K-SEITE-${RUN}-${i}`, firstName: `Nr${i}`, lastName: WORT, email: `seite.${RUN}.${i}@example.ch` } })).id);
    }
  });

  after(async () => {
    await testDb()?.customer.deleteMany({ where: { lastName: WORT } });
  });

  const gezeigt = (html: string) => ids.filter((id) => html.includes(`/admin/kunden/${id}`));

  it('Vorschau: fünf und der Hinweis auf mehr', async (t) => {
    if (ids.length === 0) return t.skip('keine Testdatenbank');
    const r = data(await get<{ data: { treffer: { art: string }[]; mehr: string[] } }>(`/api/search?q=${WORT}`, { jar: jars.admin }));
    assert.equal(r.treffer.filter((x) => x.art === 'Kundschaft').length, 5);
    assert.ok(r.mehr.includes('Kundschaft'), JSON.stringify(r.mehr));
  });

  it('Übersicht: zehn und ein Link auf weitere; Bereich Seite für Seite, jede genau einmal', async (t) => {
    if (ids.length === 0) return t.skip('keine Testdatenbank');
    const uebersicht = await get(`/admin/suche?q=${WORT}`, { jar: jars.admin });
    assert.equal(uebersicht.status, 200);
    assert.equal(gezeigt(uebersicht.text).length, 10);
    assert.match(uebersicht.text, /Weitere Treffer in/);

    const s1 = await get(`/admin/suche?q=${WORT}&bereich=Kundschaft&seite=1`, { jar: jars.admin });
    const s2 = await get(`/admin/suche?q=${WORT}&bereich=Kundschaft&seite=2`, { jar: jars.admin });
    const a = gezeigt(s1.text);
    const b = gezeigt(s2.text);
    assert.equal(a.length, 25, 'Seite 1');
    assert.equal(b.length, 2, 'Seite 2');
    assert.equal(new Set([...a, ...b]).size, 27, 'jede Kundin genau einmal über beide Seiten');
    assert.match(s1.text, /Nächste Seite/);
    assert.doesNotMatch(s2.text, /Nächste Seite/);
  });

  it('die Vollansicht zählt auf das Kontingent der Suche', async (t) => {
    if (ids.length === 0) return t.skip('keine Testdatenbank');
    // Das Kontingent ist 120 je Minute und Person, Kopfzeile und Seite
    // zusammen. Vorher rief die Seite den Dienst am Kontingent vorbei.
    resetRateLimits();
    let gebremst = false;
    for (let i = 0; i < 125 && !gebremst; i += 1) {
      const r = await get(`/admin/suche?q=${WORT}`, { jar: jars.admin });
      gebremst = r.text.includes('Zu viele Suchen');
    }
    assert.ok(gebremst, 'nach 125 Aufrufen noch keine Bremse');
    assert.equal((await get(`/api/search?q=${WORT}`, { jar: jars.admin, retries: 0 })).status, 429, 'der Endpunkt teilt den Zähler');
    resetRateLimits();
  });
});
