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
const S = { buero: '', fenster: '', klein: '', puffer: '', quali: '', satz: '' };
const QUALI = `Prüfqualifikation ${RUN}`;
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
    await tx.absence.deleteMany({ where: { reason: { startsWith: 'Integrität ' } } });
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
  S.puffer = await leistung('puffer', 'OFFICE_CLEANING', 45, 60, { bufferMinutes: 60 });
  S.quali = await leistung('quali', 'OFFICE_CLEANING', 45, 60, { requiredSkills: [QUALI] });
  S.satz = await leistung('satz', 'OFFICE_CLEANING', 30.15, 60);
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
    /**
     * Die Preis-Engine rechnete Produkte binär (Phase 25, 2026-09-27):
     * CHF 30.15 × 1.5 Std. = 45.225 wurde zur Gleitkommazahl knapp darunter
     * und damit zu 45.22 — auch mit der korrigierten Rundung, denn die rundete
     * richtig, nur die falsche Zahl. Gefunden durch eine Suche über
     * Stundensätze und Dauern; zehn Treffer zwischen CHF 30 und 31.
     */
    it('dezimal: CHF 30.15 × 1.5 Std. sind 45.23, nicht 45.22', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      const r = await post<{ data: { lines: { key: string; amount: number }[]; netTotal: number; vatAmount: number } }>('/api/public/pricing/estimate', {
        leistungen: [{ serviceId: S.satz, manualHours: 1.5, extras: [] }],
        propertyKind: 'OFFICE',
        frequency: 'ONCE',
      });
      assert.equal(r.status, 200, r.text);
      const arbeit = data(r).lines.find((l) => l.key === 'labor');
      assert.equal(arbeit?.amount, 45.23, `Arbeitszeile: ${JSON.stringify(arbeit)}`);
      // Keine Grundpauschale, keine Anfahrt ohne Postleitzahl: Netto = Arbeit.
      assert.equal(n(data(r).netTotal), 45.23);
      // 45.23 × 8.1 % = 3.66363 → 3.66
      assert.equal(n(data(r).vatAmount), 3.66);
    });

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

    /**
     * B-22 (2026-09-28): Die Gutscheingrenzen wurden nur vor der Transaktion
     * geprüft und danach ohne Bedingung hochgezählt. Fünf gleichzeitige
     * Buchungen beim Limit 2 lösten gegen den alten Stand alle fünf ein.
     */
    it('Gutschein mit Limit 2, fünf Buchungen gleichzeitig: genau zwei lösen ihn ein', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      const code = `${gutschein}L`;
      await db.coupon.create({
        data: { organizationId: org, code, discountType: 'PERCENT', discountValue: 5, validFrom: new Date(Date.now() - 86_400_000), usageLimit: 2, perCustomerLimit: 10 },
      });
      try {
        const antworten = await Promise.all(
          [0, 1, 2, 3, 4].map((i) =>
            post<{ data: { id: string } }>(
              '/api/bookings',
              { customerId: kundeId, leistungen: [{ serviceId: S.fenster, extras: [] }], scheduledStart: termin(300 + i * 7, '09:00'), address: adresse, propertyKind: 'OFFICE', source: 'PHONE', overrideCapacity: true, couponCode: code },
              { jar: jars.admin },
            ),
          ),
        );
        for (const a of antworten) if (a.status === 201) buchungen.push(data(a).id);
        const codes = antworten.map((a) => a.status).sort();
        assert.deepEqual(codes, [201, 201, 422, 422, 422], antworten.map((a) => a.text.slice(0, 160)).join('\n'));
        const stand = await db.coupon.findUniqueOrThrow({ where: { organizationId_code: { organizationId: org, code } }, select: { usageCount: true } });
        assert.equal(stand.usageCount, 2, 'der Zähler steht über dem Limit');
        assert.equal(await db.booking.count({ where: { couponCode: code } }), 2, 'mehr Buchungen mit dem Gutschein als erlaubt');
      } finally {
        await schutzfreiAufraeumen(async (tx) => {
          const ids = (await tx.booking.findMany({ where: { couponCode: code }, select: { id: true } })).map((b) => b.id);
          await tx.bookingItem.deleteMany({ where: { bookingId: { in: ids } } });
          await tx.bookingExtra.deleteMany({ where: { bookingId: { in: ids } } });
          await tx.activity.deleteMany({ where: { bookingId: { in: ids } } });
          await tx.booking.deleteMany({ where: { id: { in: ids } } });
          await tx.coupon.deleteMany({ where: { organizationId: org, code } });
        });
      }
    });

    /**
     * Und die Grenze je Kundschaft zählte die Grossschreibung, gespeichert war
     * aber, was getippt wurde: „integ…k" in Kleinbuchstaben zählte nie gegen
     * das Limit 1. Gegen den alten Stand: zweite Buchung 201.
     */
    it('Gutschein je Kundschaft einmal — auch in Kleinbuchstaben getippt', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      const code = `${gutschein}K`;
      await db.coupon.create({
        data: { organizationId: org, code, discountType: 'PERCENT', discountValue: 5, validFrom: new Date(Date.now() - 86_400_000), perCustomerLimit: 1 },
      });
      try {
        const buchen = (i: number) =>
          post<{ data: { id: string } }>(
            '/api/bookings',
            { customerId: kundeId, leistungen: [{ serviceId: S.fenster, extras: [] }], scheduledStart: termin(340 + i * 7, '09:00'), address: adresse, propertyKind: 'OFFICE', source: 'PHONE', overrideCapacity: true, couponCode: code.toLowerCase() },
            { jar: jars.admin },
          );
        const erste = await buchen(0);
        assert.equal(erste.status, 201, erste.text);
        buchungen.push(data(erste).id);
        const zweite = await buchen(1);
        if (zweite.status === 201) buchungen.push(data(zweite).id);
        assert.equal(zweite.status, 422, `zweite Einlösung: HTTP ${zweite.status}`);
      } finally {
        await schutzfreiAufraeumen(async (tx) => {
          const ids = (await tx.booking.findMany({ where: { couponCode: { equals: code, mode: 'insensitive' } }, select: { id: true } })).map((b) => b.id);
          await tx.bookingItem.deleteMany({ where: { bookingId: { in: ids } } });
          await tx.bookingExtra.deleteMany({ where: { bookingId: { in: ids } } });
          await tx.activity.deleteMany({ where: { bookingId: { in: ids } } });
          await tx.booking.deleteMany({ where: { id: { in: ids } } });
          await tx.coupon.deleteMany({ where: { organizationId: org, code } });
        });
      }
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
   * A6 (2026-09-27) — der Verwaltungslink einer Buchung liegt nur als Hash vor.
   *
   * `Booking.confirmationToken` stand im Klartext in der Datenbank, ohne
   * Ablauf und ohne Widerruf — ein Datenbankabzug war ein Schlüsselbund für
   * jede Gastbuchung samt Adresse und Zugangshinweis. Offerten und Rechnungen
   * waren längst auf `PublicAccessToken` umgestellt, die Buchung nicht; der
   * Zweck `BOOKING_MANAGE` existierte, wurde aber nie ausgestellt.
   */
  describe('A6 — Buchungslinks: Hash statt Klartext, widerrufbar', () => {
    it('die Spalte ist weg, der Link löst über den Hash auf und lässt sich widerrufen', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      const r = await post<{ data: { id: string; confirmationUrl: string } }>(
        '/api/bookings',
        { customerId: kundeId, leistungen: [{ serviceId: S.fenster, extras: [] }], scheduledStart: termin(242, '09:00'), address: adresse, propertyKind: 'OFFICE', source: 'PHONE', overrideCapacity: true },
        { jar: jars.admin },
      );
      assert.equal(r.status, 201, r.text);
      const { id, confirmationUrl } = data(r);
      buchungen.push(id);
      const roh = confirmationUrl.split('/').pop() ?? '';

      const spalten = await db.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM information_schema.columns
        WHERE table_name = 'bookings' AND column_name = 'confirmationToken'`;
      assert.equal(Number(spalten[0]!.n), 0, 'bookings.confirmationToken besteht noch — der Link liegt im Klartext');

      const { createHash } = await import('node:crypto');
      const zeile = await db.publicAccessToken.findUnique({ where: { tokenHash: createHash('sha256').update(roh).digest('hex') } });
      assert.ok(zeile, 'kein Zugriffstoken zum versendeten Link');
      assert.equal(zeile.purpose, 'BOOKING_MANAGE');
      assert.equal(zeile.resourceId, id);
      assert.ok(zeile.expiresAt.getTime() > Date.now(), 'der Link ist schon abgelaufen');

      assert.equal((await call('GET', `/buchung/${roh}`)).status, 200);
      assert.equal((await call('GET', `/api/public/bookings/${roh}/pdf`)).status, 200);

      await db.publicAccessToken.update({ where: { id: zeile.id }, data: { revokedAt: new Date() } });
      assert.equal((await call('GET', `/buchung/${roh}`)).status, 404, 'ein widerrufener Link öffnet die Buchung');
      assert.equal((await call('GET', `/api/public/bookings/${roh}/pdf`)).status, 404);
      await db.publicAccessToken.delete({ where: { id: zeile.id } });
    });
  });

  /**
   * A8 (F-03, 2026-09-27) — eine E-Mail-Adresse ist kein Besitznachweis.
   *
   * A4 schloss fremde Kennungen für Gäste mit *neuer* E-Mail-Adresse aus.
   * Offen blieb der Weg daneben: Ein anonymer Gast, der die E-Mail-Adresse
   * einer bestehenden Kundschaft eintippte, wurde deren Akte zugeordnet und
   * galt damit als diese Kundschaft — ihre Adressen und Objekte liessen sich
   * referenzieren, ihr Dauerrabatt galt, ihre Standardadresse wurde
   * umgestellt, und der Verwaltungslink in der Antwort zeigte Name,
   * E-Mail-Adresse und Einsatzort. Daneben buchte jede angemeldete
   * Nicht-Kundschaft über eine bestehende `addressId` auf deren Akte, ohne
   * `booking:create`. Jede Prüfung hier war auf dem Stand davor rot.
   */
  describe('A8 — Gastbuchung mit bekannter E-Mail-Adresse: kein Zugriff auf die Akte', () => {
    const MARKE = `A8-OPFER-${RUN}`;
    const opfer = { adresse: '', objekt: '', email: '' };
    const eigeneBuchungen: string[] = [];
    let freiesFenster = '';

    const anfrage = (extra: Record<string, unknown>) => ({
      leistungen: [{ serviceId: S.fenster, extras: [] }],
      // Die Abweisungen fallen vor der Kapazitätsprüfung; für sie genügt
      // ein gültiger Zeitpunkt, falls der Kalender keinen freien anbietet.
      scheduledStart: freiesFenster || termin(30, '09:00'),
      propertyKind: 'OFFICE',
      acceptTerms: true,
      website: '',
      firstName: 'Fremd',
      lastName: `Anfrage${RUN}`,
      email: opfer.email,
      phone: '+41 79 000 00 00',
      address: adresse,
      ...extra,
    });

    async function aufraeumenA8() {
      if (!db) return;
      await db.publicAccessToken.deleteMany({ where: { purpose: 'BOOKING_MANAGE', resourceId: { in: eigeneBuchungen } } });
      // Auf dem fehlerhaften Stand hängt eine Buchung am Objekt; der
      // Fremdschlüssel hielte das Objekt sonst bis zum Aufräumen am Ende fest.
      await db.booking.updateMany({ where: { property: { label: { startsWith: MARKE } } }, data: { propertyId: null } });
      await db.property.deleteMany({ where: { label: { startsWith: MARKE } } });
    }

    before(async () => {
      if (!db) return;
      await aufraeumenA8();
      const k = await db.customer.findUniqueOrThrow({ where: { id: kundeId }, select: { email: true } });
      opfer.email = k.email;
      // Genau eine Standardadresse, und zwar diese — daran lässt sich unten
      // ablesen, ob die fremde Anfrage sie verdrängt hat.
      await db.address.updateMany({ where: { customerId: kundeId }, data: { isDefault: false } });
      opfer.adresse = (
        await db.address.create({
          data: { customerId: kundeId, street: 'Opfergasse', streetNo: '9', postalCode: '3011', city: 'Bern', canton: 'BE', isDefault: true, accessNote: `${MARKE} Schlüssel im Milchkasten` },
        })
      ).id;
      opfer.objekt = (await db.property.create({ data: { customerId: kundeId, label: `${MARKE} Objekt` } })).id;

      // Ein Termin, den der öffentliche Kalender tatsächlich anbietet —
      // innerhalb von Vorlauf und Horizont, mit freier Person.
      const kalender = await post<{ data: { tage: { slots: { start: string; capacity: number }[] }[] } }>('/api/public/availability', {
        leistungen: [{ serviceId: S.fenster, extras: [] }],
        von: new Date(Date.now() + 21 * 86_400_000).toISOString().slice(0, 10),
        tage: 28,
      });
      assert.equal(kalender.status, 200, kalender.text);
      freiesFenster = data(kalender).tage.flatMap((d) => d.slots).find((s) => s.capacity >= 1)?.start ?? '';
    });

    after(async () => {
      await aufraeumenA8();
    });

    it('Gast mit der E-Mail-Adresse einer Kundschaft und deren Adresse → 404, nichts angelegt', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      resetRateLimits();
      const r = await post<{ data: { id: string } }>('/api/public/bookings', anfrage({ address: undefined, addressId: opfer.adresse }));
      if (r.status === 201) eigeneBuchungen.push(data(r).id);
      assert.equal(r.status, 404, `fremde Adresse über die bekannte E-Mail-Adresse angenommen: ${r.text}`);
      assert.ok(!r.text.includes('Opfergasse'), 'Die Antwort nennt die Adresse der Kundschaft');
      assert.equal(await db.booking.count({ where: { addressId: opfer.adresse } }), 0, 'Buchung auf die Adresse der Kundschaft entstanden');
    });

    it('Gast mit der E-Mail-Adresse einer Kundschaft und deren Objekt → 404', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      const r = await post<{ data: { id: string } }>('/api/public/bookings', anfrage({ propertyId: opfer.objekt }));
      if (r.status === 201) eigeneBuchungen.push(data(r).id);
      assert.equal(r.status, 404, `fremdes Objekt über die bekannte E-Mail-Adresse angenommen: ${r.text}`);
      assert.equal(await db.booking.count({ where: { propertyId: opfer.objekt } }), 0, 'Buchung auf das Objekt der Kundschaft entstanden');
    });

    it('Gast mit bekannter E-Mail-Adresse und neuer Adresse: bucht, erfährt nichts über die Kundschaft, bekommt keinen Rabatt und verdrängt nichts', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      assert.ok(freiesFenster, 'kein freier Termin im öffentlichen Kalender');
      const r = await post<{ data: { id: string; confirmationUrl: string; isNewCustomer: boolean } }>(
        '/api/public/bookings',
        anfrage({ scheduledStart: freiesFenster, address: { ...adresse, street: 'Fremdweg', streetNo: '4' } }),
      );
      assert.equal(r.status, 201, r.text);
      const { id, confirmationUrl } = data(r);
      eigeneBuchungen.push(id);
      buchungen.push(id);

      // Nichts in der Antwort selbst …
      for (const geheim of [`Prüfung${RUN}`, 'Integra', opfer.email, 'Opfergasse', MARKE]) {
        assert.ok(!r.text.includes(geheim), `Die Antwort enthält „${geheim}"`);
      }
      // … und nichts hinter dem Link, falls einer mitkommt.
      if (confirmationUrl) {
        const seite = await call('GET', new URL(confirmationUrl, 'http://x').pathname);
        assert.ok(!seite.text.includes(`Prüfung${RUN}`), 'Der Verwaltungslink in der Antwort zeigt den Namen der Kundschaft');
      }
      assert.equal(confirmationUrl, '', 'Die Antwort trägt den Verwaltungslink der fremden Akte');

      const buchung = await db.booking.findUniqueOrThrow({ where: { id }, include: { address: true } });
      // Die Buchung gehört zur Akte der E-Mail-Adresse — dort geht die
      // Bestätigung hin, eine Doppelakte entsteht nicht.
      assert.equal(buchung.customerId, kundeId);
      assert.equal(await db.customer.count({ where: { organizationId: org, email: opfer.email } }), 1, 'Doppelakte angelegt');
      assert.equal(n(buchung.discountAmount), 0, 'Der Dauerrabatt der Kundschaft galt für eine anonyme Anfrage');
      assert.equal(buchung.address?.street, 'Fremdweg');
      assert.equal(buchung.address?.isDefault, false, 'Die fremde Adresse wurde Standardadresse der Kundschaft');
      assert.equal(buchung.address?.isBilling, false, 'Die fremde Adresse wurde Rechnungsadresse der Kundschaft');
      const standard = await db.address.findMany({ where: { customerId: kundeId, isDefault: true }, select: { id: true } });
      assert.deepEqual(standard.map((a) => a.id), [opfer.adresse], 'Die Standardadresse der Kundschaft wurde umgestellt');
    });

    /**
     * Die öffentliche Route ist mit `definePublicRoute` ohne `permissions`
     * erklärt: Die Anmeldung gibt dort keine Rechte, eine angemeldete
     * Nicht-Kundschaft ist Besucherin wie jede andere. Für eine fremde
     * Adresse heisst das dieselbe Antwort wie für einen Gast — 404, nicht
     * 403: Es gibt kein Recht, das ihr fehlt, nur einen Bestand, der nicht
     * ihrer ist. Die Büroerfassung mit `booking:create` ist `POST /api/bookings`.
     */
    it('Mitarbeiterin ohne booking:create bucht über die öffentliche Route auf keine fremde Adresse (404)', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      resetRateLimits();
      const email = `integritaet.gast.${RUN}.personal@example.ch`;
      const versuch = async (extra: Record<string, unknown>) => {
        const r = await post<{ data: { id: string } }>('/api/public/bookings', anfrage({ address: undefined, addressId: opfer.adresse, ...extra }), { jar: jars.employee });
        if (r.status === 201) {
          eigeneBuchungen.push(data(r).id);
          buchungen.push(data(r).id);
        }
        assert.ok(!r.text.includes('Opfergasse') && !r.text.includes(`Prüfung${RUN}`), 'Die Antwort nennt Adresse oder Name der Kundschaft');
        return r;
      };

      // Mit Kontaktangaben: Die Adresse ist nicht ihre → 404, wie beim Gast.
      const mit = await versuch({ email });
      assert.equal(mit.status, 404, `Mitarbeiterin buchte auf die Adresse der Kundschaft: ${mit.text}`);
      // Ohne: Zuerst fehlen die Angaben, die jede Besucherin machen muss → 422.
      // Vorher genügte hier die Adresskennung allein.
      const ohne = await versuch({ firstName: undefined, lastName: undefined, email: undefined, phone: undefined });
      assert.equal(ohne.status, 422, `Mitarbeiterin buchte ohne Kontaktangaben über die Adresskennung: ${ohne.text}`);

      assert.equal(await db.booking.count({ where: { addressId: opfer.adresse } }), 0, 'Buchung auf die Adresse der Kundschaft entstanden');
      assert.equal(await db.customer.count({ where: { email } }), 0, 'Kundenakte trotz Abweisung');
    });
  });

  /**
   * A9 (N-04, 2026-09-27) — ein Storno entwertet den Verwaltungslink.
   *
   * Vorher lebte der Link bis 90 Tage nach dem Termin, auch für eine
   * stornierte Buchung, und zeigte weiter Name, E-Mail-Adresse und
   * Einsatzort. Kein Aufrufer widerrief `BOOKING_MANAGE`.
   */
  describe('A9 — Buchungslink nach dem Storno', () => {
    it('nach dem Storno öffnet der alte Link weder Seite noch PDF (404), und der Token ist widerrufen', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      const r = await post<{ data: { id: string; confirmationUrl: string } }>(
        '/api/bookings',
        { customerId: kundeId, leistungen: [{ serviceId: S.fenster, extras: [] }], scheduledStart: termin(306, '09:00'), address: adresse, propertyKind: 'OFFICE', source: 'PHONE', overrideCapacity: true },
        { jar: jars.admin },
      );
      assert.equal(r.status, 201, r.text);
      const { id, confirmationUrl } = data(r);
      buchungen.push(id);
      const roh = confirmationUrl.split('/').pop() ?? '';
      try {
        assert.equal((await call('GET', `/buchung/${roh}`)).status, 200, 'der frische Link öffnet die Buchung nicht');

        const storno = await post(`/api/bookings/${id}/cancel`, { reason: 'Prüfreihe: Link nach Storno' }, { jar: jars.admin });
        assert.equal(storno.status, 200, storno.text);

        assert.equal((await call('GET', `/buchung/${roh}`)).status, 404, 'der Link öffnet die stornierte Buchung');
        assert.equal((await call('GET', `/api/public/bookings/${roh}/pdf`)).status, 404, 'der Link liefert das PDF der stornierten Buchung');
        const offen = await db.publicAccessToken.count({ where: { purpose: 'BOOKING_MANAGE', resourceId: id, revokedAt: null } });
        assert.equal(offen, 0, 'nach dem Storno ist noch ein Buchungslink gültig');
      } finally {
        await db.publicAccessToken.deleteMany({ where: { purpose: 'BOOKING_MANAGE', resourceId: id } });
      }
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

  /**
   * A7 — Buchung und Einsatz bleiben deckungsgleich (Phase 17, 2026-09-27).
   *
   * Jede Prüfung hier war auf dem Stand davor rot: Eine Adresskorrektur
   * erreichte den Einsatz nicht, eine Umbuchung setzte abwesende Personen
   * ein und verschob laufende Einsätze, eine abgewiesene Bearbeitung
   * hinterliess Adresse und Storno, der Puffer eines Einsatzes war der seiner
   * ersten Leistung, und eine Leistung mit Qualifikation liess sich an einem
   * Tag buchen, an dem sie niemand hat.
   */
  describe('A7 — Buchung und Einsatz bleiben deckungsgleich', () => {
    const einsatzVon = async (bookingId: string) => db!.job.findFirstOrThrow({ where: { bookingId } });
    const bestaetigen = async (bookingId: string) =>
      assert.equal((await post(`/api/bookings/${bookingId}/confirm`, undefined, { jar: jars.admin })).status, 200);

    it('eine reine Adresskorrektur erreicht den offenen Einsatz', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      const id = await bueroBuchung([{ serviceId: S.fenster, extras: [] }], termin(250, '09:00'));
      await bestaetigen(id);
      const neu = await db.address.create({ data: { customerId: kundeId, street: 'Neufeldstrasse', streetNo: '3', postalCode: '3012', city: 'Bern' } });
      const r = await call('PATCH', `/api/bookings/${id}`, { jar: jars.admin, body: { addressId: neu.id } });
      assert.equal(r.status, 200, r.text);
      assert.equal((await einsatzVon(id)).addressId, neu.id, 'der Einsatz zeigt noch auf die alte Adresse');
    });

    it('Umbuchen prüft die eingeteilten Personen am neuen Termin', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      const anna = await db.employee.findFirst({ where: { organizationId: org, user: { email: 'anna.keller@clenaris.ch' } } });
      if (!anna) return t.skip('keine Demo-Mitarbeiterin');
      const id = await bueroBuchung([{ serviceId: S.fenster, extras: [] }], termin(257, '09:00'));
      await bestaetigen(id);
      const einsatz = await einsatzVon(id);
      await db.jobAssignment.create({ data: { jobId: einsatz.id, employeeId: anna.id } });

      const ziel = termin(264, '09:00');
      const zielTag = new Date(ziel);
      const abwesenheit = await db.absence.create({
        data: {
          employeeId: anna.id,
          type: 'VACATION',
          status: 'APPROVED',
          startDate: new Date(zielTag.getTime() - 2 * 86_400_000),
          endDate: new Date(zielTag.getTime() + 2 * 86_400_000),
          days: 5,
          reason: `Integrität ${RUN}`,
        },
      });
      try {
        const r = await post(`/api/bookings/${id}/reschedule`, { scheduledStart: ziel }, { jar: jars.admin });
        assert.equal(r.status, 422, `Umbuchung in die Ferien der eingeteilten Person: ${r.text}`);
        assert.equal((await einsatzVon(id)).scheduledStart.getTime(), einsatz.scheduledStart.getTime(), 'der Einsatz wurde trotzdem verschoben');
      } finally {
        await db.absence.delete({ where: { id: abwesenheit.id } });
      }
    });

    it('ein begonnener Einsatz wird nicht umgeplant', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      const id = await bueroBuchung([{ serviceId: S.fenster, extras: [] }], termin(271, '09:00'));
      await bestaetigen(id);
      const einsatz = await einsatzVon(id);
      await db.job.update({ where: { id: einsatz.id }, data: { status: 'EN_ROUTE' } });
      const bearbeitet = await call('PATCH', `/api/bookings/${id}`, { jar: jars.admin, body: { scheduledStart: termin(271, '11:00') } });
      assert.equal(bearbeitet.status, 422, `Bearbeiten: ${bearbeitet.text}`);
      const umgebucht = await post(`/api/bookings/${id}/reschedule`, { scheduledStart: termin(271, '11:00') }, { jar: jars.admin });
      assert.equal(umgebucht.status, 422, `Umbuchen: ${umgebucht.text}`);
      assert.equal((await einsatzVon(id)).scheduledStart.getTime(), einsatz.scheduledStart.getTime());
      // Eine Notiz hält der laufende Einsatz nicht auf.
      const notiz = await call('PATCH', `/api/bookings/${id}`, { jar: jars.admin, body: { internalNote: 'nur eine Notiz' } });
      assert.equal(notiz.status, 200, notiz.text);
    });

    it('eine erledigte Buchung: Termin und Status fest, Notiz frei', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      const id = await bueroBuchung([{ serviceId: S.fenster, extras: [] }], termin(278, '09:00'));
      await db.booking.update({ where: { id }, data: { status: 'COMPLETED' } });
      const termin2 = await call('PATCH', `/api/bookings/${id}`, { jar: jars.admin, body: { scheduledStart: termin(278, '13:00'), overrideCapacity: true } });
      assert.equal(termin2.status, 422, `Termin einer erledigten Buchung: ${termin2.text}`);
      const wieder = await call('PATCH', `/api/bookings/${id}`, { jar: jars.admin, body: { status: 'PENDING' } });
      assert.equal(wieder.status, 422, `erledigt → offen: ${wieder.text}`);
      const notiz = await call('PATCH', `/api/bookings/${id}`, { jar: jars.admin, body: { internalNote: 'Nachtrag' } });
      assert.equal(notiz.status, 200, notiz.text);
    });

    it('eine abgewiesene Bearbeitung hinterlässt weder Adresse noch Storno', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      const fremd = await db.property.findFirst({ where: { customerId: { not: kundeId }, customer: { organizationId: org } }, select: { id: true } });
      if (!fremd) return t.skip('kein fremdes Objekt im Bestand');
      const id = await bueroBuchung([{ serviceId: S.fenster, extras: [] }], termin(285, '09:00'));
      const vorher = await db.address.count({ where: { customerId: kundeId } });

      const mitAdresse = await call('PATCH', `/api/bookings/${id}`, {
        jar: jars.admin,
        body: { address: { ...adresse, street: 'Waisenhausplatz' }, propertyId: fremd.id },
      });
      assert.equal(mitAdresse.status, 404, mitAdresse.text);
      assert.equal(await db.address.count({ where: { customerId: kundeId } }), vorher, 'eine Adresse ohne Auftrag blieb zurück');

      const storno = await call('PATCH', `/api/bookings/${id}`, {
        jar: jars.admin,
        body: { status: 'CANCELLED', changeReason: 'Prüfung der Reihenfolge', propertyId: fremd.id },
      });
      assert.equal(storno.status, 404, storno.text);
      assert.equal((await db.booking.findUniqueOrThrow({ where: { id } })).status, 'PENDING', 'storniert, obwohl die Bearbeitung abgewiesen wurde');
    });

    it('Puffer eines Einsatzes: der grösste seiner Leistungen, auch nach der Bestätigung', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      // Ein Dienstag, an dem um 11 und um 12 Uhr jemand frei ist — das sagt der Kalender.
      let offset = 292;
      let c11 = 0;
      let c12 = 0;
      for (let versuch = 0; versuch < 6 && (c11 === 0 || c12 === 0); versuch += 1, offset += 7) {
        const k = await post<{ data: { tage: { slots: { start: string; capacity: number }[] }[] } }>('/api/public/availability', {
          leistungen: [{ serviceId: S.fenster, extras: [] }],
          von: new Date(new Date(termin(offset, '12:00')).getTime() - 12 * 3_600_000).toISOString().slice(0, 10),
          tage: 2,
        });
        const slots = data(k).tage.flatMap((d) => d.slots);
        c11 = slots.find((s) => s.start === termin(offset, '11:00'))?.capacity ?? 0;
        c12 = slots.find((s) => s.start === termin(offset, '12:00'))?.capacity ?? 0;
      }
      offset -= 7;
      assert.ok(c11 >= 1 && c12 >= 1, `freie Personen um 11/12 Uhr: ${c11}/${c12}`);

      // A: Fenster (ohne Puffer) + Grundreinigung (60 Min. Puffer), 09–11 Uhr, bindet alle um 11 Uhr Freien.
      const a = await bueroBuchung([{ serviceId: S.fenster, extras: [] }, { serviceId: S.puffer, extras: [] }], termin(offset, '09:00'));
      assert.equal((await call('PATCH', `/api/bookings/${a}`, { jar: jars.admin, body: { crewSize: c11, overrideCapacity: true } })).status, 200);
      await bestaetigen(a);
      const ende = (await db.booking.findUniqueOrThrow({ where: { id: a } })).scheduledEnd.toISOString();
      assert.equal(ende, termin(offset, '11:00'), 'Dauer der Prüfbuchung');

      const b = await bueroBuchung([{ serviceId: S.fenster, extras: [] }], termin(offset + 7, '09:00'));
      const direktDanach = await call('PATCH', `/api/bookings/${b}`, { jar: jars.admin, body: { scheduledStart: termin(offset, '11:00') } });
      assert.equal(direktDanach.status, 422, `um 11 Uhr hält der Puffer von A das Team noch: ${direktDanach.text}`);
      const nachPuffer = await call('PATCH', `/api/bookings/${b}`, { jar: jars.admin, body: { scheduledStart: termin(offset, '12:00') } });
      assert.equal(nachPuffer.status, 200, `um 12 Uhr ist der Puffer vorbei: ${nachPuffer.text}`);
    });

    it('eine Leistung mit Qualifikation: kein Termin, den niemand besetzen darf', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      const kalender = async (serviceId: string) =>
        data(
          await post<{ data: { tage: { date: string; closed: boolean; reason?: string }[] } }>('/api/public/availability', {
            leistungen: [{ serviceId, extras: [] }],
            von: termin(20, '12:00').slice(0, 10),
            tage: 7,
          }),
        ).tage;
      const ohne = await kalender(S.fenster);
      const mit = await kalender(S.quali);
      const offen = ohne.filter((d) => !d.closed).map((d) => d.date);
      assert.ok(offen.length > 0, 'keine offenen Tage zum Vergleichen');
      for (const tag of mit.filter((d) => offen.includes(d.date))) {
        assert.ok(tag.closed && (tag.reason ?? '').includes('Qualifikation'), `${tag.date} offen, obwohl niemand ${QUALI} hat`);
      }

      const r = await post<{ data: { id: string } }>('/api/bookings', {
        customerId: kundeId,
        leistungen: [{ serviceId: S.quali, extras: [] }],
        scheduledStart: termin(20, '10:00'),
        address: adresse,
        propertyKind: 'OFFICE',
        source: 'PHONE',
      }, { jar: jars.admin });
      if (r.status === 201) buchungen.push(data(r).id);
      assert.equal(r.status, 422, `Büro ohne Übersteuerung: ${r.text}`);
    });

    it('der Ort einer Adresse mit abgeschlossenem Auftrag bleibt; Bezeichnung frei', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      const alt = await db.address.create({ data: { customerId: kundeId, street: 'Bollwerk', streetNo: '15', postalCode: '3011', city: 'Bern' } });
      const id = await bueroBuchung([{ serviceId: S.fenster, extras: [] }], termin(299, '09:00'), { addressId: alt.id, address: undefined });
      await db.booking.update({ where: { id }, data: { status: 'COMPLETED' } });
      const ort = await call('PATCH', `/api/customers/${kundeId}/addresses/${alt.id}`, { jar: jars.admin, body: { street: 'Spitalgasse' } });
      assert.equal(ort.status, 422, `Strasse einer belegten Adresse: ${ort.text}`);
      assert.equal((await db.address.findUniqueOrThrow({ where: { id: alt.id } })).street, 'Bollwerk');
      const name = await call('PATCH', `/api/customers/${kundeId}/addresses/${alt.id}`, { jar: jars.admin, body: { label: 'Früheres Büro' } });
      assert.equal(name.status, 200, name.text);
    });
  });
});
