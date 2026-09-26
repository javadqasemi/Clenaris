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
