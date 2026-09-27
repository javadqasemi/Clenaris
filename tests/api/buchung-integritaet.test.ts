import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { call, data, post, requireServer } from '../helpers/client';
import { loginAll, type AccountName } from '../helpers/accounts';
import { resetRateLimits } from '../helpers/rate-limit';
import { eigeneOrganisationId, schutzfreiAufraeumen, testDb, testDbSchliessen } from '../helpers/testdb';

/**
 * Buchung → Einsatz → Rechnung, Gastbuchung und Terminänderung — die drei
 * Befunde A1–A3 vom 2026-09-26 als Invarianten.
 *
 *  A1  Die Rechnung aus einem Einsatz ergibt **denselben Nettobetrag** wie die
 *      Buchung: Grundpauschale, Zusatzleistungen, Anfahrt, Zuschläge,
 *      Mindestauftragswert, Stammkunden- und Gutscheinrabatt gehen nicht
 *      verloren — mit einer und mit mehreren Leistungen. Danach Teilzahlung
 *      und Gutschrift: Der Saldo stimmt.
 *  A2  Eine abgewiesene Gastbuchung hinterlässt keine Kundenakte.
 *  A3  Eine Terminänderung durchläuft dieselbe Verfügbarkeitsprüfung wie das
 *      Anlegen — auch unter Gleichzeitigkeit.
 */

const RUN = Date.now();
const db = testDb();
let jars: Record<AccountName, string>;
let org = '';
const S = { buero: '', fenster: '', klein: '' };
let zusatzId = '';
let kundeId = '';
let gutschein = '';
const buchungen: string[] = [];

type Buchung = { id: string; netTotal: string; vatAmount: string; grossTotal: string; discountAmount: string };

/** Ein Werktag weit voraus, Ortszeit — ausserhalb des Buchungshorizonts, das Büro darf trotzdem. */
function termin(tageVoraus: number, hhmm: string): string {
  const d = new Date(Date.now() + tageVoraus * 86_400_000);
  while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1); // Dienstag
  const datum = d.toISOString().slice(0, 10);
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const wand = Date.UTC(Number(datum.slice(0, 4)), Number(datum.slice(5, 7)) - 1, Number(datum.slice(8, 10)), h, m);
  const teile = (t: number) =>
    Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Zurich', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        .formatToParts(new Date(t))
        .filter((p) => p.type !== 'literal')
        .map((p) => [p.type, Number(p.value)]),
    ) as Record<string, number>;
  const versatz = (t: number) => { const p = teile(t); return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!) - t; };
  return new Date(wand - versatz(wand - versatz(wand))).toISOString();
}

const adresse = { street: 'Murtenstrasse', streetNo: '7', postalCode: '3018', city: 'Bern', canton: 'BE', country: 'CH' };

async function bueroBuchung(leistungen: unknown[], start: string, extra: Record<string, unknown> = {}) {
  const r = await post<{ data: { id: string } }>(
    '/api/bookings',
    { customerId: kundeId, leistungen, scheduledStart: start, address: adresse, propertyKind: 'OFFICE', source: 'PHONE', overrideCapacity: true, ...extra },
    { jar: jars.admin },
  );
  assert.equal(r.status, 201, r.text);
  buchungen.push(data(r).id);
  return data(r).id;
}

/** Bestätigen, Einsatz abschliessen, Rechnungsentwurf erzeugen. */
async function rechnungAus(bookingId: string) {
  assert.equal((await post(`/api/bookings/${bookingId}/confirm`, undefined, { jar: jars.admin })).status, 200);
  await db!.job.updateMany({ where: { bookingId }, data: { status: 'COMPLETED' } });
  const r = await post<{ data: { id: string } }>(`/api/bookings/${bookingId}/invoice`, undefined, { jar: jars.admin });
  assert.equal(r.status, 201, r.text);
  return db!.invoice.findUniqueOrThrow({ where: { id: data(r).id }, include: { items: { orderBy: { position: 'asc' } } } });
}

const n = (v: unknown) => Number(v);

async function aufraeumen() {
  if (!db) return;
  const ids = Object.values(S).filter(Boolean);
  const alle = [
    ...new Set([
      ...buchungen,
      ...(await db.booking.findMany({ where: { OR: [{ items: { some: { serviceId: { in: ids } } } }, { customerId: kundeId || '__' }] }, select: { id: true } })).map((b) => b.id),
    ]),
  ];
  await schutzfreiAufraeumen(async (tx) => {
    const jobs = (await tx.job.findMany({ where: { bookingId: { in: alle } }, select: { id: true } })).map((j) => j.id);
    const rechnungen = (await tx.invoice.findMany({ where: { OR: [{ customerId: kundeId || '__' }, { items: { some: { jobId: { in: jobs } } } }] }, select: { id: true } })).map((r) => r.id);
    await tx.payment.deleteMany({ where: { invoiceId: { in: rechnungen } } });
    await tx.creditNote.deleteMany({ where: { OR: [{ invoiceId: { in: rechnungen } }, { customerId: kundeId || '__' }] } });
    await tx.invoiceItem.deleteMany({ where: { invoiceId: { in: rechnungen } } });
    await tx.invoice.deleteMany({ where: { id: { in: rechnungen } } });
    await tx.jobChecklistItem.deleteMany({ where: { jobId: { in: jobs } } });
    await tx.jobAssignment.deleteMany({ where: { jobId: { in: jobs } } });
    await tx.job.deleteMany({ where: { id: { in: jobs } } });
    await tx.bookingItem.deleteMany({ where: { bookingId: { in: alle } } });
    await tx.bookingExtra.deleteMany({ where: { bookingId: { in: alle } } });
    await tx.activity.deleteMany({ where: { bookingId: { in: alle } } });
    await tx.booking.deleteMany({ where: { id: { in: alle } } });
    if (kundeId) {
      await tx.address.deleteMany({ where: { customerId: kundeId } });
      await tx.activity.deleteMany({ where: { customerId: kundeId } });
      await tx.customer.deleteMany({ where: { id: kundeId } });
    }
    if (zusatzId) {
      await tx.serviceExtraOnService.deleteMany({ where: { extraId: zusatzId } });
      await tx.serviceExtra.deleteMany({ where: { id: zusatzId } });
    }
    await tx.service.deleteMany({ where: { id: { in: ids } } });
    if (gutschein) await tx.coupon.deleteMany({ where: { organizationId: org, code: gutschein } });
  });
  await db.customer.deleteMany({ where: { email: { startsWith: `integritaet.gast.` } } });
}

before(async () => {
  await requireServer();
  jars = await loginAll();
  resetRateLimits();
  if (!db) return;
  org = (await eigeneOrganisationId())!;
  const leistung = (schluessel: string, kind: string, satz: number, minuten: number, extra: Record<string, unknown> = {}) =>
    db.service
      .create({
        data: {
          organizationId: org,
          slug: `integritaet-${schluessel}-${RUN}`,
          kind: kind as never,
          name: `Integrität ${schluessel} ${RUN}`,
          shortDesc: 'Prüfleistung',
          description: 'Nur für die Prüfreihe.',
          pricingModel: 'PER_HOUR',
          hourlyRate: satz,
          minHours: minuten / 60,
          defaultDurationMin: minuten,
          minutesPerSqm: 0,
          defaultCrewSize: 1,
          bufferMinutes: 0,
          ...extra,
        },
      })
      .then((s) => s.id);
  S.buero = await leistung('buero', 'OFFICE_CLEANING', 55, 120, { basePrice: 40 });
  S.fenster = await leistung('fenster', 'OFFICE_CLEANING', 45, 60);
  S.klein = await leistung('klein', 'SPECIAL', 50, 60, { minPrice: 500 });
  zusatzId = (await db.serviceExtra.create({ data: { organizationId: org, slug: `integritaet-zusatz-${RUN}`, name: `Integritätszusatz ${RUN}`, price: 25, durationMin: 15 } })).id;
  await db.serviceExtraOnService.create({ data: { serviceId: S.buero, extraId: zusatzId } });
  kundeId = (
    await db.customer.create({
      data: { organizationId: org, number: `K-INT-${RUN}`, firstName: 'Integra', lastName: `Prüfung${RUN}`, email: `integritaet.${RUN}@example.ch`, discountPercent: 10 },
    })
  ).id;
  gutschein = `INTEG${RUN % 1_000_000}`;
  await db.coupon.create({
    data: { organizationId: org, code: gutschein, discountType: 'PERCENT', discountValue: 5, validFrom: new Date(Date.now() - 86_400_000), perCustomerLimit: 10 },
  });
});

after(async () => {
  try {
    await aufraeumen();
  } finally {
    await testDbSchliessen();
  }
});

describe('Buchung → Rechnung, Gastbuchung, Terminänderung', { concurrency: 1 }, () => {
  describe('A1 — die Rechnung aus dem Einsatz verliert nichts', () => {
    it('eine Leistung mit Grundpauschale, Zusatzleistung, Anfahrt, Stammkundenrabatt und Gutschein', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      const id = await bueroBuchung([{ serviceId: S.buero, extras: [{ extraId: zusatzId, quantity: 2 }] }], termin(200, '09:00'), { couponCode: gutschein });
      const buchung = (await db.booking.findUniqueOrThrow({ where: { id } })) as unknown as Buchung;
      // 2 h × 55 + 40 Grundpauschale + 2 × 25 + 15 Anfahrt = 215; −10 % Stamm und −5 % Gutschein.
      assert.equal(n(buchung.discountAmount) > 0, true, 'die Buchung trägt keinen Rabatt');
      const rechnung = await rechnungAus(id);
      assert.equal(n(rechnung.netTotal), n(buchung.netTotal), 'Nettobetrag Rechnung ≠ Buchung');
      assert.equal(n(rechnung.discountAmount), n(buchung.discountAmount), 'Rabatt verloren');
      const namen = rechnung.items.map((i) => i.name).join(' | ');
      for (const teil of ['Grundpauschale', `Integritätszusatz ${RUN}`, 'Anfahrt']) assert.ok(namen.includes(teil), `fehlt: ${teil} in ${namen}`);
      // MwSt. je Position (MWSTG), höchstens ein Rappen je Position neben der Buchungsschätzung.
      assert.equal(n(rechnung.grossTotal), Math.round((n(rechnung.netTotal) + n(rechnung.vatAmount)) * 100) / 100);
      assert.ok(Math.abs(n(rechnung.vatAmount) - n(buchung.vatAmount)) <= 0.01 * rechnung.items.length);
      // Dezimalspalten, keine Gleitkommareste.
      for (const i of rechnung.items) assert.equal(Math.round(n(i.netAmount) * 100) / 100, n(i.netAmount));
    });

    it('mehrere Leistungen: jede Leistung, dieselbe Summe', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      const id = await bueroBuchung([{ serviceId: S.buero, extras: [] }, { serviceId: S.fenster, extras: [] }], termin(207, '09:00'));
      const buchung = await db.booking.findUniqueOrThrow({ where: { id } });
      const rechnung = await rechnungAus(id);
      assert.equal(n(rechnung.netTotal), n(buchung.netTotal));
      const namen = rechnung.items.map((i) => i.name).join(' | ');
      assert.ok(namen.includes(`Integrität buero ${RUN}`) && namen.includes(`Integrität fenster ${RUN}`), namen);
    });

    it('Mindestauftragswert wird als Zeile geführt', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      const id = await bueroBuchung([{ serviceId: S.klein, extras: [] }], termin(214, '09:00'), { customerId: kundeId });
      const buchung = await db.booking.findUniqueOrThrow({ where: { id } });
      const rechnung = await rechnungAus(id);
      assert.equal(n(rechnung.netTotal), n(buchung.netTotal));
      assert.ok(rechnung.items.some((i) => i.name.startsWith('Mindestauftragswert')), rechnung.items.map((i) => i.name).join(' | '));
    });

    it('ausgestellt, teilweise bezahlt, gutgeschrieben: der Saldo stimmt; eine ausgestellte Rechnung bleibt unveränderlich', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      const id = await bueroBuchung([{ serviceId: S.fenster, extras: [] }], termin(221, '09:00'));
      const entwurf = await rechnungAus(id);
      assert.equal((await post(`/api/invoices/${entwurf.id}/issue`, undefined, { jar: jars.admin })).status, 200);
      assert.equal((await post(`/api/invoices/${entwurf.id}/payments`, { amount: 20, method: 'BANK_TRANSFER' }, { jar: jars.admin })).status, 201);
      const gs = await post(`/api/invoices/${entwurf.id}/credit-note`, { reason: 'Kulanz', name: 'Gutschrift Prüfung', unitPrice: 10, vatRate: 8.1 }, { jar: jars.admin });
      assert.ok([200, 201].includes(gs.status), gs.text);
      const nachher = await db.invoice.findUniqueOrThrow({ where: { id: entwurf.id } });
      const gutschrift = await db.creditNote.findFirstOrThrow({ where: { invoiceId: entwurf.id } });
      assert.equal(n(nachher.balance), Math.round((n(nachher.grossTotal) - 20 - n(gutschrift.grossTotal)) * 100) / 100);
      const aendern = await call('PATCH', `/api/invoices/${entwurf.id}`, { jar: jars.admin, body: { notes: 'nachträglich' } });
      assert.equal(aendern.status, 422, 'eine ausgestellte Rechnung liess sich ändern');
    });
  });

  describe('A2 — eine abgewiesene Gastbuchung hinterlässt keine Kundenakte', () => {
    const gast = (email: string, extra: Record<string, unknown>) => ({
      leistungen: [{ serviceId: S.fenster, extras: [] }],
      scheduledStart: termin(30, '09:00'),
      propertyKind: 'OFFICE',
      firstName: 'Gast',
      lastName: `Abgewiesen${RUN}`,
      email,
      phone: '+41 79 000 00 00',
      address: adresse,
      acceptTerms: true,
      website: '',
      ...extra,
    });

    it('ungültiger Gutschein → 422, keine Akte', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      resetRateLimits();
      const email = `integritaet.gast.${RUN}.gutschein@example.ch`;
      const r = await post('/api/public/bookings', gast(email, { couponCode: 'GIBTESNICHT' }));
      assert.equal(r.status, 422, r.text);
      assert.equal(await db.customer.count({ where: { email } }), 0, 'Kundenakte trotz Abweisung angelegt');
    });

    it('Termin in der Vergangenheit → 422, keine Akte', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      const email = `integritaet.gast.${RUN}.vergangen@example.ch`;
      const r = await post('/api/public/bookings', gast(email, { scheduledStart: new Date(Date.now() - 86_400_000).toISOString() }));
      assert.equal(r.status, 422, r.text);
      assert.equal(await db.customer.count({ where: { email } }), 0);
    });

    it('Postleitzahl ausserhalb des Einsatzgebiets → 422, keine Akte', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      const email = `integritaet.gast.${RUN}.plz@example.ch`;
      const r = await post('/api/public/bookings', gast(email, { address: { ...adresse, postalCode: '8001', city: 'Zürich', canton: 'ZH' } }));
      assert.equal(r.status, 422, r.text);
      assert.equal(await db.customer.count({ where: { email } }), 0);
    });
  });

  /**
   * A4 (2026-09-27) — eine öffentliche Buchung verweist nur auf Eigenes.
   *
   * Die Buchung nahm `addressId`, `propertyId` und `fileIds` entgegen und
   * schrieb sie ungeprüft an. Wer die Kennung einer fremden Adresse kannte,
   * bekam sie in Bestätigung und PDF zurück; eine fremde Datei (hier: eine
   * Lohnabrechnung) wurde zum Buchungsfoto umgewidmet und über die eigene
   * Buchung lesbar. Geprüft wird die Abweisung **und** dass nichts geschah:
   * keine Buchung, keine Akte, die Datei unverändert.
   */
  describe('A4 — öffentliche Buchung: nur eigene Adressen, Objekte und Dateien', () => {
    const FREMD = `A4-FREMD-${RUN}`;
    const fremd = { adresse: '', objekt: '', datei: '' };
    const anfrage = (extra: Record<string, unknown>) => ({
      leistungen: [{ serviceId: S.fenster, extras: [] }],
      scheduledStart: termin(30, '09:00'),
      propertyKind: 'OFFICE',
      acceptTerms: true,
      website: '',
      address: adresse,
      ...extra,
    });
    const gastAngaben = (email: string) => ({ firstName: 'Gast', lastName: `Fremdverweis${RUN}`, email, phone: '+41 79 000 00 00' });

    before(async () => {
      if (!db) return;
      fremd.adresse = (await db.address.create({ data: { customerId: kundeId, street: 'Geheimweg', streetNo: '1', postalCode: '3011', city: 'Bern', canton: 'BE', accessNote: `${FREMD} Schlüssel unter der Matte` } })).id;
      fremd.objekt = (await db.property.create({ data: { customerId: kundeId, label: `${FREMD} Objekt` } })).id;
      fremd.datei = (
        await db.fileAsset.create({
          data: { organizationId: org, scope: 'PAYROLL', scanStatus: 'CLEAN', checksum: 'a'.repeat(64), path: `pruef/${FREMD}.pdf`, url: `pruef/${FREMD}.pdf`, filename: `${FREMD}.pdf`, mimeType: 'application/pdf', sizeBytes: 10 },
        })
      ).id;
    });

    after(async () => {
      if (!db) return;
      await db.fileAsset.deleteMany({ where: { filename: { startsWith: FREMD } } });
      await db.property.deleteMany({ where: { label: { startsWith: FREMD } } });
      await db.address.deleteMany({ where: { accessNote: { startsWith: FREMD } } });
      await db.customer.deleteMany({ where: { email: { startsWith: 'integritaet.fremdverweis.' } } });
    });

    async function nichtsGeschehen(email?: string) {
      assert.equal(await db!.booking.count({ where: { OR: [{ addressId: fremd.adresse }, { propertyId: fremd.objekt }] } }), 0, 'Buchung mit fremdem Verweis entstanden');
      const datei = await db!.fileAsset.findUniqueOrThrow({ where: { id: fremd.datei } });
      assert.equal(datei.bookingId, null, 'fremde Datei an eine Buchung gebunden');
      assert.equal(datei.scope, 'PAYROLL', 'Zweck der fremden Datei umgeschrieben');
      if (email) assert.equal(await db!.customer.count({ where: { email } }), 0, 'Kundenakte trotz Abweisung');
    }

    it('Gast mit fremder Adresse → 404, nichts angelegt', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      resetRateLimits();
      const email = `integritaet.fremdverweis.${RUN}.adresse@example.ch`;
      const r = await post('/api/public/bookings', anfrage({ ...gastAngaben(email), address: undefined, addressId: fremd.adresse }));
      assert.equal(r.status, 404, r.text);
      assert.ok(!r.text.includes('Geheimweg'), 'Die Antwort nennt die fremde Adresse');
      await nichtsGeschehen(email);
    });

    it('Gast mit fremdem Objekt → 404', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      const email = `integritaet.fremdverweis.${RUN}.objekt@example.ch`;
      const r = await post('/api/public/bookings', anfrage({ ...gastAngaben(email), propertyId: fremd.objekt }));
      assert.equal(r.status, 404, r.text);
      await nichtsGeschehen(email);
    });

    it('Gast mit fremder Datei → 422, die Datei bleibt, was sie war', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      const email = `integritaet.fremdverweis.${RUN}.datei@example.ch`;
      const r = await post('/api/public/bookings', anfrage({ ...gastAngaben(email), fileIds: [fremd.datei] }));
      assert.equal(r.status, 422, r.text);
      await nichtsGeschehen(email);
    });

    it('angemeldete Kundschaft mit fremder Adresse, fremdem Objekt oder fremder Datei → 404', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      for (const extra of [{ address: undefined, addressId: fremd.adresse }, { propertyId: fremd.objekt }, { fileIds: [fremd.datei] }]) {
        const r = await post('/api/public/bookings', anfrage(extra), { jar: jars.customer });
        assert.equal(r.status, 404, `${JSON.stringify(extra)}: ${r.text}`);
      }
      await nichtsGeschehen();
    });
  });

  /**
   * A5 (2026-09-27) — ein Einsatz wird höchstens einmal verrechnet.
   *
   * `createInvoiceFromJobs` prüfte „schon verrechnet?" vor der Transaktion,
   * ohne Sperre und ohne Datenbankschranke. Ein Doppelklick auf „Rechnung
   * erstellen" erzeugte zwei Rechnungen für denselben Einsatz. Umgekehrt
   * zählte eine **stornierte** Rechnung weiter als Verrechnung — ein Einsatz
   * liess sich danach nie wieder verrechnen.
   */
  describe('A5 — ein Einsatz, höchstens eine gültige Rechnung', () => {
    it('fünf gleichzeitige „Rechnung erstellen" ergeben genau eine Rechnung', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      const id = await bueroBuchung([{ serviceId: S.fenster, extras: [] }], termin(235, '09:00'));
      assert.equal((await post(`/api/bookings/${id}/confirm`, undefined, { jar: jars.admin })).status, 200);
      await db.job.updateMany({ where: { bookingId: id }, data: { status: 'COMPLETED' } });

      const antworten = await Promise.all(Array.from({ length: 5 }, () => post(`/api/bookings/${id}/invoice`, undefined, { jar: jars.admin })));
      const status = antworten.map((a) => a.status);
      assert.equal(status.filter((s) => s === 201).length, 1, `Erfolge: ${JSON.stringify(status)}`);
      assert.ok(status.every((s) => s === 201 || s === 409 || s === 422), JSON.stringify(status));

      const jobs = (await db.job.findMany({ where: { bookingId: id }, select: { id: true } })).map((j) => j.id);
      assert.equal(await db.invoice.count({ where: { items: { some: { jobId: { in: jobs } } } } }), 1, 'mehr als eine Rechnung zum selben Einsatz');
    });

    it('nach dem Storno lässt sich der Einsatz wieder verrechnen — vorher nicht', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      const id = await bueroBuchung([{ serviceId: S.fenster, extras: [] }], termin(242, '09:00'));
      const erste = await rechnungAus(id);
      assert.equal((await post(`/api/invoices/${erste.id}/issue`, undefined, { jar: jars.admin })).status, 200);
      const nochmal = await post(`/api/bookings/${id}/invoice`, undefined, { jar: jars.admin });
      assert.ok([409, 422].includes(nochmal.status), `zweite Verrechnung vor dem Storno: ${nochmal.status}`);

      assert.equal((await post(`/api/invoices/${erste.id}/cancel`, { reason: 'Prüfreihe: falsch verrechnet' }, { jar: jars.admin })).status, 200);
      const neu = await post(`/api/bookings/${id}/invoice`, undefined, { jar: jars.admin });
      assert.equal(neu.status, 201, `nach dem Storno: ${neu.text}`);
    });

    it('eine manuelle Rechnung kann keinen bereits verrechneten Einsatz tragen', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      const id = await bueroBuchung([{ serviceId: S.fenster, extras: [] }], termin(249, '09:00'));
      await rechnungAus(id);
      const job = await db.job.findFirstOrThrow({ where: { bookingId: id }, select: { id: true } });
      const r = await post('/api/invoices', { customerId: kundeId, items: [{ jobId: job.id, name: 'Nochmals', quantity: 1, unitPrice: 10 }] }, { jar: jars.admin });
      assert.ok([409, 422].includes(r.status), `manuelle Doppelverrechnung: ${r.status} ${r.text}`);
    });
  });

  describe('A3 — Terminänderung prüft die Verfügbarkeit', () => {
    it('ausserhalb der Einsatzzeit, zu lange Dauer: 422 — ausdrücklich übergangen: 200 und protokolliert', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      const id = await bueroBuchung([{ serviceId: S.fenster, extras: [] }], termin(228, '09:00'));
      const spaet = await call('PATCH', `/api/bookings/${id}`, { jar: jars.admin, body: { scheduledStart: termin(228, '17:30') } });
      assert.equal(spaet.status, 422, `17:30 + 1 h über das Fenster hinaus: ${spaet.text}`);
      const lang = await call('PATCH', `/api/bookings/${id}`, { jar: jars.admin, body: { durationMin: 720 } });
      assert.equal(lang.status, 422, `12 h ab 09:00: ${lang.text}`);
      const gut = await call('PATCH', `/api/bookings/${id}`, { jar: jars.admin, body: { scheduledStart: termin(228, '10:00') } });
      assert.equal(gut.status, 200, gut.text);
      const trotzdem = await call('PATCH', `/api/bookings/${id}`, { jar: jars.admin, body: { durationMin: 720, overrideCapacity: true } });
      assert.equal(trotzdem.status, 200, trotzdem.text);
      const protokoll = await db.auditLog.findFirst({ where: { entity: 'Booking', entityId: id, summary: { contains: 'Kapazitätsprüfung übergangen' } } });
      assert.ok(protokoll, 'die Übersteuerung steht nicht im Protokoll');
    });

    it('zwei gleichzeitige Verschiebungen auf den letzten Platz: genau eine gelingt', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      // Ein Dienstag, an dem gearbeitet wird (kein Feiertag), und wie viele
      // Personen dort um 13:00 frei sind — das sagt der Kalender selbst.
      let offset = 235;
      let tag = '';
      let frei = 0;
      for (let versuch = 0; versuch < 6 && frei === 0; versuch += 1, offset += 7) {
        tag = termin(offset, '13:00');
        const kalender = await post<{ data: { tage: { date: string; slots: { start: string; capacity: number }[] }[] } }>('/api/public/availability', {
          leistungen: [{ serviceId: S.fenster, extras: [] }],
          von: new Date(new Date(tag).getTime() - 12 * 3_600_000).toISOString().slice(0, 10),
          tage: 2,
        });
        frei = data(kalender).tage.flatMap((d) => d.slots).find((s) => s.start === tag)?.capacity ?? 0;
      }
      assert.ok(frei >= 1 && frei <= 20, `freie Personen um 13:00: ${frei}`);
      const a = await bueroBuchung([{ serviceId: S.fenster, extras: [] }], termin(offset - 7, '07:00'));
      const b = await bueroBuchung([{ serviceId: S.fenster, extras: [] }], termin(offset - 7, '15:00'));
      const [ra, rb] = await Promise.all([
        call('PATCH', `/api/bookings/${a}`, { jar: jars.admin, body: { scheduledStart: tag, crewSize: frei } }),
        call('PATCH', `/api/bookings/${b}`, { jar: jars.admin, body: { scheduledStart: tag, crewSize: frei } }),
      ]);
      assert.deepEqual([ra.status, rb.status].sort(), [200, 422], `${ra.text} | ${rb.text}`);
    });

    it('ein beweglicher Feiertag sperrt nicht jedes Jahr denselben Kalendertag', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      // Der Pfingstmontag dieses Jahres, ein Jahr später: dort ist 2027 ein
      // gewöhnlicher Tag. Als wiederkehrend gespeichert, sperrte er ihn.
      const pfingsten = await db.holiday.findFirst({
        where: { organizationId: org, name: 'Pfingstmontag', date: { gte: new Date(`${new Date().getUTCFullYear()}-01-01`) } },
        orderBy: { date: 'asc' },
      });
      if (!pfingsten) return t.skip('kein Pfingstmontag im Bestand');
      assert.equal(pfingsten.recurring, false, 'Pfingstmontag als wiederkehrend gespeichert');
      const folgejahr = `${pfingsten.date.getUTCFullYear() + 1}${pfingsten.date.toISOString().slice(4, 10)}`;
      const k = await post<{ data: { tage: { date: string; reason?: string }[] } }>('/api/public/availability', {
        leistungen: [{ serviceId: S.fenster, extras: [] }],
        von: folgejahr,
        tage: 1,
      });
      assert.ok(!(data(k).tage[0]?.reason ?? '').includes('Pfingstmontag'), `${folgejahr} ist als Pfingstmontag gesperrt`);
    });
  });
});
