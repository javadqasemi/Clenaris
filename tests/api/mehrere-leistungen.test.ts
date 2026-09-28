import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { data, get, post, put, requireServer } from '../helpers/client';
import { loginAll, type AccountName } from '../helpers/accounts';
import { resetRateLimits } from '../helpers/rate-limit';
import { eigeneOrganisationId, schutzfreiAufraeumen, testDb, testDbSchliessen } from '../helpers/testdb';

/**
 * Mehrere Leistungen je Buchung und die Verfügbarkeit dazu (Produktsprint
 * 2026-09-26) — über HTTP, gegen den laufenden Server.
 *
 * Das Szenario ist das aus dem Auftrag: An einem Wochentag wird abends von
 * 18:00 bis 22:00 gereinigt (Einsatzzeiten, abweichend von den Bürozeiten),
 * zwei Mitarbeitende arbeiten laut hinterlegter Arbeitszeit genau dann.
 * Vier eigens angelegte Leistungen mit festen Dauern:
 *
 *   Büro   120 min   (Büroreinigung)
 *   Fenster 60 min   (Fensterreinigung)
 *   Grund   60 min   (dritte Leistung, für die Vierstundengrenze)
 *   Lang   300 min   (länger als das Fenster)
 *   MwSt    60 min   (anderer MwSt.-Satz — darf nicht kombiniert werden)
 *
 * Der Prüftag liegt sechs Wochen voraus, damit keine andere Prüfdatei (die
 * ihre Termine in den nächsten drei Wochen sucht) dort Kapazität bindet.
 * Die reine Rechnung (Raster, Puffer, Zeitumstellung) prüft
 * `verfuegbarkeit-rechenkern.test.ts` mit festen Zahlen.
 */

const RUN = Date.now();
const db = testDb();
let jars: Record<AccountName, string>;

const S: Record<'buero' | 'fenster' | 'grund' | 'lang' | 'mwst', string> = { buero: '', fenster: '', grund: '', lang: '', mwst: '' };
let zusatzId = '';
let tag = '';
let wochentag = 0;
let urspruenglicheZeiten: Record<string, unknown>[] = [];
const verfuegbarkeitsIds: string[] = [];
const buchungen: string[] = [];

type Tag = { date: string; available: boolean; closed: boolean; reason?: string; slots: { start: string; label: string; available: boolean }[] };
type Kalender = { data: { dauerMin: number; crew: number; tage: Tag[] } };

const leistung = (id: string, extras: { extraId: string; quantity: number }[] = []) => ({ serviceId: id, extras });

/** 18:00 am Prüftag als UTC-Zeitpunkt — über die Zeitzonendatenbank, nicht mit festem Versatz. */
function zurich(datum: string, hhmm: string): string {
  const [y, m, d] = datum.split('-').map(Number) as [number, number, number];
  const [h, mi] = hhmm.split(':').map(Number) as [number, number];
  const wand = Date.UTC(y, m - 1, d, h, mi);
  const versatz = (t: number) => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Zurich', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        .formatToParts(new Date(t))
        .filter((x) => x.type !== 'literal')
        .map((x) => [x.type, Number(x.value)]),
    ) as Record<string, number>;
    return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!) - t;
  };
  return new Date(wand - versatz(wand - versatz(wand))).toISOString();
}

async function kalender(leistungen: { serviceId: string; extras: unknown[] }[]) {
  const antwort = await post<Kalender>('/api/public/availability', { leistungen, von: tag, tage: 1 });
  assert.equal(antwort.status, 200, antwort.text);
  return data(antwort);
}

const freieZeiten = (k: { tage: Tag[] }) => k.tage.find((t) => t.date === tag)!.slots.filter((s) => s.available).map((s) => s.label);

function gastbuchung(leistungen: unknown[], scheduledStart: string, extra: Record<string, unknown> = {}) {
  return {
    leistungen,
    frequency: 'ONCE',
    scheduledStart,
    propertyKind: 'OFFICE',
    squareMeters: 120,
    hasPets: false,
    firstName: 'Mehrfach',
    lastName: `Prüfung${RUN}`,
    email: `mehrfach.${RUN}.${Math.round(Math.random() * 1e6)}@example.ch`,
    phone: '+41 79 123 45 67',
    address: { street: 'Bundesgasse', streetNo: '3', postalCode: '3011', city: 'Bern', canton: 'BE', country: 'CH' },
    acceptTerms: true,
    website: '',
    ...extra,
  };
}

async function aufraeumen() {
  if (!db) return;
  const ids = Object.values(S).filter(Boolean);
  const verknuepft = ids.length
    ? await db.booking.findMany({ where: { items: { some: { serviceId: { in: ids } } } }, select: { id: true } })
    : [];
  const alle = [...new Set([...buchungen, ...verknuepft.map((b) => b.id)])];
  await schutzfreiAufraeumen(async (tx) => {
    const jobs = (await tx.job.findMany({ where: { bookingId: { in: alle } }, select: { id: true } })).map((j) => j.id);
    const rechnungen = (await tx.invoiceItem.findMany({ where: { jobId: { in: jobs } }, select: { invoiceId: true } })).map((r) => r.invoiceId);
    await tx.invoiceItem.deleteMany({ where: { invoiceId: { in: rechnungen } } });
    await tx.invoice.deleteMany({ where: { id: { in: rechnungen } } });
    await tx.jobChecklistItem.deleteMany({ where: { jobId: { in: jobs } } });
    await tx.jobAssignment.deleteMany({ where: { jobId: { in: jobs } } });
    await tx.job.deleteMany({ where: { id: { in: jobs } } });
    await tx.bookingItem.deleteMany({ where: { bookingId: { in: alle } } });
    await tx.bookingExtra.deleteMany({ where: { bookingId: { in: alle } } });
    await tx.booking.deleteMany({ where: { id: { in: alle } } });
    await tx.availability.deleteMany({ where: { id: { in: verfuegbarkeitsIds } } });
    if (zusatzId) {
      await tx.serviceExtraOnService.deleteMany({ where: { extraId: zusatzId } });
      await tx.serviceExtra.deleteMany({ where: { id: zusatzId } });
    }
    await tx.service.deleteMany({ where: { id: { in: ids } } });
  });
  /**
   * Die Gastkundschaft dieser Datei — auch aus früheren Läufen und auch die
   * aus abgewiesenen Buchungen (der Dienst legt die Kundschaft an, bevor er
   * Preis und Termin prüft). Blieben sie stehen, wären sie die jüngsten
   * Akten im Bestand: `addresses.test.ts` nähme eine davon als „fremde Akte"
   * (mit einer statt zwei Adressen), und Dateien, die für „die jüngste
   * Kundschaft" buchen, hängten ihre Buchungen an sie.
   *
   * Zuerst als gelöscht markiert — damit verschwinden sie aus jeder Liste,
   * auch wenn eine andere Datei inzwischen eine Rechnung an sie gehängt hat
   * (Rechnungen sind unveränderlich, ihre Kundschaft bleibt referenziert).
   * Endgültig entfernt wird, woran keine Rechnung hängt; die Kaskaden nehmen
   * Adressen, Buchungen und Einsätze mit.
   */
  await db.customer.updateMany({ where: { email: { startsWith: 'mehrfach.' }, deletedAt: null }, data: { deletedAt: new Date() } });
  await db.customer.deleteMany({ where: { email: { startsWith: 'mehrfach.' }, invoices: { none: {} } } });
}

before(async () => {
  await requireServer();
  jars = await loginAll();
  resetRateLimits();
  if (!db) return;
  const org = (await eigeneOrganisationId())!;

  const leistungAnlegen = async (schluessel: string, kind: string, minuten: number, vatRate = 8.1) =>
    (
      await db.service.create({
        data: {
          organizationId: org,
          slug: `test-${schluessel}-${RUN}`,
          kind: kind as never,
          name: `Test${schluessel[0]!.toUpperCase()}${schluessel.slice(1)} ${RUN}`,
          shortDesc: 'Prüfleistung',
          description: 'Nur für die Prüfreihe.',
          pricingModel: 'PER_HOUR',
          hourlyRate: 60,
          basePrice: 0,
          minPrice: 0,
          minHours: minuten / 60,
          defaultDurationMin: minuten,
          minutesPerSqm: 0,
          defaultCrewSize: 1,
          bufferMinutes: 0,
          vatRate,
        },
      })
    ).id;
  S.buero = await leistungAnlegen('buero', 'OFFICE_CLEANING', 120);
  S.fenster = await leistungAnlegen('fenster', 'WINDOW_CLEANING', 60);
  S.grund = await leistungAnlegen('grund', 'OFFICE_CLEANING', 60);
  S.lang = await leistungAnlegen('lang', 'SPECIAL', 300);
  S.mwst = await leistungAnlegen('mwst', 'SPECIAL', 60, 2.6);
  zusatzId = (
    await db.serviceExtra.create({
      data: { organizationId: org, slug: `test-zusatz-${RUN}`, name: `Testzusatz ${RUN}`, price: 20, durationMin: 30 },
    })
  ).id;
  await db.serviceExtraOnService.create({ data: { serviceId: S.buero, extraId: zusatzId } });

  // Prüftag: sechs Wochen voraus, kein Feiertag.
  const feiertage = await db.holiday.findMany({ where: { organizationId: org } });
  for (let offset = 42; offset < 70; offset += 1) {
    const kandidat = new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const wt = new Date(`${kandidat}T12:00:00Z`).getUTCDay();
    const istFeiertag = feiertage.some((f) => {
      const d = f.date.toISOString().slice(0, 10);
      return d === kandidat || (f.recurring && d.slice(5) === kandidat.slice(5));
    });
    if (wt >= 1 && wt <= 5 && !istFeiertag) {
      tag = kandidat;
      wochentag = wt;
      break;
    }
  }

  // Einsatzzeiten des Wochentags auf 18:00–22:00, Bürozeiten unverändert.
  urspruenglicheZeiten = data(await get<{ data: Record<string, unknown>[] }>('/api/opening-hours', { jar: jars.admin }));
  const woche = urspruenglicheZeiten.map((z) => ({
    weekday: z.weekday,
    opensAt: (z.opensAt as string | null) ?? '',
    closesAt: (z.closesAt as string | null) ?? '',
    closed: z.closed,
    serviceOpensAt: z.weekday === wochentag ? '18:00' : ((z.serviceOpensAt as string | null) ?? ''),
    serviceClosesAt: z.weekday === wochentag ? '22:00' : ((z.serviceClosesAt as string | null) ?? ''),
    serviceClosed: z.weekday === wochentag ? false : Boolean(z.serviceClosed),
  }));
  const gesetzt = await put('/api/opening-hours', { hours: woche }, { jar: jars.admin });
  assert.equal(gesetzt.status, 200, gesetzt.text);

  // Genau zwei Mitarbeitende arbeiten an diesem Wochentag abends.
  const personal = await db.employee.findMany({
    where: { organizationId: org, active: true, user: { role: 'EMPLOYEE', deletedAt: null } },
    select: { id: true },
    orderBy: { employeeNumber: 'asc' },
    take: 2,
  });
  assert.equal(personal.length, 2, 'zu wenig Demo-Personal');
  for (const p of personal) {
    verfuegbarkeitsIds.push(
      (await db.availability.create({ data: { employeeId: p.id, weekday: wochentag, startTime: '18:00', endTime: '22:00' } })).id,
    );
  }
});

after(async () => {
  if (urspruenglicheZeiten.length) {
    await put(
      '/api/opening-hours',
      {
        hours: urspruenglicheZeiten.map((z) => ({
          weekday: z.weekday,
          opensAt: (z.opensAt as string | null) ?? '',
          closesAt: (z.closesAt as string | null) ?? '',
          closed: z.closed,
          serviceOpensAt: (z.serviceOpensAt as string | null) ?? '',
          serviceClosesAt: (z.serviceClosesAt as string | null) ?? '',
          serviceClosed: Boolean(z.serviceClosed),
        })),
      },
      { jar: jars.admin },
    );
  }
  // Scheitert das Aufräumen, soll der Lauf es zeigen — ein stiller Rest
  // bände am Prüftag Kapazität für den nächsten Lauf.
  try {
    await aufraeumen();
  } finally {
    await testDbSchliessen();
  }
});

describe('Mehrere Leistungen je Buchung', { concurrency: 1 }, () => {
  describe('Preis', () => {
    it('eine Leistung als Liste rechnet genau wie die bisherige Einzelform', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      const alt = data(await post<{ data: { grossTotal: number; lines: unknown[]; durationMinutes: number } }>('/api/public/pricing/estimate', { serviceId: S.buero, squareMeters: 120 }));
      const neu = data(await post<{ data: { grossTotal: number; lines: unknown[]; durationMinutes: number } }>('/api/public/pricing/estimate', { leistungen: [{ serviceId: S.buero, squareMeters: 120, extras: [] }] }));
      assert.equal(neu.grossTotal, alt.grossTotal);
      assert.equal(neu.durationMinutes, alt.durationMinutes);
      assert.deepEqual(neu.lines, alt.lines);
    });

    it('zwei Leistungen: Dauer ist die Summe, jede Leistung hat ihre Zeile, der Preis kommt vom Server', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      const r = data(
        await post<{ data: { durationMinutes: number; subtotal: number; positionen: { serviceId: string; durationMinutes: number }[]; lines: { label: string; kind: string }[] } }>(
          '/api/public/pricing/estimate',
          { leistungen: [leistung(S.buero), leistung(S.fenster)] },
        ),
      );
      assert.equal(r.durationMinutes, 180);
      assert.deepEqual(r.positionen.map((p) => [p.serviceId, p.durationMinutes]), [[S.buero, 120], [S.fenster, 60]]);
      // 2 h + 1 h zu CHF 60 — der Grundpreis ist die Summe beider Leistungen.
      assert.equal(r.subtotal, 180);
      assert.equal(r.lines.filter((l) => l.kind === 'base').length, 2);
    });

    it('drei Leistungen, Zusatzleistung je Leistung: Dauer und Preis nachgerechnet', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      const r = data(
        await post<{ data: { durationMinutes: number; extrasTotal: number; positionen: unknown[] } }>('/api/public/pricing/estimate', {
          leistungen: [leistung(S.buero, [{ extraId: zusatzId, quantity: 1 }]), leistung(S.fenster), leistung(S.grund)],
        }),
      );
      assert.equal(r.positionen.length, 3);
      assert.equal(r.durationMinutes, 120 + 30 + 60 + 60);
      assert.equal(r.extrasTotal, 20);
    });

    it('Hinzufügen und Entfernen rechnen neu — eine Leistung weniger, eine Stunde weniger', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      const zwei = data(await post<{ data: { durationMinutes: number; grossTotal: number } }>('/api/public/pricing/estimate', { leistungen: [leistung(S.buero), leistung(S.fenster)] }));
      const eine = data(await post<{ data: { durationMinutes: number; grossTotal: number } }>('/api/public/pricing/estimate', { leistungen: [leistung(S.buero)] }));
      assert.equal(zwei.durationMinutes - eine.durationMinutes, 60);
      assert.ok(zwei.grossTotal > eine.grossTotal);
    });

    it('unzulässige Kombinationen werden abgewiesen', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      const doppelt = await post('/api/public/pricing/estimate', { leistungen: [leistung(S.buero), leistung(S.buero)] });
      assert.equal(doppelt.status, 422, 'dieselbe Leistung zweimal');
      const mwst = await post('/api/public/pricing/estimate', { leistungen: [leistung(S.buero), leistung(S.mwst)] });
      assert.equal(mwst.status, 422, 'unterschiedliche MwSt.-Sätze');
      const beides = await post('/api/public/pricing/estimate', { serviceId: S.buero, leistungen: [leistung(S.fenster)] });
      assert.equal(beides.status, 422, 'Einzelform und Liste zugleich');
      const sechs = await post('/api/public/pricing/estimate', {
        leistungen: [S.buero, S.fenster, S.grund, S.lang, S.mwst, zusatzId].map((id) => leistung(id)),
      });
      assert.equal(sechs.status, 422, 'mehr als fünf Leistungen');
    });
  });

  describe('Verfügbarkeit im Einsatzfenster 18:00–22:00', () => {
    it('1 Stunde: 18:00 bis 21:00', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      const k = await kalender([leistung(S.fenster)]);
      assert.equal(k.dauerMin, 60);
      assert.deepEqual(freieZeiten(k), ['18:00', '18:30', '19:00', '19:30', '20:00', '20:30', '21:00']);
    });

    it('Büro + Fenster (3 Stunden): 18:00, 18:30, 19:00 — nicht 20:00', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      const k = await kalender([leistung(S.buero), leistung(S.fenster)]);
      assert.equal(k.dauerMin, 180);
      assert.deepEqual(freieZeiten(k), ['18:00', '18:30', '19:00']);
    });

    it('4 Stunden: nur 18:00; mehr als 4 Stunden: der Tag ist nicht wählbar', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      const vier = await kalender([leistung(S.buero), leistung(S.fenster), leistung(S.grund)]);
      assert.deepEqual(freieZeiten(vier), ['18:00']);
      const lang = await kalender([leistung(S.lang)]);
      const d = lang.tage.find((x) => x.date === tag)!;
      assert.equal(d.available, false);
      assert.equal(d.slots.length, 0);
    });

    it('die Einzeltag-Abfrage alter Form rechnet dieselbe Dauer wie der Preis', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      const r = data(await get<{ data: { slots: { label: string; available: boolean }[] } }>(`/api/public/availability?serviceId=${S.buero}&date=${tag}`));
      assert.deepEqual(r.slots.filter((s) => s.available).map((s) => s.label), ['18:00', '18:30', '19:00', '19:30', '20:00']);
    });
  });

  describe('Buchen', () => {
    it('Einzelform (serviceId) bleibt buchbar — 20:00 für 2 Stunden', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      resetRateLimits();
      const r = await post<{ data: { id: string } }>('/api/public/bookings', {
        ...gastbuchung([], zurich(tag, '20:00')),
        leistungen: undefined,
        serviceId: S.buero,
        extras: [],
      });
      assert.equal(r.status, 201, r.text);
      buchungen.push(data(r).id);
      const zeile = await db.booking.findUnique({ where: { id: data(r).id }, include: { items: true } });
      assert.equal(zeile?.durationMin, 120);
      assert.deepEqual([...new Set(zeile?.items.map((i) => i.serviceId))], [S.buero]);
    });

    it('lehnt beim Abschluss ab, was nicht mehr ins Fenster passt — Büro + Fenster um 20:00', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      const r = await post<{ error: { message: string } }>('/api/public/bookings', gastbuchung([leistung(S.buero), leistung(S.fenster)], zurich(tag, '20:00')));
      assert.equal(r.status, 422, r.text);
      assert.match(r.payload.error.message, /Einsatzzeit/);
    });

    it('bucht Büro + Fenster um 19:00: beide Leistungen mit Dauer und Angaben an der Buchung', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      const r = await post<{ data: { id: string; scheduledEnd: string } }>(
        '/api/public/bookings',
        gastbuchung([leistung(S.buero, [{ extraId: zusatzId, quantity: 1 }]), leistung(S.fenster)], zurich(tag, '19:00')),
      );
      // 2 h + 30 min Zusatz + 1 h = 3.5 h — passt um 19:00 nicht mehr (22:30).
      assert.equal(r.status, 422, 'mit Zusatzleistung reicht es bis 22:30');
      const ohne = await post<{ data: { id: string; scheduledEnd: string } }>(
        '/api/public/bookings',
        gastbuchung([leistung(S.buero), leistung(S.fenster)], zurich(tag, '19:00')),
      );
      assert.equal(ohne.status, 201, ohne.text);
      buchungen.push(data(ohne).id);
      assert.equal(data(ohne).scheduledEnd, zurich(tag, '22:00'));

      const zeile = await db.booking.findUnique({ where: { id: data(ohne).id }, include: { items: { orderBy: { position: 'asc' } } } });
      assert.equal(zeile?.durationMin, 180);
      const jeLeistung = zeile!.items.filter((i) => i.durationMin > 0);
      assert.deepEqual(jeLeistung.map((i) => [i.serviceId, i.durationMin]), [[S.buero, 120], [S.fenster, 60]]);
      assert.ok(jeLeistung.every((i) => i.details && (i.details as { serviceId: string }).serviceId === i.serviceId), 'Angaben je Leistung fehlen');
    });

    it('bestehende Buchungen belegen Kapazität — 4 Stunden ab 18:00 ist jetzt nicht mehr frei', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      const k = await kalender([leistung(S.buero), leistung(S.fenster), leistung(S.grund)]);
      assert.deepEqual(freieZeiten(k), []);
      assert.equal(k.tage.find((x) => x.date === tag)!.available, false);
      // Eine Stunde geht noch, solange sie höchstens eine der beiden
      // Belegungen (19–22 und 20–22) berührt: ab 19:30 berührt sie beide.
      assert.deepEqual(freieZeiten(await kalender([leistung(S.fenster)])), ['18:00', '18:30', '19:00']);
    });

    it('zwei gleichzeitige Buchungen für den letzten Platz: genau eine kommt durch', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      // 19:00–20:00: eine Person ist durch die Buchung 19–22 gebunden, eine
      // ist frei. Beide Anfragen haben den Platz im Kalender gesehen.
      const [a, b] = await Promise.all([
        post<{ data: { id: string } }>('/api/public/bookings', gastbuchung([leistung(S.fenster)], zurich(tag, '19:00'))),
        post<{ data: { id: string } }>('/api/public/bookings', gastbuchung([leistung(S.fenster)], zurich(tag, '19:00'))),
      ]);
      const status = [a.status, b.status].sort();
      for (const r of [a, b]) if (r.status === 201) buchungen.push(data(r).id);
      assert.deepEqual(status, [201, 422], `${a.text} | ${b.text}`);
    });
  });

  describe('Nachgelagerte Abläufe', () => {
    it('die Administration sieht alle Leistungen — Liste und Detail', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      const id = buchungen[1]!;
      const namen = await db.service.findMany({ where: { id: { in: [S.buero, S.fenster] } }, select: { name: true } });
      const detail = await get(`/admin/buchungen/${id}`, { jar: jars.admin });
      assert.equal(detail.status, 200);
      for (const n of namen) assert.ok(detail.text.includes(n.name), `Detail ohne ${n.name}`);
      assert.ok(!detail.text.includes('[object Object]'));
      const zeile = await db.booking.findUnique({ where: { id }, select: { number: true } });
      const liste = await get(`/admin/buchungen?q=${encodeURIComponent(zeile!.number)}`, { jar: jars.admin });
      for (const n of namen) assert.ok(liste.text.includes(n.name), `Liste ohne ${n.name}`);
    });

    it('Bestätigen erzeugt einen Einsatz mit beiden Leistungen in Titel, Beschreibung und Checkliste', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      const id = buchungen[1]!;
      const r = await post(`/api/bookings/${id}/confirm`, undefined, { jar: jars.admin });
      assert.equal(r.status, 200, r.text);
      const einsatz = await db.job.findFirst({ where: { bookingId: id }, include: { checklist: true } });
      const namen = (await db.service.findMany({ where: { id: { in: [S.buero, S.fenster] } }, select: { name: true } })).map((s) => s.name);
      assert.ok(einsatz, 'kein Einsatz');
      for (const n of namen) {
        assert.ok(einsatz!.title.includes(n), `Titel ohne ${n}`);
        assert.ok(einsatz!.description?.includes(n), `Beschreibung ohne ${n}`);
        assert.ok(einsatz!.checklist.some((c) => c.label.startsWith(`${n}:`)), `Checkliste ohne ${n}`);
      }
      assert.equal(einsatz!.estimatedMin, 180);
    });

    it('die Rechnung aus dem Einsatz führt jede gebuchte Leistung als eigene Zeile', async (t) => {
      if (!db) return t.skip('keine Testdatenbank');
      const id = buchungen[1]!;
      await db.job.updateMany({ where: { bookingId: id }, data: { status: 'COMPLETED' } });
      const r = await post<{ data: { id: string } }>(`/api/bookings/${id}/invoice`, undefined, { jar: jars.admin });
      assert.equal(r.status, 201, r.text);
      const zeilen = await db.invoiceItem.findMany({ where: { invoiceId: data(r).id } });
      const namen = (await db.service.findMany({ where: { id: { in: [S.buero, S.fenster] } }, select: { name: true } })).map((s) => s.name);
      for (const n of namen) assert.ok(zeilen.some((z) => z.name.startsWith(n)), `Rechnung ohne ${n}`);
    });
  });
});
