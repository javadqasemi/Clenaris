import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { data, get, post, put, requireServer } from '../helpers/client';
import { loginAll, type AccountName } from '../helpers/accounts';
import { testDb, testDbGrund, testDbSchliessen } from '../helpers/testdb';

/**
 * Wave 12 — Besichtigung / Objektaufnahme → Berechnung → Offerte.
 *
 * Der Kern: **ein Weg zum Preis.** Die Besichtigung rechnet mit derselben
 * Preisberechnung wie die Online-Sofortofferte; die Prüfreihe vergleicht die
 * beiden Zahlen direkt. Dazu die Invarianten: Offerte erst nach der
 * Besichtigung, höchstens eine (auch bei gleichzeitigen Klicks), Aufnahme
 * danach gesperrt, Bezüge nur innerhalb der Organisation, „Preis auf
 * Anfrage" wird nicht geraten.
 *
 * Markiert über `accessNotes`/Anfrage-E-Mail; aufgeräumt über die
 * Testdatenbank (Besichtigungen, daraus entstandene Offerten, die
 * Prüfanfrage).
 */

let jars: Record<AccountName, string>;
const MARKE = 'Prüfreihe Besichtigung';
const RUN = Date.now();
let kundeId = '';
let objektId = '';
let fremdesObjektId = '';
let leistungId = '';
let plz: string | null = null;

async function aufraeumen() {
  const db = testDb();
  if (!db) return;
  const besichtigungen = await db.siteVisit.findMany({ where: { accessNotes: MARKE }, select: { id: true, quoteId: true } });
  const quoteIds = besichtigungen.map((b) => b.quoteId).filter((x): x is string => Boolean(x));
  await db.siteVisit.deleteMany({ where: { id: { in: besichtigungen.map((b) => b.id) } } });
  await db.quote.deleteMany({ where: { id: { in: quoteIds } } });
  await db.lead.deleteMany({ where: { email: { startsWith: 'pruef.besichtigung.' } } });
}

before(async () => {
  await requireServer();
  jars = await loginAll();
  assert.ok(testDb(), `kein Zugang zur Testdatenbank: ${testDbGrund()}`);
  await aufraeumen();

  type Objekt = { id: string; customerId?: string; customer?: { id: string }; address?: { postalCode?: string } | null };
  const objekte = data(await get<{ data: Objekt[] }>('/api/properties?pageSize=100', { jar: jars.admin }));
  const kundeVon = (o: Objekt) => o.customerId ?? o.customer?.id ?? '';
  const erstes = objekte.find((o) => kundeVon(o))!;
  kundeId = kundeVon(erstes);
  objektId = erstes.id;
  plz = erstes.address?.postalCode ?? null;
  fremdesObjektId = objekte.find((o) => kundeVon(o) && kundeVon(o) !== kundeId)?.id ?? '';

  const leistungen = data(await get<{ data: { id: string; pricingModel: string; active?: boolean }[] }>('/api/services?pageSize=50', { jar: jars.admin }));
  const passend = leistungen.find((l) => ['PER_SQM', 'PER_HOUR'].includes(l.pricingModel) && l.active !== false);
  assert.ok(passend, 'eine Leistung mit Preisgrundlage im Katalog');
  leistungId = passend.id;
});

after(async () => {
  await aufraeumen();
  await testDbSchliessen();
});

async function besichtigung(ueber: Record<string, unknown> = {}) {
  const antwort = await post<{ data: { id: string; number: string } }>(
    '/api/site-visits',
    { customerId: kundeId, propertyId: objektId, scheduledAt: new Date(Date.now() + 86_400_000).toISOString(), propertyKind: 'OFFICE', accessNotes: MARKE, ...ueber },
    { jar: jars.admin },
  );
  assert.equal(antwort.status, 201, JSON.stringify(antwort.payload));
  return data(antwort);
}

describe('Besichtigung → Berechnung → Offerte', () => {
  let id = '';

  it('planen: Nummer vom Server, Bezug nur innerhalb der Organisation', async () => {
    const b = await besichtigung();
    id = b.id;
    assert.match(b.number, /^BES-\d{4}-\d{5}$/);
    if (fremdesObjektId) {
      const fremd = await post('/api/site-visits', { customerId: kundeId, propertyId: fremdesObjektId, scheduledAt: new Date().toISOString(), accessNotes: MARKE }, { jar: jars.admin });
      assert.equal(fremd.status, 404, 'das Objekt einer anderen Kundschaft');
    }
    const ohneBezug = await post('/api/site-visits', { scheduledAt: new Date().toISOString(), accessNotes: MARKE }, { jar: jars.admin });
    assert.equal(ohneBezug.status, 422);
    const unbekannt = await post('/api/site-visits', { customerId: 'clzzzzzzzzzzzzzzzzzzzzzzz', scheduledAt: new Date().toISOString(), accessNotes: MARKE }, { jar: jars.admin });
    assert.equal(unbekannt.status, 404);
  });

  it('Flächen: nur Katalogleistungen der Organisation, kein Preisfeld', async () => {
    const falsch = await post(`/api/site-visits/${id}/areas`, { label: 'Nirgends', serviceId: 'clzzzzzzzzzzzzzzzzzzzzzzz' }, { jar: jars.admin });
    assert.equal(falsch.status, 404);
    const flaeche = await post(
      `/api/site-visits/${id}/areas`,
      { label: 'Büros 1. OG', serviceId: leistungId, squareMeters: 120, frequency: 'WEEKLY', unitPrice: 1 },
      { jar: jars.admin },
    );
    assert.equal(flaeche.status, 201, JSON.stringify(flaeche.payload));
  });

  it('keine Offerte vor der Besichtigung', async () => {
    const zuFrueh = await post(`/api/site-visits/${id}/quote`, {}, { jar: jars.admin });
    assert.equal(zuFrueh.status, 422);
    assert.equal((await post(`/api/site-visits/${id}/complete`, {}, { jar: jars.admin })).status, 200);
    assert.equal((await post(`/api/site-visits/${id}/complete`, {}, { jar: jars.admin })).status, 422, 'zweimal abschliessen');
  });

  it('ein Weg zum Preis: dieselbe Zahl wie die Online-Sofortofferte', async () => {
    const rechnung = await post<{ data: { grossTotal: number; flaechen: { grossTotal: number; netTotal: number; onRequest: boolean }[] } }>(
      `/api/site-visits/${id}/calculate`,
      undefined,
      { jar: jars.admin },
    );
    assert.equal(rechnung.status, 200, JSON.stringify(rechnung.payload));
    const f = data(rechnung).flaechen[0]!;
    assert.ok(f.grossTotal > 0);
    const rabatt = Number((await testDb()!.customer.findUnique({ where: { id: kundeId }, select: { discountPercent: true } }))!.discountPercent);
    if (rabatt === 0) {
      const online = await post<{ data: { grossTotal: number } }>(
        '/api/public/pricing/estimate',
        { serviceId: leistungId, squareMeters: 120, propertyKind: 'OFFICE', frequency: 'WEEKLY', extras: [], postalCode: plz, hasPets: false },
      );
      assert.equal(online.status, 200, JSON.stringify(online.payload));
      assert.equal(f.grossTotal, data(online).grossTotal, 'Besichtigung und Online-Offerte rechnen gleich');
    }
  });

  it('die Offerte übernimmt den berechneten Preis, einmal', async () => {
    const [a, b] = await Promise.all([
      post<{ data: { quoteId: string; grossTotal: number; rechnung: { grossTotal: number; flaechen: { netTotal: number }[] } } }>(`/api/site-visits/${id}/quote`, {}, { jar: jars.admin }),
      post(`/api/site-visits/${id}/quote`, {}, { jar: jars.admin }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [201, 422], `zwei gleichzeitige Klicks: ${a.status}/${b.status}`);
    const erfolg = (a.status === 201 ? a : b) as typeof a;
    const q = data(erfolg);
    assert.ok(Math.abs(q.grossTotal - q.rechnung.grossTotal) < 0.05, `${q.grossTotal} ≈ ${q.rechnung.grossTotal}`);
    const offerte = await get<{ data: { items: { unitPrice: string; serviceId: string | null; quantity: string }[]; status: string } }>(`/api/quotes/${q.quoteId}`, { jar: jars.admin });
    assert.equal(offerte.status, 200);
    const item = data(offerte).items[0]!;
    assert.equal(Number(item.unitPrice), q.rechnung.flaechen[0]!.netTotal);
    assert.equal(item.serviceId, leistungId);
    assert.equal(data(offerte).status, 'DRAFT');
  });

  it('nach der Offerte ist die Aufnahme gesperrt', async () => {
    assert.equal((await post(`/api/site-visits/${id}/areas`, { label: 'Nachtrag', serviceId: leistungId, squareMeters: 10 }, { jar: jars.admin })).status, 422);
    assert.equal((await put(`/api/site-visits/${id}/areas`, { areas: [{ label: 'x', serviceId: leistungId }] }, { jar: jars.admin })).status, 422);
    assert.equal((await post(`/api/site-visits/${id}/cancel`, { reason: 'zu spät' }, { jar: jars.admin })).status, 422);
  });
});

describe('Besichtigung zu einer Anfrage', () => {
  it('die Offerte hebt die Anfrage in die Angebotsphase', async () => {
    const lead = await post<{ data: { id: string } }>(
      '/api/leads',
      { firstName: 'Prüf', lastName: 'Besichtigung', email: `pruef.besichtigung.${RUN}@example.ch`, company: 'Prüf AG', postalCode: '3011', source: 'PHONE' },
      { jar: jars.admin },
    );
    assert.equal(lead.status, 201, JSON.stringify(lead.payload));
    const b = await besichtigung({ customerId: undefined, propertyId: undefined, leadId: data(lead).id, postalCode: '3011' });
    await post(`/api/site-visits/${b.id}/areas`, { label: 'Praxis', serviceId: leistungId, squareMeters: 80, frequency: 'ONCE' }, { jar: jars.admin });
    await post(`/api/site-visits/${b.id}/complete`, {}, { jar: jars.admin });
    const q = await post(`/api/site-visits/${b.id}/quote`, { validDays: 14 }, { jar: jars.admin });
    assert.equal(q.status, 201, JSON.stringify(q.payload));
    const l = await testDb()!.lead.findUnique({ where: { id: data(lead).id }, select: { status: true } });
    assert.equal(l?.status, 'PROPOSAL');
  });
});

describe('Offerten: Bezug innerhalb der Organisation', () => {
  it('eine Offerte an eine unbekannte Kundschaft wird abgewiesen', async () => {
    const antwort = await post(
      '/api/quotes',
      {
        customerId: 'clzzzzzzzzzzzzzzzzzzzzzzz',
        title: 'Prüfreihe fremd',
        validUntil: new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10),
        items: [{ name: 'Reinigung', quantity: 1, unitPrice: 10 }],
      },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 404, 'vorher entstand eine Offerte, die auf nichts zeigte');
  });
});

describe('Rollen', () => {
  it('Mitarbeitende und Kundschaft sehen keine Besichtigungen', async () => {
    for (const rolle of ['employee', 'customer'] as AccountName[]) {
      assert.equal((await get('/api/site-visits', { jar: jars[rolle] })).status, 403, rolle);
    }
    assert.equal((await get('/api/site-visits', { jar: jars.manager })).status, 200);
  });
});
