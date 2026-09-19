import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { data, del, get, post, requireServer } from '../helpers/client';
import { loginAll, type AccountName } from '../helpers/accounts';

/**
 * Links, die ohne Anmeldung funktionieren — Verhalten über HTTP.
 *
 * Was hier geprüft wird, ist nicht die Rechnung hinter dem Token (die steht
 * in `zugriffstokens.test.ts`), sondern was ein Fremder von aussen erreicht:
 * dass ein geratener Wert nichts verrät, dass ein Token der einen Art nicht
 * für die andere gilt, und vor allem, dass eine Offerte auch bei mehreren
 * gleichzeitigen Antworten genau einmal beantwortet wird.
 *
 * Der Rennzustand ist der Grund, aus dem es diese Datei gibt: `respondToQuote`
 * las den Status, prüfte ihn und schrieb danach. Zwei gleichzeitige Annahmen
 * sahen beide `SENT` — und lösten beide die Folgeaktionen aus.
 */

type Jars = Record<AccountName, string>;

interface QuoteDetail {
  id: string;
  number: string;
  status: string;
  publicToken: string;
}

const RUN = Date.now();

/**
 * Eine gültige Unterschrift: ein 1×1-PNG als Data-URL.
 *
 * Das Schema verlangt zur Annahme Name **und** Unterschrift
 * (`respondQuoteSchema`) — eine Annahme ohne Unterschrift ist fachlich keine.
 * Der Bildinhalt spielt keine Rolle, das Format schon.
 */
const UNTERSCHRIFT =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const ANNAHME = { decision: 'ACCEPT', signatureName: `Pruef ${RUN}`, signatureDataUrl: UNTERSCHRIFT };

function inTagen(tage: number): string {
  const d = new Date();
  d.setDate(d.getDate() + tage);
  return d.toISOString().slice(0, 10);
}

describe('Öffentliche Links — Bindung, Rennen, Altbestand', () => {
  let jars: Jars;
  let customerId = '';
  const angelegteOfferten: string[] = [];

  /** Eine frische Offerte im Zustand DRAFT, mit ihrem Alt-Token. */
  const offerteAnlegen = async (titel: string): Promise<QuoteDetail> => {
    const angelegt = await post<{ data: { id: string } }>(
      '/api/quotes',
      {
        customerId,
        title: titel,
        validUntil: inTagen(30),
        items: [
          { name: 'Prüfposition', quantity: 1, unit: 'Pauschal', unitPrice: 100, vatRate: 8.1 },
        ],
      },
      { jar: jars.admin },
    );
    assert.equal(angelegt.status, 201, angelegt.text);
    const id = data(angelegt).id;
    angelegteOfferten.push(id);

    const detail = await get<{ data: QuoteDetail }>(`/api/quotes/${id}`, { jar: jars.admin });
    assert.equal(detail.status, 200, detail.text);
    return data(detail);
  };

  before(async () => {
    await requireServer();
    jars = await loginAll();

    const objekte = data(
      await get<{ data: { customer: { id: string } }[] }>('/api/properties', { jar: jars.admin }),
    );
    assert.ok(objekte.length > 0, 'Der Demobestand enthält Objekte');
    customerId = objekte[0]!.customer.id;
  });

  after(async () => {
    for (const id of angelegteOfferten) {
      await del(`/api/quotes/${id}`, { jar: jars.admin });
    }
  });

  // =========================================================================
  //  Unbekannte und missgebildete Werte
  // =========================================================================

  it('beantwortet geratene und missgebildete Werte gleich — ohne Auskunft', async () => {
    /**
     * Geprüft wird über die **Leseroute**, nicht über die Antwortroute.
     *
     * Nicht aus Bequemlichkeit: `publicTokenAction` erlaubt zehn Versuche in
     * zehn Minuten, und genau dieses knappe Kontingent ist der Sinn der
     * Sache — ein Test, der es aufbraucht, blockiert sich selbst und sagt
     * nichts über das Produkt. Die Frage, ob eine Ablehnung etwas verrät,
     * stellt sich an beiden Routen gleich; die Leseroute beantwortet sie mit
     * `publicTokenRead` (60/min), ohne die Bremse für die echten Handlungen
     * zu verbrauchen.
     */
    const proben = [
      'nichtvorhanden',
      'c'.repeat(25), // sieht aus wie ein cuid
      '0'.repeat(64), // sieht aus wie ein neuer Token
      'AAAA1111bbbb2222cccc3333',
    ];

    const antworten: number[] = [];
    for (const wert of proben) {
      const r = await get(`/api/public/quotes/${encodeURIComponent(wert)}/pdf`);
      antworten.push(r.status);
      assert.ok(
        !/existiert nicht|unbekannt|gelöscht|Organisation|publicToken/i.test(r.text),
        `keine Auskunft über den Grund: ${r.text.slice(0, 200)}`,
      );
    }

    // Alle Ablehnungen sehen gleich aus. Unterschiede wären eine Auskunft
    // darüber, welche Werte es gibt.
    assert.equal(
      new Set(antworten).size,
      1,
      `einheitliche Antwort erwartet, erhalten: ${antworten.join(', ')}`,
    );
    assert.equal(antworten[0], 404);
  });

  it('nimmt ein Offert-Token nicht an der Rechnungsroute an', async () => {
    const offerte = await offerteAnlegen(`Zweckbindung ${RUN}`);

    const fremd = await get(`/api/public/invoices/${offerte.publicToken}/pdf`);
    assert.equal(fremd.status, 404, 'ein Offert-Token öffnet keine Rechnung');

    const eigen = await get(`/api/public/quotes/${offerte.publicToken}/pdf`);
    assert.equal(eigen.status, 200, `an der eigenen Route gilt er: ${eigen.status}`);
  });

  // =========================================================================
  //  Der Rennzustand
  // =========================================================================

  it('beantwortet eine Offerte auch bei gleichzeitigen Anfragen genau einmal', async () => {
    const offerte = await offerteAnlegen(`Rennen ${RUN}`);

    /**
     * Vier gleichzeitige Annahmen. Vor der Korrektur lasen alle denselben
     * Status, bestanden alle die Prüfung und schrieben alle — mit vier
     * Meldungen ans Büro und vier neu gerenderten PDF als Folge.
     *
     * `Promise.all` startet sie ohne Wartezeit dazwischen; das Fenster
     * zwischen Lesen und Schreiben ist genau das, was getroffen werden soll.
     *
     * `retries: 0`, damit ein etwaiger 429 sofort sichtbar wird, statt vom
     * Klienten ausgesessen zu werden — hier interessiert der Wettlauf, nicht
     * die Bremse.
     */
    const antworten = await Promise.all(
      Array.from({ length: 4 }, () =>
        post(`/api/public/quotes/${offerte.publicToken}/respond`, ANNAHME, { retries: 0 }),
      ),
    );

    const erfolge = antworten.filter((r) => r.status === 200);
    const abgewiesen = antworten.filter((r) => r.status === 422);

    assert.equal(
      erfolge.length,
      1,
      `genau eine Annahme, erhalten: ${antworten.map((r) => r.status).join(', ')}`,
    );
    assert.equal(abgewiesen.length, 3, 'die übrigen drei werden fachlich abgewiesen');
    for (const r of abgewiesen) assert.match(r.text, /bereits beantwortet/i);

    const danach = await get<{ data: QuoteDetail }>(`/api/quotes/${offerte.id}`, { jar: jars.admin });
    assert.equal(data(danach).status, 'ACCEPTED', 'der Zustand ist eindeutig');
  });

  it('lässt eine bereits beantwortete Offerte nicht nachträglich ablehnen', async () => {
    const offerte = await offerteAnlegen(`Nachzuegler ${RUN}`);

    const ersteAntwort = await post(
      `/api/public/quotes/${offerte.publicToken}/respond`,
      ANNAHME,
      { retries: 0 },
    );
    assert.equal(ersteAntwort.status, 200, ersteAntwort.text);

    const zweiteAntwort = await post(
      `/api/public/quotes/${offerte.publicToken}/respond`,
      { decision: 'REJECT', reason: 'Doch nicht' },
      { retries: 0 },
    );
    assert.equal(zweiteAntwort.status, 422, zweiteAntwort.text);

    const danach = await get<{ data: QuoteDetail }>(`/api/quotes/${offerte.id}`, { jar: jars.admin });
    assert.equal(data(danach).status, 'ACCEPTED', 'die Annahme bleibt stehen');
  });

  it('zeigt die beantwortete Offerte über denselben Link weiter an', async () => {
    // Die Einmaligkeit liegt im Geschäftszustand, nicht im Link: Wer
    // unterschrieben hat, soll die Bestätigung wieder aufrufen können.
    const offerte = angelegteOfferten.length > 0 ? angelegteOfferten : [];
    assert.ok(offerte.length > 0);

    const letzte = await get<{ data: QuoteDetail }>(
      `/api/quotes/${angelegteOfferten[angelegteOfferten.length - 1]}`,
      { jar: jars.admin },
    );
    const pdf = await get(`/api/public/quotes/${data(letzte).publicToken}/pdf`);
    assert.equal(pdf.status, 200, 'das Dokument bleibt erreichbar');
  });

  // =========================================================================
  //  Ausstellung beim Versand
  // =========================================================================

  it('versendet eine Offerte und stellt dabei einen sicheren Link aus', async () => {
    /**
     * Der Versand ist der Ort, an dem der neue Token entsteht — `sendQuote`
     * widerruft die alten für diese Offerte und legt einen frischen an.
     *
     * Über HTTP lässt sich der rohe Token bewusst **nicht** beobachten: Er
     * steht nur in der Nachricht an die Empfängerin, und in der Datenbank
     * liegt allein sein SHA-256-Hash. Genau das ist der Zweck der Sache, und
     * genau deshalb prüft dieser Test nur, was von aussen sichtbar ist —
     * dass der Versand durchläuft und den Zustand richtig setzt.
     *
     * Dass die Zeile mit einem Hash und ohne Klartext entsteht, ist Sache von
     * `zugriffstokens.test.ts` und der Bestandsprüfung im Gate-Bericht.
     */
    const offerte = await offerteAnlegen(`Versand ${RUN}`);

    const versand = await post(
      `/api/quotes/${offerte.id}/send`,
      { attachPdf: false },
      { jar: jars.admin },
    );
    assert.equal(versand.status, 200, versand.text);

    const danach = await get<{ data: QuoteDetail & { sentAt: string | null } }>(
      `/api/quotes/${offerte.id}`,
      { jar: jars.admin },
    );
    assert.equal(data(danach).status, 'SENT', 'der Zustand wechselt auf versendet');
    assert.ok(data(danach).sentAt, 'der Versandzeitpunkt ist gesetzt');

    // Der alte Link bleibt während des Übergangs gültig — sonst brächen
    // bereits versendete Nachrichten (siehe `legacyTokensAllowed`).
    const alt = await get(`/api/public/quotes/${offerte.publicToken}/pdf`);
    assert.equal(alt.status, 200, 'der Altbestandslink funktioniert weiter');
  });

  // =========================================================================
  //  Altbestand (§29)
  // =========================================================================

  it('lässt bestehende Offert- und Rechnungslinks weiter funktionieren', async () => {
    const offerte = await offerteAnlegen(`Altbestand ${RUN}`);
    const alt = await get(`/api/public/quotes/${offerte.publicToken}/pdf`);
    assert.equal(alt.status, 200, 'alter Offertlink');

    const rechnungen = data(
      await get<{ data: { publicToken: string }[] }>('/api/invoices?pageSize=1', {
        jar: jars.admin,
      }),
    );
    if (rechnungen.length > 0 && rechnungen[0]!.publicToken) {
      const r = await get(`/api/public/invoices/${rechnungen[0]!.publicToken}/pdf`);
      assert.equal(r.status, 200, `alter Rechnungslink: ${r.status}`);
    }
  });
});
