import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

import { data, del, get, post, requireServer } from '../helpers/client';
import { loginAll, type AccountName } from '../helpers/accounts';
import { testDb, testDbGrund, testDbSchliessen } from '../helpers/testdb';

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
 *
 * **Umgestellt in Gate 2.5.** Diese Reihe fuhr bis dahin mit
 * `quote.publicToken`, also mit dem alten cuid. Das ging, weil der Rückfall
 * auf alte Links galt, solange ihn niemand abschaltete. Genau diese
 * Voreinstellung war falsch herum: Eine vergessene Umgebungsvariable liess
 * den schwachen Weg offen. Sie ist jetzt fail-closed, und die Prüfungen
 * fahren mit echten Capability-Tokens — denselben, die der Versand ausstellt.
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
 * Die Annahme — seit Gate 4C ohne Name und ohne Bild.
 *
 * Hier standen beide, weil `respondQuoteSchema` sie verlangte und die Route
 * die Offerte damit unmittelbar auf ACCEPTED setzte. Seit Gate 4C beginnt
 * `ACCEPT` nur den Unterzeichnungsvorgang; Name und Unterschrift kommen im
 * Signaturkern an, gegen einen eingefrorenen Snapshot. Der ganze Weg steht
 * in `offertannahme.test.ts` — diese Datei prüft weiterhin nur, was an den
 * *Links* hängt.
 */
const ANNAHME = { decision: 'ACCEPT' };

function inTagen(tage: number): string {
  const d = new Date();
  d.setDate(d.getDate() + tage);
  return d.toISOString().slice(0, 10);
}

const db = testDb();
const ohneDb = { skip: db ? false : `Keine Testdatenbank: ${testDbGrund()}` };

/**
 * Einen Capability-Token mit bekanntem Rohwert anlegen.
 *
 * Die Anwendung gibt den Rohwert zu Recht nie heraus — in der Datenbank
 * liegt nur sein SHA-256-Hash. Für eine Prüfung, die den Link *benutzen*
 * muss, bleibt deshalb nur, ihn mit demselben Verfahren selbst anzulegen.
 * Dass der Versand seinerseits den richtigen Zweck ausstellt, prüft
 * `oeffentlicher-zugang.test.ts` gesondert.
 */
async function capability(params: {
  organizationId: string;
  purpose: 'QUOTE_VIEW' | 'QUOTE_RESPOND' | 'INVOICE_VIEW' | 'INVOICE_PAY';
  resourceId: string;
}): Promise<string> {
  if (!db) throw new Error('keine Testdatenbank');
  const raw = randomBytes(32).toString('hex');
  await db.publicAccessToken.create({
    data: {
      organizationId: params.organizationId,
      tokenHash: createHash('sha256').update(raw).digest('hex'),
      purpose: params.purpose as never,
      resourceId: params.resourceId,
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  return raw;
}

describe('Öffentliche Links — Bindung, Rennen, Altbestand', () => {
  let jars: Jars;
  let customerId = '';
  let organizationId = '';
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

    if (db) {
      const org = await db.organization.findFirst({ select: { id: true } });
      organizationId = org?.id ?? '';
    }
  });

  after(async () => {
    for (const id of angelegteOfferten) {
      await del(`/api/quotes/${id}`, { jar: jars.admin });
    }
    await testDbSchliessen();
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

  it('nimmt ein Offert-Token nicht an der Rechnungsroute an', ohneDb, async () => {
    const offerte = await offerteAnlegen(`Zweckbindung ${RUN}`);
    const token = await capability({
      organizationId,
      purpose: 'QUOTE_VIEW',
      resourceId: offerte.id,
    });

    const fremd = await get(`/api/public/invoices/${token}/pdf`);
    assert.equal(fremd.status, 404, 'ein Offert-Token öffnet keine Rechnung');

    const eigen = await get(`/api/public/quotes/${token}/pdf`);
    assert.equal(eigen.status, 200, `an der eigenen Route gilt er: ${eigen.status}`);
  });

  // =========================================================================
  //  Der Rennzustand
  // =========================================================================

  it('beginnt auch bei gleichzeitigen Anfragen genau einen Annahmevorgang', ohneDb, async () => {
    const offerte = await offerteAnlegen(`Rennen ${RUN}`);
    const token = await capability({
      organizationId,
      purpose: 'QUOTE_RESPOND',
      resourceId: offerte.id,
    });

    /**
     * Vier gleichzeitige Annahmen. Vor der Korrektur aus Gate 1 lasen alle
     * denselben Status, bestanden alle die Prüfung und schrieben alle — mit
     * vier Meldungen ans Büro und vier neu gerenderten PDF als Folge.
     *
     * **Was sich mit Gate 4C verschoben hat.** Die Einmaligkeit liegt nicht
     * mehr im Statusübergang der Offerte — `ACCEPT` setzt gar keinen Status
     * mehr —, sondern im Annahmevorgang: Vier gleichzeitige Starts dürfen
     * nicht vier Snapshots mit vier Links ergeben. Dafür sorgt der
     * Teilindex `signature_requests_offene_annahme_je_offerte`. Antworten
     * dürfen deshalb alle vier mit 200 kommen; sie führen auf **denselben**
     * Vorgang, und genau das wird hier gemessen.
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
        post<{ data: { requiresSignature: boolean; signatureUrl?: string } }>(
          `/api/public/quotes/${token}/respond`,
          ANNAHME,
          { retries: 0 },
        ),
      ),
    );

    const erfolge = antworten.filter((r) => r.status === 200);
    assert.ok(
      erfolge.length >= 1,
      `mindestens ein Start gelingt, erhalten: ${antworten.map((r) => r.status).join(', ')}`,
    );
    for (const r of erfolge) {
      assert.equal(data(r).requiresSignature, true, 'die Annahme entscheidet nicht, sie beginnt');
    }

    const vorgaenge = await db!.signatureRequest.count({ where: { quoteId: offerte.id } });
    assert.equal(vorgaenge, 1, `genau ein Annahmevorgang, nicht ${vorgaenge}`);

    const danach = await get<{ data: QuoteDetail }>(`/api/quotes/${offerte.id}`, { jar: jars.admin });
    assert.notEqual(
      data(danach).status,
      'ACCEPTED',
      'ohne abgeschlossene Unterzeichnung wird nichts angenommen',
    );
  });

  it('lässt eine bereits abgelehnte Offerte nicht nachträglich annehmen', ohneDb, async () => {
    const offerte = await offerteAnlegen(`Nachzuegler ${RUN}`);
    const token = await capability({
      organizationId,
      purpose: 'QUOTE_RESPOND',
      resourceId: offerte.id,
    });

    /**
     * Die Richtung ist gedreht: Seit Gate 4C ist die **Ablehnung** der
     * terminale Einzeiler, die Annahme dagegen ein mehrstufiger Vorgang.
     * Was terminal ist, bleibt terminal — das prüft dieser Fall. Der
     * umgekehrte Weg (abgeschlossene Annahme, danach Ablehnung) steht in
     * `offertannahme.test.ts`, wo die Unterzeichnung wirklich gefahren wird.
     */
    const ersteAntwort = await post(
      `/api/public/quotes/${token}/respond`,
      { decision: 'REJECT', reason: 'Doch nicht' },
      { retries: 0 },
    );
    assert.equal(ersteAntwort.status, 200, ersteAntwort.text);

    const zweiteAntwort = await post(`/api/public/quotes/${token}/respond`, ANNAHME, {
      retries: 0,
    });
    assert.equal(zweiteAntwort.status, 422, zweiteAntwort.text);
    assert.match(zweiteAntwort.text, /bereits beantwortet/i);

    const danach = await get<{ data: QuoteDetail }>(`/api/quotes/${offerte.id}`, { jar: jars.admin });
    assert.equal(data(danach).status, 'REJECTED', 'die Ablehnung bleibt stehen');
    assert.equal(
      await db!.signatureRequest.count({ where: { quoteId: offerte.id } }),
      0,
      'und erzeugt keinen Vorgang',
    );
  });

  it('zeigt die beantwortete Offerte über denselben Link weiter an', ohneDb, async () => {
    // Die Einmaligkeit liegt im Geschäftszustand, nicht im Link: Wer
    // unterschrieben hat, soll die Bestätigung wieder aufrufen können.
    assert.ok(angelegteOfferten.length > 0);
    const letzteId = angelegteOfferten[angelegteOfferten.length - 1]!;
    const token = await capability({
      organizationId,
      purpose: 'QUOTE_VIEW',
      resourceId: letzteId,
    });

    const pdf = await get(`/api/public/quotes/${token}/pdf`);
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
  });

  // =========================================================================
  //  Altbestand — jetzt fail-closed
  // =========================================================================

  it('lässt alte cuid-Links ohne ausdrückliche Freigabe nicht mehr gelten', async () => {
    /**
     * **Diese Prüfung stand vorher auf dem Kopf.** Sie hiess „lässt
     * bestehende Offert- und Rechnungslinks weiter funktionieren" und
     * erwartete `200` — weil `legacyTokensAllowed()` galt, solange niemand
     * die Umgebungsvariable auf `aus` setzte.
     *
     * Die Voreinstellung war damit falsch herum: Eine neue Instanz, ein
     * neuer Server, eine verlorene Umgebungsdatei — überall stand der
     * schwache Weg offen, ohne dass es jemandem auffiel. Eine vergessene
     * Einstellung muss zur sicheren Seite fallen.
     *
     * Der Übergang ist damit nicht abgeschafft, nur ausdrücklich: Wer alte
     * Links während des Rollouts weiter bedienen will, setzt
     * `LEGACY_PUBLIC_TOKENS=true`. Der Prüfserver läuft ohne, also gilt hier
     * die sichere Seite.
     */
    const offerte = await offerteAnlegen(`Altbestand ${RUN}`);
    const alt = await get(`/api/public/quotes/${offerte.publicToken}/pdf`);
    assert.equal(alt.status, 404, 'ein cuid öffnete das Offert-PDF');

    const rechnungen = data(
      await get<{ data: { publicToken: string }[] }>('/api/invoices?pageSize=1', {
        jar: jars.admin,
      }),
    );
    if (rechnungen.length > 0 && rechnungen[0]!.publicToken) {
      const r = await get(`/api/public/invoices/${rechnungen[0]!.publicToken}/pdf`);
      assert.equal(r.status, 404, 'ein cuid öffnete das Rechnungs-PDF');
    }
  });
});
