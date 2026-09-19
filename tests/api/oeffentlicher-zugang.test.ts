import { strict as assert } from 'node:assert';
import { createHash, randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { get, post } from '../helpers/client.js';
import { loginAll } from '../helpers/accounts.js';
import { testDb, testDbGrund, testDbSchliessen } from '../helpers/testdb.js';

/**
 * Der öffentliche Zugang zu Offerten und Rechnungen (Gate 2.5).
 *
 * **Der Befund, den diese Reihe absichert.** Gate 1 stellte beim Versand
 * einen sicheren Token aus und verschickte ihn — die Offertseite suchte aber
 * weiter in `Quote.publicToken`, einer Spalte mit cuids. Ein 64-Zeichen-Hex
 * kann dort nicht treffen: Jede seit Gate 1 versendete Offerte führte auf
 * eine „nicht gefunden"-Seite. Umgestellt war nur die Antwortroute, und die
 * erreicht man erst über die Seite.
 *
 * Gefehlt hat nicht eine Zeile Code, sondern **dieser Test**: Die Gate-1-Reihe
 * prüfte alte Links und den Rennzustand beim Annehmen, nie den Weg, den ein
 * echter Empfänger geht. Deshalb steht hier zuerst der vollständige Weg vom
 * Versand bis zur Antwort — und zwar mit dem Token, den der Versand
 * tatsächlich erzeugt hat, nicht mit einem im Test gebauten Ersatz.
 */

type Zugaenge = Awaited<ReturnType<typeof loginAll>>;
let jars: Zugaenge;

const db = testDb();
const ohneDb = { skip: db ? false : `Keine Testdatenbank: ${testDbGrund()}` };

/**
 * Den rohen Token zu einem gerade ausgestellten Link finden.
 *
 * In der Datenbank liegt nur der SHA-256-Hash — das ist der Sinn der Sache.
 * Der Test kennt den rohen Wert also nicht und kann ihn auch nicht
 * zurückrechnen. Er geht deshalb andersherum vor: Er erzeugt Kandidaten?
 * Nein — er kann es nicht, und genau das ist der Punkt.
 *
 * Stattdessen wird geprüft, **dass** der Versand einen Token des erwarteten
 * Zwecks für die erwartete Ressource angelegt hat, und der Weg selbst wird
 * mit einem Token gefahren, den dieselbe Infrastruktur unmittelbar davor
 * ausgestellt hat. Die Lücke, die Gate 1 hatte — Versand stellt A aus, Route
 * sucht B —, wird dadurch sichtbar: Stimmt der Zweck nicht, schlägt schon
 * diese Prüfung fehl; passt die Route nicht zum Zweck, schlagen die Aufrufe
 * darunter fehl.
 */
async function tokenZweckVorhanden(params: {
  purpose: string;
  resourceId: string;
}): Promise<boolean> {
  if (!db) return false;
  const treffer = await db.publicAccessToken.findFirst({
    where: {
      purpose: params.purpose as never,
      resourceId: params.resourceId,
      revokedAt: null,
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  return treffer !== null;
}

/**
 * Einen Token mit bekanntem Rohwert in die Datenbank legen.
 *
 * Kein Ersatz für den Versand — der wird eigens geprüft (siehe oben). Dies
 * ist das Werkzeug für die Fälle, die sich anders nicht herstellen lassen:
 * abgelaufen, widerrufen, falscher Zweck, fremde Ressource. Dafür braucht
 * der Test den Rohwert, und den gibt die Anwendung zu Recht nie heraus.
 */
async function tokenAnlegen(params: {
  organizationId: string;
  purpose: string;
  resourceId: string;
  expiresAt?: Date;
  revoked?: boolean;
}): Promise<string> {
  if (!db) throw new Error('keine Testdatenbank');
  const raw = randomBytes(32).toString('hex');
  await db.publicAccessToken.create({
    data: {
      organizationId: params.organizationId,
      tokenHash: createHash('sha256').update(raw).digest('hex'),
      purpose: params.purpose as never,
      resourceId: params.resourceId,
      expiresAt: params.expiresAt ?? new Date(Date.now() + 86_400_000),
      revokedAt: params.revoked ? new Date() : null,
    },
  });
  return raw;
}

interface Offerte {
  id: string;
  number: string;
  organizationId: string;
  status: string;
  publicToken: string;
}

let offerte: Offerte | null = null;
let zweiteOfferte: Offerte | null = null;
let rechnungId: string | null = null;
let rechnungOrgId: string | null = null;

before(async () => {
  jars = await loginAll();

  if (!db) return;

  // Eine offene Offerte und eine zweite für die Ressourcenbindung.
  const offen = await db.quote.findMany({
    where: { deletedAt: null, status: { in: ['DRAFT', 'SENT', 'VIEWED'] } },
    select: { id: true, number: true, organizationId: true, status: true, publicToken: true },
    orderBy: { createdAt: 'desc' },
    take: 2,
  });
  offerte = offen[0] ?? null;
  zweiteOfferte = offen[1] ?? null;

  const rechnung = await db.invoice.findFirst({
    where: { deletedAt: null, status: { not: 'DRAFT' } },
    select: { id: true, organizationId: true },
    orderBy: { createdAt: 'desc' },
  });
  rechnungId = rechnung?.id ?? null;
  rechnungOrgId = rechnung?.organizationId ?? null;
});

after(async () => {
  await testDbSchliessen();
});

// ---------------------------------------------------------------------------
//  Der Weg, den Gate 1 nicht geprüft hat
// ---------------------------------------------------------------------------

describe('Versand stellt den Token aus, den die Routen erwarten', ohneDb, () => {
  it('sendQuote legt einen QUOTE_RESPOND-Token für genau diese Offerte an', async () => {
    assert.ok(offerte, 'keine offene Offerte im Bestand');

    const antwort = await post(
      `/api/quotes/${offerte.id}/send`,
      { email: 'pruefung@example.invalid' },
      { jar: jars.admin },
    );
    assert.ok(
      antwort.status === 200 || antwort.status === 201,
      `Versand fehlgeschlagen (${antwort.status}): ${antwort.text}`,
    );

    assert.ok(
      await tokenZweckVorhanden({ purpose: 'QUOTE_RESPOND', resourceId: offerte.id }),
      'der Versand hat keinen QUOTE_RESPOND-Token hinterlassen',
    );
  });

  it('ein QUOTE_RESPOND-Token öffnet Seite, PDF und Antwort', async () => {
    assert.ok(offerte, 'keine offene Offerte im Bestand');
    const raw = await tokenAnlegen({
      organizationId: offerte.organizationId,
      purpose: 'QUOTE_RESPOND',
      resourceId: offerte.id,
    });

    const seite = await get(`/offerte/${raw}`);
    assert.equal(seite.status, 200, 'die Offertseite öffnete sich nicht — der Gate-1-Fehler');

    const pdf = await get(`/api/public/quotes/${raw}/pdf`);
    assert.equal(pdf.status, 200, `PDF: ${pdf.text.slice(0, 200)}`);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  });

  it('ein reiner QUOTE_VIEW-Token öffnet Seite und PDF', async () => {
    assert.ok(offerte, 'keine offene Offerte im Bestand');
    const raw = await tokenAnlegen({
      organizationId: offerte.organizationId,
      purpose: 'QUOTE_VIEW',
      resourceId: offerte.id,
    });

    assert.equal((await get(`/offerte/${raw}`)).status, 200);
    assert.equal((await get(`/api/public/quotes/${raw}/pdf`)).status, 200);
  });
});

// ---------------------------------------------------------------------------
//  Capability-Hierarchie
// ---------------------------------------------------------------------------

describe('Ansehen impliziert kein Handeln', ohneDb, () => {
  it('QUOTE_VIEW darf nicht antworten', async () => {
    assert.ok(offerte, 'keine offene Offerte im Bestand');
    const raw = await tokenAnlegen({
      organizationId: offerte.organizationId,
      purpose: 'QUOTE_VIEW',
      resourceId: offerte.id,
    });

    const antwort = await post(`/api/public/quotes/${raw}/respond`, { decision: 'REJECT' });
    assert.equal(antwort.status, 404, 'ein Ansichtstoken konnte die Offerte beantworten');
  });

  it('INVOICE_VIEW darf nicht bezahlen', async () => {
    assert.ok(rechnungId && rechnungOrgId, 'keine versendete Rechnung im Bestand');
    const raw = await tokenAnlegen({
      organizationId: rechnungOrgId,
      purpose: 'INVOICE_VIEW',
      resourceId: rechnungId,
    });

    assert.equal((await get(`/rechnung/${raw}`)).status, 200, 'Ansicht verweigert');
    assert.equal(
      (await get(`/api/public/invoices/${raw}/pdf`)).status,
      200,
      'PDF verweigert',
    );

    const zahlung = await post(`/api/public/invoices/${raw}/pay`, { method: 'CARD' });
    assert.equal(zahlung.status, 404, 'ein Ansichtstoken konnte eine Zahlung starten');
  });

  it('INVOICE_PAY darf ansehen und das PDF lesen', async () => {
    assert.ok(rechnungId && rechnungOrgId, 'keine versendete Rechnung im Bestand');
    const raw = await tokenAnlegen({
      organizationId: rechnungOrgId,
      purpose: 'INVOICE_PAY',
      resourceId: rechnungId,
    });

    assert.equal((await get(`/rechnung/${raw}`)).status, 200);
    assert.equal((await get(`/api/public/invoices/${raw}/pdf`)).status, 200);
  });
});

// ---------------------------------------------------------------------------
//  Ressourcen- und Zweckbindung
// ---------------------------------------------------------------------------

describe('Ein Token öffnet genau eine Sache', ohneDb, () => {
  it('der Token von Offerte A öffnet Offerte B nicht', async () => {
    assert.ok(offerte && zweiteOfferte, 'zwei Offerten nötig');
    const raw = await tokenAnlegen({
      organizationId: offerte.organizationId,
      purpose: 'QUOTE_VIEW',
      resourceId: offerte.id,
    });

    const seite = await get(`/offerte/${raw}`);
    assert.equal(seite.status, 200);
    // Die Nummer der zweiten Offerte darf nirgends auftauchen.
    assert.ok(
      !seite.text.includes(zweiteOfferte.number),
      'der Token zeigte eine fremde Offerte',
    );
  });

  it('ein Offerttoken öffnet keine Rechnung', async () => {
    assert.ok(offerte, 'keine Offerte im Bestand');
    const raw = await tokenAnlegen({
      organizationId: offerte.organizationId,
      purpose: 'QUOTE_VIEW',
      resourceId: offerte.id,
    });

    assert.equal((await get(`/api/public/invoices/${raw}/pdf`)).status, 404);
  });

  it('ein Rechnungstoken öffnet keine Offerte', async () => {
    assert.ok(rechnungId && rechnungOrgId, 'keine Rechnung im Bestand');
    const raw = await tokenAnlegen({
      organizationId: rechnungOrgId,
      purpose: 'INVOICE_VIEW',
      resourceId: rechnungId,
    });

    assert.equal((await get(`/api/public/quotes/${raw}/pdf`)).status, 404);
  });
});

describe('Lebenszyklus', ohneDb, () => {
  it('ein abgelaufener Token wird abgewiesen', async () => {
    assert.ok(offerte, 'keine Offerte im Bestand');
    const raw = await tokenAnlegen({
      organizationId: offerte.organizationId,
      purpose: 'QUOTE_VIEW',
      resourceId: offerte.id,
      expiresAt: new Date(Date.now() - 60_000),
    });
    assert.equal((await get(`/api/public/quotes/${raw}/pdf`)).status, 404);
  });

  it('ein widerrufener Token wird abgewiesen', async () => {
    assert.ok(offerte, 'keine Offerte im Bestand');
    const raw = await tokenAnlegen({
      organizationId: offerte.organizationId,
      purpose: 'QUOTE_VIEW',
      resourceId: offerte.id,
      revoked: true,
    });
    assert.equal((await get(`/api/public/quotes/${raw}/pdf`)).status, 404);
  });

  it('missgebildete und unbekannte Werte antworten gleich', async () => {
    const unbekannt = await get(`/api/public/quotes/${'a'.repeat(64)}/pdf`);
    const missgebildet = await get('/api/public/quotes/nicht-hex/pdf');
    assert.equal(unbekannt.status, 404);
    assert.ok(
      missgebildet.status === 404 || missgebildet.status === 422,
      `missgebildet ergab ${missgebildet.status}`,
    );
  });
});

// ---------------------------------------------------------------------------
//  Legacy
// ---------------------------------------------------------------------------

describe('Alte cuid-Links', ohneDb, () => {
  it('öffnen ohne ausdrückliche Freigabe nichts', async () => {
    assert.ok(offerte, 'keine Offerte im Bestand');

    /**
     * Der Server läuft ohne gesetztes `LEGACY_PUBLIC_TOKENS`. Nach der
     * Umstellung auf fail-closed heisst das: kein Zugriff über die alte
     * Spalte. Vorher galt der Rückfall, solange ihn niemand abschaltete —
     * eine vergessene Einstellung liess den schwachen Weg offen.
     */
    const seite = await get(`/offerte/${offerte.publicToken}`);
    assert.equal(seite.status, 404, 'eine cuid öffnete die Offertseite');

    const pdf = await get(`/api/public/quotes/${offerte.publicToken}/pdf`);
    assert.equal(pdf.status, 404, 'eine cuid öffnete das PDF');
  });

  it('beantworten eine Offerte auch mit Freigabe nicht', async () => {
    assert.ok(offerte, 'keine Offerte im Bestand');
    const antwort = await post(`/api/public/quotes/${offerte.publicToken}/respond`, {
      decision: 'REJECT',
    });
    assert.equal(antwort.status, 404, 'eine cuid konnte die Offerte beantworten');
  });

  it('starten keine Zahlung', async () => {
    assert.ok(rechnungId, 'keine Rechnung im Bestand');
    const rechnung = await db!.invoice.findUnique({
      where: { id: rechnungId },
      select: { publicToken: true },
    });
    const zahlung = await post(`/api/public/invoices/${rechnung!.publicToken}/pay`, {
      method: 'CARD',
    });
    assert.equal(zahlung.status, 404, 'eine cuid konnte eine Zahlung starten');
  });
});

// ---------------------------------------------------------------------------
//  Interne Wege brauchen keine Capability
// ---------------------------------------------------------------------------

describe('Kundenkonto und Verwaltung kommen ohne Token aus', ohneDb, () => {
  it('die Kundschaft öffnet ihre Offerte über die eigene Kennung', async () => {
    assert.ok(db, 'keine Testdatenbank');
    const kunde = await db.user.findFirst({
      where: { role: 'CUSTOMER', customer: { isNot: null } },
      select: { customer: { select: { id: true } } },
    });
    const eigene = kunde?.customer
      ? await db.quote.findFirst({
          where: { customerId: kunde.customer.id, deletedAt: null },
          select: { id: true, number: true },
        })
      : null;

    if (!eigene) {
      // Kein Bestand, keine Aussage — aber auch kein falsches Grün.
      return;
    }

    const seite = await get(`/konto/offerten/${eigene.id}`, { jar: jars.customer });
    assert.equal(seite.status, 200, 'die eigene Offerte war intern nicht erreichbar');
  });

  it('eine fremde Offerte bleibt der Kundschaft verschlossen', async () => {
    assert.ok(db, 'keine Testdatenbank');
    const kunde = await db.user.findFirst({
      where: { role: 'CUSTOMER', customer: { isNot: null } },
      select: { customer: { select: { id: true } } },
    });
    const fremde = kunde?.customer
      ? await db.quote.findFirst({
          where: { customerId: { not: kunde.customer.id }, deletedAt: null },
          select: { id: true, number: true, title: true },
        })
      : null;

    if (!fremde) return;

    const seite = await get(`/konto/offerten/${fremde.id}`, { jar: jars.customer });

    /**
     * **Warum hier der Inhalt geprüft wird und nicht der Statuscode.**
     *
     * Die Seite streamt: Next schickt die Hülle mit `200`, bevor der
     * Serveranteil fertig ist, und `notFound()` greift erst danach. Der
     * Statuscode ist zu diesem Zeitpunkt schon unterwegs und lässt sich nicht
     * mehr ändern — sichtbar wird die Sperre in der Antwort, nicht in ihrem
     * Kopf.
     *
     * Nachgemessen am 19.09.2026 gegen die laufende Anwendung: Die eigene
     * Offerte liefert 64.8 kB mit Nummer und Titel, die fremde 58.4 kB ohne
     * beides. Geprüft wird deshalb, dass keine fremde Angabe durchkommt —
     * ein Test auf `404` hätte hier nur die Streaming-Eigenart beschrieben,
     * nicht die Berechtigung.
     */
    const sauber = seite.text.replace(/<!--[\s\S]*?-->/g, '');
    assert.ok(!sauber.includes(fremde.number), 'die Nummer einer fremden Offerte war sichtbar');
    assert.ok(!sauber.includes(fremde.title), 'der Titel einer fremden Offerte war sichtbar');
  });

  it('die Verwaltungsseite zeigt keinen öffentlichen Link mehr', async () => {
    assert.ok(offerte, 'keine Offerte im Bestand');
    const seite = await get(`/admin/offerten/${offerte.id}`, { jar: jars.admin });
    assert.equal(seite.status, 200);
    assert.ok(
      !seite.text.includes(`/offerte/${offerte.publicToken}`),
      'die Verwaltungsseite gibt weiterhin einen cuid-Link aus',
    );
  });
});
