import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { call, get, post, requireServer } from '../helpers/client';
import { loginAs } from '../helpers/accounts';

/**
 * Die Abläufe, die Geld und Verbindlichkeiten erzeugen.
 *
 * Anders als der Rauchtest fährt diese Datei die Schreibwege ab: Anfrage →
 * Kundschaft → Offerte → Rechnung → Dokument, und den Nachrichtenverlauf
 * zwischen Kundschaft und Büro. Was hier entsteht, bleibt in der
 * Entwicklungsdatenbank stehen — eine ausgestellte Rechnung darf nicht
 * gelöscht werden (Art. 957a OR verlangt eine lückenlose Nummernfolge), und
 * ein Test, der die Regel umginge, prüfte etwas anderes als die Anwendung tut.
 */

const inDays = (days: number) => new Date(Date.now() + days * 864e5);
const dateOnly = (date: Date) => date.toISOString().slice(0, 10);
const unique = (prefix: string) => `${prefix}.${Date.now()}@example.ch`;

/**
 * Der nächste buchbare Termin für die Umzugsreinigung — ab in einer Woche,
 * am ersten Tag mit einem freien Zeitfenster. Wochenenden und Feiertage
 * liefern keine Fenster; deshalb wird über mehrere Tage gesucht.
 */
async function nextBookableSlot(): Promise<{ serviceId: string; scheduledStart: string }> {
  const estimate = await post<{ data: { service: { id: string } } }>(
    '/api/public/pricing/estimate',
    {
      serviceSlug: 'umzugsreinigung',
      propertyKind: 'APARTMENT',
      squareMeters: 85,
      rooms: 3.5,
      frequency: 'ONCE',
      postalCode: '3011',
      extras: [],
    },
  );
  const serviceId = estimate.payload.data.service.id;

  for (let offset = 7; offset < 21; offset += 1) {
    const day = await get<{ data: { slots: { start: string; available: boolean }[] } }>(
      `/api/public/availability?serviceId=${serviceId}&date=${dateOnly(inDays(offset))}` +
        '&durationMin=240&crewSize=2',
    );
    const slot = day.payload.data?.slots?.find((entry) => entry.available);
    if (slot) return { serviceId, scheduledStart: slot.start };
  }
  throw new Error('kein buchbares Zeitfenster in den nächsten drei Wochen — Öffnungszeiten befüllt?');
}

const bookingPayload = (serviceId: string, scheduledStart: string) => ({
  serviceId,
  extras: [],
  frequency: 'ONCE',
  scheduledStart,
  propertyKind: 'APARTMENT',
  squareMeters: 85,
  rooms: 3.5,
  bathrooms: 1,
  hasPets: false,
  address: { street: 'Bundesgasse', streetNo: '1', postalCode: '3011', city: 'Bern', canton: 'BE', country: 'CH' },
  acceptTerms: true,
  website: '',
});

describe('Buchung über die Website', { concurrency: 1 }, async () => {
  await requireServer();

  /**
   * Der Fehler, den diese Fälle festhalten: Für jede angemeldete Sitzung
   * blendete der Assistent die Kontaktfelder aus, der Dienst löste die
   * Kundschaft aber nur für ein Kundenkonto mit Profil auf. Wer als Personal
   * buchte, bekam „Bitte geben Sie Vorname, Nachname …" ohne ein Feld dafür.
   */
  it('verlangt von Personal ohne Kontaktangaben die Kundschaft — und nimmt sie mit an', async () => {
    const admin = await loginAs('admin');
    const { serviceId, scheduledStart } = await nextBookableSlot();

    const missing = await post<{ error: { message: string } }>(
      '/api/public/bookings',
      bookingPayload(serviceId, scheduledStart),
      { jar: admin },
    );
    assert.equal(missing.status, 422, missing.text);
    assert.match(missing.payload.error.message, /Vorname/);

    const created = await post<{ data: { id: string; number: string; isNewCustomer: boolean } }>(
      '/api/public/bookings',
      {
        ...bookingPayload(serviceId, scheduledStart),
        firstName: 'Prüf',
        lastName: 'Buchung',
        email: unique('buchung'),
        phone: '+41 79 123 45 67',
      },
      { jar: admin },
    );
    assert.equal(created.status, 201, created.text);
    assert.equal(created.payload.data.isNewCustomer, true);

    const removed = await call('DELETE', `/api/bookings/${created.payload.data.id}`, { jar: admin });
    assert.ok(removed.status === 204 || removed.status === 200, `Aufräumen: HTTP ${removed.status}`);
  });

  it('bucht für ein Kundenkonto ohne Kontaktfelder auf das eigene Profil', async () => {
    const customer = await loginAs('customer');
    const admin = await loginAs('admin');
    const { serviceId, scheduledStart } = await nextBookableSlot();

    const created = await post<{
      data: { id: string; number: string; confirmationUrl: string; isNewCustomer: boolean };
    }>('/api/public/bookings', bookingPayload(serviceId, scheduledStart), { jar: customer });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.payload.data.isNewCustomer, false, 'bestehendes Profil, kein neuer Datensatz');

    const removed = await call('DELETE', `/api/bookings/${created.payload.data.id}`, { jar: admin });
    assert.ok(removed.status === 204 || removed.status === 200, `Aufräumen: HTTP ${removed.status}`);
  });

  /**
   * Die Bestätigung muss die Kundschaft ausdrucken, herunterladen und aus
   * der E-Mail heraus öffnen können — über den Token ohne Konto, über die
   * Sitzung mit Konto. Eine leere Seite wäre auch 200; die Grösse ist der
   * Beleg, dass tatsächlich ein Dokument gerendert wurde.
   */
  it('liefert die Buchungsbestätigung als PDF und als druckbare Seite', async () => {
    const customer = await loginAs('customer');
    const admin = await loginAs('admin');
    const { serviceId, scheduledStart } = await nextBookableSlot();

    const created = await post<{
      data: { id: string; number: string; confirmationUrl: string };
    }>('/api/public/bookings', bookingPayload(serviceId, scheduledStart), { jar: customer });
    assert.equal(created.status, 201, created.text);
    const { id, number, confirmationUrl } = created.payload.data;
    const token = confirmationUrl.split('/').pop() ?? '';
    assert.ok(token.length >= 10, `kein Token im Bestätigungslink: ${confirmationUrl}`);

    try {
      const viaToken = await get(`/api/public/bookings/${token}/pdf`);
      assert.equal(viaToken.status, 200, viaToken.text.slice(0, 200));
      assert.ok(viaToken.text.length > 3000, `nur ${viaToken.text.length} Bytes`);

      const viaSession = await get(`/api/bookings/${id}/pdf`, { jar: customer });
      assert.equal(viaSession.status, 200, viaSession.text.slice(0, 200));
      assert.ok(viaSession.text.length > 3000, `nur ${viaSession.text.length} Bytes`);

      // Ohne Sitzung gibt es das Dokument nur über den Token.
      assert.equal((await get(`/api/bookings/${id}/pdf`)).status, 401);
      assert.equal((await get('/api/public/bookings/gibt-es-nicht-1234/pdf')).status, 404);

      const page = await get(
        `/buchen/bestaetigt?nr=${encodeURIComponent(number)}&t=${encodeURIComponent(token)}`,
      );
      assert.equal(page.status, 200);
      assert.ok(page.text.includes(number), 'Buchungsnummer fehlt auf der Abschlussseite');
      assert.ok(page.text.includes('PDF herunterladen'), 'Download-Schaltfläche fehlt');
      assert.ok(page.text.includes(`/api/public/bookings/${token}/pdf`), 'Download-Link fehlt');

      const guestPage = await get(`/buchung/${token}`);
      assert.equal(guestPage.status, 200);
      assert.ok(guestPage.text.includes(`/api/public/bookings/${token}/pdf`));
    } finally {
      const removed = await call('DELETE', `/api/bookings/${id}`, { jar: admin });
      assert.ok(removed.status === 204 || removed.status === 200, `Aufräumen: HTTP ${removed.status}`);
    }
  });

  /**
   * Der Fehler dahinter: Ein ungültiger Gutscheincode landete nur als
   * Hinweistext in der Herleitung, und die Buchung ging still zum vollen
   * Preis durch. Die Kundschaft erfuhr erst auf der Rechnung, dass der Code
   * nicht griff. Ein eingegebener Code muss entweder gelten oder die Buchung
   * mit Begründung abweisen — das Feld selbst bleibt freiwillig.
   */
  it('weist eine Buchung mit ungültigem Gutscheincode ab', async () => {
    const customer = await loginAs('customer');
    const { serviceId, scheduledStart } = await nextBookableSlot();

    const response = await post<{ error: { message: string } }>(
      '/api/public/bookings',
      { ...bookingPayload(serviceId, scheduledStart), couponCode: 'GIBTSNICHT' },
      { jar: customer },
    );
    assert.equal(response.status, 422, response.text);
    assert.match(response.payload.error.message, /Gutscheincode/);
  });
});

describe('Öffentliche Endpunkte', { concurrency: 1 }, async () => {
  await requireServer();

  const estimateWith = (couponCode?: string) =>
    post<{
      data: {
        grossTotal: number;
        lines: { key: string; amount: number }[];
        coupon: { code: string; status: string; message: string; amount: number } | null;
      };
    }>('/api/public/pricing/estimate', {
      serviceSlug: 'umzugsreinigung',
      propertyKind: 'APARTMENT',
      squareMeters: 85,
      rooms: 3.5,
      frequency: 'ONCE',
      postalCode: '3011',
      extras: [],
      ...(couponCode ? { couponCode } : {}),
    });

  it('rechnet ohne Gutscheincode und meldet keinen Prüfstand', async () => {
    const response = await estimateWith();
    assert.equal(response.status, 200, response.text);
    assert.equal(response.payload.data.coupon, null);
    assert.ok(!response.payload.data.lines.some((line) => line.key === 'coupon'));
  });

  it('meldet einen unbekannten Gutscheincode als ungültig — ohne den Preis zu ändern', async () => {
    const plain = await estimateWith();
    const response = await estimateWith('GIBTSNICHT');
    assert.equal(response.status, 200, response.text);
    assert.equal(response.payload.data.coupon?.status, 'INVALID');
    assert.match(response.payload.data.coupon?.message ?? '', /ungültig/);
    assert.ok(!response.payload.data.lines.some((line) => line.key === 'coupon'));
    assert.equal(response.payload.data.grossTotal, plain.payload.data.grossTotal);
  });

  it('löst einen gültigen Gutscheincode ein und zieht ihn ab', async () => {
    // EMPFEHLUNG25 aus dem Seed: CHF 25 fest, ab CHF 150 Auftragswert — die
    // Umzugsreinigung einer 85-m²-Wohnung liegt sicher darüber.
    const response = await estimateWith('empfehlung25');
    assert.equal(response.status, 200, response.text);
    assert.equal(response.payload.data.coupon?.status, 'APPLIED');
    assert.equal(response.payload.data.coupon?.code, 'EMPFEHLUNG25', 'Code wird normalisiert');
    assert.equal(response.payload.data.coupon?.amount, 25);

    const line = response.payload.data.lines.find((entry) => entry.key === 'coupon');
    assert.ok(line, 'keine Gutscheinzeile in der Herleitung');
    assert.equal(line.amount, -25);
  });

  /**
   * Der Health Check trägt die Auslieferung: Erst wenn er 200 meldet, gilt sie
   * als erfolgreich, und bleibt er aus, springt sie zurück. Ein Endpunkt mit
   * dieser Aufgabe darf nicht stillschweigend kaputtgehen — ein falsch
   * geschriebener Tabellenname etwa würde ihn dauerhaft auf 503 stellen und
   * damit jede Auslieferung blockieren.
   */
  it('meldet Betriebsbereitschaft samt Datenbank und Migrationen', async () => {
    const response = await get<{
      data: {
        status: string;
        datenbank: string;
        migrationen: number | null;
        version: string | null;
        laufzeitSekunden: number;
      };
    }>('/api/health');

    assert.equal(response.status, 200, response.text);
    assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');

    const daten = response.payload.data;
    assert.equal(daten.status, 'ok');
    assert.equal(daten.datenbank, 'ok');
    assert.ok(
      typeof daten.migrationen === 'number' && daten.migrationen > 0,
      `keine angewandten Migrationen gezählt: ${daten.migrationen}`,
    );
    assert.ok(daten.laufzeitSekunden >= 0);
  });

  it('erkennt eine Postleitzahl im Einsatzgebiet', async () => {
    const response = await get<{ data: { covered: boolean } }>(
      '/api/public/service-areas/check?postalCode=3011',
    );
    assert.equal(response.status, 200);
    assert.equal(response.payload.data.covered, true);
  });

  it('erkennt eine Postleitzahl ausserhalb', async () => {
    const response = await get<{ data: { covered: boolean } }>(
      '/api/public/service-areas/check?postalCode=9000',
    );
    assert.equal(response.status, 200);
    assert.equal(response.payload.data.covered, false);
  });

  it('berechnet einen Preis ohne Anmeldung', async () => {
    const response = await post<{ data: { grossTotal: number; service: { id: string } } }>(
      '/api/public/pricing/estimate',
      {
        serviceSlug: 'umzugsreinigung',
        propertyKind: 'APARTMENT',
        squareMeters: 85,
        rooms: 3.5,
        frequency: 'ONCE',
        postalCode: '3011',
        extras: [],
      },
    );
    assert.equal(response.status, 200);
    assert.ok(response.payload.data.grossTotal > 0, 'Preis von null ist kein Preis');
  });

  it('liefert Termine für den gewählten Tag', async () => {
    const estimate = await post<{ data: { service: { id: string } } }>(
      '/api/public/pricing/estimate',
      {
        serviceSlug: 'umzugsreinigung',
        propertyKind: 'APARTMENT',
        squareMeters: 85,
        rooms: 3.5,
        frequency: 'ONCE',
        postalCode: '3011',
        extras: [],
      },
    );
    const serviceId = estimate.payload.data.service.id;

    const response = await get<{ data: { slots: unknown[] } }>(
      `/api/public/availability?serviceId=${serviceId}&date=${dateOnly(inDays(7))}` +
        '&durationMin=240&crewSize=2',
    );
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.payload.data.slots));
  });

  it('nimmt eine Kontaktanfrage an', async () => {
    const response = await post('/api/public/contact', {
      firstName: 'Test',
      lastName: 'Person',
      email: unique('test'),
      phone: '+41 79 123 45 67',
      message: 'Wir suchen eine wöchentliche Büroreinigung für 220 m² in Bern.',
      acceptPrivacy: true,
      website: '',
    });
    assert.equal(response.status, 201);
  });

  it('weist einen Bot über das Honigtopf-Feld ab', async () => {
    // `website` ist im Formular unsichtbar. Ein Mensch füllt es nie aus.
    const response = await post('/api/public/contact', {
      firstName: 'Bot',
      lastName: 'Spam',
      email: unique('bot'),
      message: 'Kaufen Sie günstige Uhren auf unserer Seite!',
      acceptPrivacy: true,
      website: 'http://spam.example',
    });
    assert.ok(response.status >= 400, `durchgelassen mit HTTP ${response.status}`);
  });

  it('nimmt eine Newsletter-Anmeldung an', async () => {
    const response = await post('/api/public/newsletter', {
      email: unique('news'),
      locale: 'DE',
      website: '',
    });
    assert.equal(response.status, 201);
  });
});

// ---------------------------------------------------------------------------

describe('Schreibpfade der Verwaltung', { concurrency: 1 }, async () => {
  await requireServer();
  const admin = await loginAs('admin');

  let leadId = '';
  let customerId = '';
  let quoteId = '';
  let invoiceId = '';

  it('erfasst eine telefonische Anfrage', async () => {
    const response = await post<{ data: { id: string } }>(
      '/api/leads',
      {
        firstName: 'Rahel',
        lastName: 'Studer',
        email: unique('rahel'),
        phone: '+41 31 555 44 33',
        city: 'Köniz',
        postalCode: '3098',
        serviceKind: 'OFFICE_CLEANING',
        message: 'Telefonisch angefragt: Büro 180 m², zweimal wöchentlich.',
        source: 'PHONE',
        tagIds: [],
      },
      { jar: admin },
    );
    assert.equal(response.status, 201, JSON.stringify(response.payload));
    leadId = response.payload.data.id;
  });

  it('legt eine Firmenkundschaft an', async () => {
    const response = await post<{ data: { id: string } }>(
      '/api/customers',
      {
        type: 'BUSINESS',
        companyName: 'Studer Treuhand AG',
        firstName: 'Rahel',
        lastName: 'Studer',
        email: unique('firma'),
        language: 'DE',
        paymentTermDays: 30,
        discountPercent: 0,
        taxExempt: false,
        tagIds: [],
        createLogin: false,
        address: {
          street: 'Bahnhofstrasse',
          streetNo: '12',
          postalCode: '3098',
          city: 'Köniz',
          country: 'CH',
        },
      },
      { jar: admin },
    );
    assert.equal(response.status, 201, JSON.stringify(response.payload));
    customerId = response.payload.data.id;
  });

  it('erstellt eine Offerte mit optionaler Position', async () => {
    const response = await post<{ data: { id: string } }>(
      '/api/quotes',
      {
        customerId,
        title: 'Büroreinigung Studer Treuhand',
        validUntil: dateOnly(inDays(30)),
        items: [
          {
            name: 'Unterhaltsreinigung Büro',
            quantity: 8,
            unit: 'Std.',
            unitPrice: 62,
            discount: 0,
            vatRate: 8.1,
            optional: false,
          },
          {
            name: 'Fensterreinigung innen',
            quantity: 3,
            unit: 'Std.',
            unitPrice: 68,
            discount: 0,
            vatRate: 8.1,
            optional: true,
          },
        ],
        discountValue: 0,
      },
      { jar: admin },
    );
    assert.equal(response.status, 201, JSON.stringify(response.payload));
    quoteId = response.payload.data.id;
  });

  it('erzeugt ein Offerten-PDF mit Inhalt', async () => {
    const response = await get(`/api/quotes/${quoteId}/pdf`, { jar: admin });
    assert.equal(response.status, 200);
    // Eine leere Seite wäre auch 200. Die Grösse ist der Beleg.
    assert.ok(response.text.length > 3000, `nur ${response.text.length} Bytes`);
  });

  it('dupliziert eine Offerte', async () => {
    const response = await post(`/api/quotes/${quoteId}/duplicate`, undefined, { jar: admin });
    assert.equal(response.status, 201);
  });

  it('stellt eine Rechnung aus', async () => {
    const response = await post<{ data: { id: string } }>(
      '/api/invoices',
      {
        customerId,
        items: [
          {
            name: 'Unterhaltsreinigung März',
            quantity: 32,
            unit: 'Std.',
            unitPrice: 62,
            discount: 0,
            vatRate: 8.1,
          },
        ],
        discountAmount: 0,
        issueImmediately: true,
      },
      { jar: admin },
    );
    assert.equal(response.status, 201, JSON.stringify(response.payload));
    invoiceId = response.payload.data.id;
  });

  it('erzeugt ein Rechnungs-PDF mit Einzahlungsschein', async () => {
    const response = await get(`/api/invoices/${invoiceId}/pdf`, { jar: admin });
    assert.equal(response.status, 200);
    // Der Swiss-QR-Code allein bringt das Dokument über zehn Kilobyte.
    assert.ok(response.text.length > 10_000, `nur ${response.text.length} Bytes — QR-Teil fehlt?`);
  });

  it('legt eine Aufgabe zur Anfrage an', async () => {
    const response = await post(
      '/api/tasks',
      {
        title: 'Offerte Studer nachfassen',
        priority: 'HIGH',
        dueAt: inDays(3).toISOString(),
        leadId,
      },
      { jar: admin },
    );
    assert.equal(response.status, 201, JSON.stringify(response.payload));
  });
});

// ---------------------------------------------------------------------------

describe('Nachrichtenverlauf', { concurrency: 1 }, async () => {
  await requireServer();
  const admin = await loginAs('admin');
  const customer = await loginAs('customer');

  let threadId = '';

  it('lässt die Kundschaft einen Verlauf eröffnen', async () => {
    const response = await post<{ data: { id: string } }>(
      '/api/messages',
      {
        subject: 'Schlüsselübergabe',
        body: 'Guten Tag, können wir den Schlüssel diesmal bei der Nachbarin deponieren?',
      },
      { jar: customer },
    );
    assert.equal(response.status, 201, JSON.stringify(response.payload));
    threadId = response.payload.data.id;
  });

  it('nimmt eine Ergänzung an', async () => {
    const response = await post(
      `/api/messages/${threadId}`,
      { body: 'Ergänzung: Frau Meier, 2. Stock.' },
      { jar: customer },
    );
    assert.equal(response.status, 201);
  });

  it('zeigt dem Büro den vollständigen Verlauf', async () => {
    const response = await get<{ data: { messages: unknown[] } }>(`/api/messages/${threadId}`, {
      jar: admin,
    });
    assert.equal(response.status, 200);
    assert.equal(response.payload.data.messages.length, 2);
  });

  it('lässt das Büro antworten und abschliessen', async () => {
    const response = await post(
      `/api/messages/${threadId}`,
      { body: 'Gerne — wir notieren das.', close: true },
      { jar: admin },
    );
    assert.equal(response.status, 201);
  });

  it('verweigert die Antwort in einem geschlossenen Verlauf', async () => {
    const response = await post(`/api/messages/${threadId}`, { body: 'Noch etwas?' }, {
      jar: customer,
    });
    assert.equal(response.status, 422);
  });
});

// ---------------------------------------------------------------------------

describe('Zugriffsschutz', { concurrency: 1 }, async () => {
  await requireServer();
  const customer = await loginAs('customer');
  const manager = await loginAs('manager');

  it('verwehrt der Kundschaft die Kundenliste', async () => {
    assert.equal((await get('/api/customers', { jar: customer })).status, 403);
  });

  it('verwehrt der Kundschaft die Personalliste', async () => {
    assert.equal((await get('/api/employees', { jar: customer })).status, 403);
  });

  it('verwehrt der Betriebsleitung das Anlegen von Personal', async () => {
    const response = await post(
      '/api/employees',
      { firstName: 'X', lastName: 'Y', email: 'x@y.ch', hiredAt: '2026-01-01' },
      { jar: manager },
    );
    assert.equal(response.status, 403);
  });

  it('antwortet ohne Anmeldung mit 401', async () => {
    assert.equal((await get('/api/customers')).status, 401);
  });

  it('lässt geplante Aufgaben nicht ohne Token laufen', async () => {
    assert.equal((await get('/api/cron/daily')).status, 401);
  });

  it('lässt geplante Aufgaben mit Token laufen', async () => {
    const secret = process.env.CRON_SECRET ?? 'dev-cron-secret';
    const response = await get('/api/cron/daily', {
      headers: { authorization: `Bearer ${secret}` },
    });
    assert.equal(response.status, 200, 'stimmt CRON_SECRET in .env mit dem Test überein?');
  });
});
