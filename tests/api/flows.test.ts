import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { get, post, requireServer } from '../helpers/client';
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

describe('Öffentliche Endpunkte', { concurrency: 1 }, async () => {
  await requireServer();

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
