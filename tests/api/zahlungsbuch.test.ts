import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import Stripe from 'stripe';

import { BASE_URL, data, get, post, requireServer } from '../helpers/client';
import { loginAll, type AccountName } from '../helpers/accounts';
import { schutzfreiAufraeumen, testDb, testDbGrund, testDbSchliessen } from '../helpers/testdb';
import { PRUEF_STRIPE_GEHEIMNIS } from '../helpers/webhooks';

/**
 * Zahlungsbuch — ein Saldo, gleich welche Reihenfolge und wie oft zugestellt
 * (2026-09-27).
 *
 * **Der Anlass.** Der Stripe-Webhook zog bei `charge.refunded` den
 * *kumulierten* Rückerstattungsbetrag der Zahlung jedes Mal erneut vom
 * bezahlten Betrag ab: Zwei Teilrückerstattungen über 10 und 20 meldet
 * Stripe als 10 und dann 30 — abgezogen wurden 40. Eine erneute Zustellung
 * desselben Ereignisses (Stripe wiederholt, sobald eine Antwort ausbleibt)
 * zog noch einmal ab. Und `saldoNeuBilden`, die zweite Rechnung im System,
 * zählte teilweise erstattete Zahlungen gar nicht — die nächste Büro-Zahlung
 * oder Gutschrift schrieb den Saldo auf „alles offen" zurück.
 *
 * Diese Reihe stellt echte, signierte Ereignisse zu
 * (`Stripe.webhooks.generateTestHeaderString` mit dem Prüfgeheimnis des
 * Testservers) und prüft die Eigenschaft, nicht den Einzelwert: Dieselbe
 * Geschäftsgeschichte ergibt denselben Endstand — einmal, dreimal oder
 * verspätet zugestellt, in dieser oder jener Reihenfolge.
 *
 * Belege tragen die Notiz „Prüfreihe Zahlungsbuch" und werden an den
 * Unveränderlichkeitstriggern vorbei entfernt (wie `finanzbelege.test.ts`).
 */

let jars: Record<AccountName, string>;
const MARKE = 'Prüfreihe Zahlungsbuch';
const RUN = Date.now().toString(36);
let kundeId = '';
let zaehler = 0;

/** 2 × 50 zu 8.1 % — brutto 108.10, in Rappen 10810. */
const BRUTTO = 108.1;
const BRUTTO_RAPPEN = 10_810;

async function aufraeumen() {
  const db = testDb();
  if (!db) return;
  const rechnungen = await db.invoice.findMany({ where: { notes: { contains: MARKE } }, select: { id: true, customerId: true } });
  const ids = rechnungen.map((r) => r.id);
  await db.providerWebhookEvent.deleteMany({ where: { eventId: { startsWith: 'evt_pruef_' } } });
  if (ids.length === 0) return;
  const zahlungen = await db.payment.findMany({ where: { invoiceId: { in: ids } }, select: { amount: true, refundedAmount: true, status: true, customerId: true } });
  await schutzfreiAufraeumen(async (tx) => {
    await tx.payment.deleteMany({ where: { invoiceId: { in: ids } } });
    await tx.creditNote.deleteMany({ where: { invoiceId: { in: ids } } });
    await tx.paymentReminder.deleteMany({ where: { invoiceId: { in: ids } } });
    await tx.invoiceItem.deleteMany({ where: { invoiceId: { in: ids } } });
    await tx.invoice.deleteMany({ where: { id: { in: ids } } });
  });
  // Den Kundenwert zurücknehmen, den die Zahlungen dieser Reihe netto erhöht haben.
  const netto = zahlungen
    .filter((z) => ['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(z.status))
    .reduce((s, z) => s + Number(z.amount) - Number(z.refundedAmount), 0);
  if (Math.abs(netto) > 0.001 && kundeId) {
    await db.customer.update({ where: { id: kundeId }, data: { lifetimeValue: { decrement: Math.round(netto * 100) / 100 } } });
  }
}

async function rechnung(): Promise<string> {
  const antwort = await post<{ data: { id: string } }>(
    '/api/invoices',
    { customerId: kundeId, notes: MARKE, items: [{ name: 'Unterhaltsreinigung', quantity: 2, unit: 'Std.', unitPrice: 50, vatRate: 8.1 }], issueImmediately: true },
    { jar: jars.admin },
  );
  assert.equal(antwort.status, 201, antwort.text);
  const id = data(antwort).id;
  const gespeichert = await testDb()!.invoice.findUniqueOrThrow({ where: { id }, select: { grossTotal: true, status: true } });
  assert.equal(Number(gespeichert.grossTotal), BRUTTO);
  assert.equal(gespeichert.status, 'ISSUED');
  return id;
}

async function stand(invoiceId: string) {
  const r = await testDb()!.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { paidAmount: true, balance: true, status: true } });
  return { bezahlt: Number(r.paidAmount), offen: Number(r.balance), status: r.status };
}

/** Ein signiertes Ereignis zustellen — wie Stripe es tut. */
async function zustellen(ereignis: { id: string; type: string; created?: number; object: Record<string, unknown> }): Promise<number> {
  const payload = JSON.stringify({
    id: ereignis.id,
    object: 'event',
    api_version: '2024-06-20',
    created: ereignis.created ?? Math.floor(Date.now() / 1000),
    livemode: false,
    type: ereignis.type,
    data: { object: ereignis.object },
  });
  const signatur = Stripe.webhooks.generateTestHeaderString({ payload, secret: PRUEF_STRIPE_GEHEIMNIS });
  const antwort = await fetch(`${BASE_URL}/api/webhooks/stripe`, { method: 'POST', headers: { 'stripe-signature': signatur, 'content-type': 'application/json' }, body: payload });
  return antwort.status;
}

const neueId = (art: string) => `${art}_pruef_${RUN}_${++zaehler}`;

function bezahlt(invoiceId: string, intent: string, eventId = neueId('evt')) {
  return zustellen({
    id: eventId,
    type: 'checkout.session.completed',
    object: { id: neueId('cs'), object: 'checkout.session', payment_status: 'paid', payment_intent: intent, amount_total: BRUTTO_RAPPEN, client_reference_id: invoiceId, metadata: { invoiceId, method: 'CARD' } },
  });
}

function erstattet(intent: string, kumuliertRappen: number, opts: { eventId?: string; created?: number } = {}) {
  return zustellen({
    id: opts.eventId ?? neueId('evt'),
    type: 'charge.refunded',
    created: opts.created,
    object: { id: `ch_${intent}`, object: 'charge', payment_intent: intent, amount: BRUTTO_RAPPEN, amount_refunded: kumuliertRappen },
  });
}

before(async () => {
  await requireServer();
  jars = await loginAll();
  assert.ok(testDb(), `kein Zugang zur Testdatenbank: ${testDbGrund()}`);
  kundeId = data(await get<{ data: { id: string }[] }>('/api/customers?pageSize=1', { jar: jars.admin }))[0]!.id;
  await aufraeumen();
});

after(async () => {
  await aufraeumen();
  await testDbSchliessen();
});

describe('Stripe-Ereignisse sind idempotent', () => {
  it('eine dreimal zugestellte Zahlung bucht einmal', async () => {
    const id = await rechnung();
    const intent = neueId('pi');
    const ereignis = neueId('evt');
    for (let i = 0; i < 3; i++) assert.equal(await bezahlt(id, intent, ereignis), 200);
    assert.equal(await testDb()!.payment.count({ where: { invoiceId: id } }), 1);
    assert.deepEqual(await stand(id), { bezahlt: BRUTTO, offen: 0, status: 'PAID' });
  });

  it('zwei Teilrückerstattungen, je doppelt zugestellt, dazu ein verspätetes älteres Ereignis — der Saldo folgt dem letzten Stand', async () => {
    const id = await rechnung();
    const intent = neueId('pi');
    assert.equal(await bezahlt(id, intent), 200);

    const erste = neueId('evt');
    const frueh = Math.floor(Date.now() / 1000) - 120;
    assert.equal(await erstattet(intent, 1_000, { eventId: erste, created: frueh }), 200);
    assert.equal(await erstattet(intent, 1_000, { eventId: erste, created: frueh }), 200);
    assert.deepEqual(await stand(id), { bezahlt: 98.1, offen: 10, status: 'PARTIALLY_PAID' });

    // Stripe meldet kumuliert: 10 + 20 = 30.
    const zweite = neueId('evt');
    assert.equal(await erstattet(intent, 3_000, { eventId: zweite, created: frueh + 60 }), 200);
    assert.equal(await erstattet(intent, 3_000, { eventId: zweite, created: frueh + 60 }), 200);
    assert.deepEqual(await stand(id), { bezahlt: 78.1, offen: 30, status: 'PARTIALLY_PAID' });

    // Ein älteres Ereignis mit neuer Kennung kommt zu spät — es darf den Stand nicht zurückdrehen.
    assert.equal(await erstattet(intent, 1_000, { created: frueh - 60 }), 200);
    assert.deepEqual(await stand(id), { bezahlt: 78.1, offen: 30, status: 'PARTIALLY_PAID' });

    const zahlung = await testDb()!.payment.findFirstOrThrow({ where: { invoiceId: id } });
    assert.equal(Number(zahlung.refundedAmount), 30);
    assert.equal(zahlung.status, 'PARTIALLY_REFUNDED');
  });

  it('eine volle Rückerstattung stellt den offenen Posten wieder her', async () => {
    const id = await rechnung();
    const intent = neueId('pi');
    assert.equal(await bezahlt(id, intent), 200);
    assert.equal(await erstattet(intent, BRUTTO_RAPPEN), 200);
    const s = await stand(id);
    assert.equal(s.bezahlt, 0);
    assert.equal(s.offen, BRUTTO);
    assert.ok(['ISSUED', 'SENT'].includes(s.status), `Status nach voller Rückerstattung: ${s.status}`);
    assert.equal((await testDb()!.payment.findFirstOrThrow({ where: { invoiceId: id } })).status, 'REFUNDED');
  });

  it('ein fehlgeschlagener Versuch blockiert die spätere erfolgreiche Zahlung nicht — auch doppelt gemeldet', async () => {
    const id = await rechnung();
    const intent = neueId('pi');
    const fehler = { id: neueId('evt'), type: 'payment_intent.payment_failed', object: { id: intent, object: 'payment_intent', amount: BRUTTO_RAPPEN, metadata: { invoiceId: id }, last_payment_error: { message: 'Karte abgelehnt' } } };
    assert.equal(await zustellen(fehler), 200);
    assert.equal(await zustellen(fehler), 200, 'Eine erneute Zustellung ist kein Serverfehler');
    assert.equal(await bezahlt(id, intent), 200);
    assert.deepEqual(await stand(id), { bezahlt: BRUTTO, offen: 0, status: 'PAID' });
  });
});

describe('Ein Saldo für alle Wege', () => {
  it('eine Büro-Zahlung nach einer Rückerstattung verliert die Rückerstattung nicht', async () => {
    const id = await rechnung();
    const intent = neueId('pi');
    assert.equal(await bezahlt(id, intent), 200);
    assert.equal(await erstattet(intent, 3_000), 200);
    const buero = await post(`/api/invoices/${id}/payments`, { amount: 30, method: 'BANK_TRANSFER' }, { jar: jars.admin });
    assert.equal(buero.status, 201, buero.text);
    assert.deepEqual(await stand(id), { bezahlt: BRUTTO, offen: 0, status: 'PAID' });
  });

  it('Gutschrift dann Zahlung und Zahlung dann Gutschrift enden im selben Stand', async () => {
    const zuerstGutschrift = await rechnung();
    const zuerstZahlung = await rechnung();
    const gutschrift = { reason: 'Kulanz Prüfreihe', name: 'Kulanz', unitPrice: 10, vatRate: 8.1 };
    const rest = { amount: 97.29, method: 'BANK_TRANSFER' };

    assert.equal((await post(`/api/invoices/${zuerstGutschrift}/credit-note`, gutschrift, { jar: jars.admin })).status, 201);
    assert.equal((await post(`/api/invoices/${zuerstGutschrift}/payments`, rest, { jar: jars.admin })).status, 201);

    assert.equal((await post(`/api/invoices/${zuerstZahlung}/payments`, rest, { jar: jars.admin })).status, 201);
    assert.equal((await post(`/api/invoices/${zuerstZahlung}/credit-note`, gutschrift, { jar: jars.admin })).status, 201);

    assert.deepEqual(await stand(zuerstGutschrift), await stand(zuerstZahlung));
    assert.deepEqual(await stand(zuerstGutschrift), { bezahlt: 97.29, offen: 0, status: 'PAID' });
  });
});

/**
 * Reihenfolge, Storno und Protokoll (2026-09-27, Befunde F-04, N-05, F-14).
 *
 *  • **Rückerstattung vor der Zahlung.** Stripe garantiert keine Reihenfolge.
 *    Kam `charge.refunded` vor `checkout.session.completed`, fand der Webhook
 *    keine Zahlung, schrieb den Ereignisvermerk aber trotzdem fest — jede
 *    Wiederholung galt als „doppelt", die Erstattung war verloren. Jetzt wird
 *    das Ereignis zurückgewiesen (409), und die spätere Zustellung wirkt.
 *  • **Zahlung auf eine stornierte Rechnung.** Der Webhook antwortete 422,
 *    Stripe wiederholte drei Tage lang, und das Geld stand in keiner
 *    Buchhaltung. Jetzt: gebucht, zur Rückzahlung markiert, 200.
 *  • **Zahlung ohne Protokollzeile.** Das Protokoll lief nach dem Commit und
 *    verschluckte Fehler. Geprüft wird die Richtung, auf die es ankommt:
 *    Lässt sich die Zeile nicht schreiben, entsteht auch die Zahlung nicht —
 *    und Stripes nächste Zustellung bucht beides. Die Sperre ist ein
 *    Prüf-Trigger auf `audit_logs`, der nur die Kennungen dieser Reihe trifft.
 */
describe('Reihenfolge, Storno und Protokoll', () => {
  const SPERRE = 'pruef_sperre_zahlungsbuch';

  before(async () => {
    const db = testDb()!;
    await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS ${SPERRE} ("entityId" text PRIMARY KEY)`);
    await db.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION ${SPERRE}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF EXISTS (SELECT 1 FROM ${SPERRE} s WHERE s."entityId" = NEW."entityId") THEN
           RAISE EXCEPTION 'Prüfreihe Zahlungsbuch: Protokoll gesperrt' USING ERRCODE = 'P0001';
         END IF;
         RETURN NEW;
       END $$`,
    );
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${SPERRE} ON audit_logs`);
    await db.$executeRawUnsafe(`CREATE TRIGGER ${SPERRE} BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION ${SPERRE}()`);
  });

  after(async () => {
    const db = testDb();
    if (!db) return;
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${SPERRE} ON audit_logs`);
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${SPERRE}()`);
    await db.$executeRawUnsafe(`DROP TABLE IF EXISTS ${SPERRE}`);
  });

  it('eine Rückerstattung vor ihrer Zahlung wird zurückgewiesen und nach der Zahlung verbucht — nicht als „doppelt" verworfen', async () => {
    const id = await rechnung();
    const intent = neueId('pi');
    const ereignis = neueId('evt');

    const zuFrueh = await erstattet(intent, 3_000, { eventId: ereignis });
    assert.equal(zuFrueh, 409, 'ohne Zahlung ist die Rückerstattung noch nicht anwendbar — Stripe soll erneut zustellen');
    assert.equal(
      await testDb()!.providerWebhookEvent.count({ where: { eventId: ereignis } }),
      0,
      'ein nicht angewandtes Ereignis darf nicht als verarbeitet vermerkt sein',
    );

    assert.equal(await bezahlt(id, intent), 200);
    assert.deepEqual(await stand(id), { bezahlt: BRUTTO, offen: 0, status: 'PAID' });

    // Stripes Wiederholung desselben Ereignisses — jetzt liegt die Zahlung vor.
    assert.equal(await erstattet(intent, 3_000, { eventId: ereignis }), 200);
    assert.deepEqual(await stand(id), { bezahlt: 78.1, offen: 30, status: 'PARTIALLY_PAID' });
    const zahlung = await testDb()!.payment.findFirstOrThrow({ where: { invoiceId: id } });
    assert.equal(Number(zahlung.refundedAmount), 30);
    assert.equal(zahlung.status, 'PARTIALLY_REFUNDED');

    // Und eine weitere Zustellung ist wieder „doppelt" — einmal abgezogen.
    assert.equal(await erstattet(intent, 3_000, { eventId: ereignis }), 200);
    assert.deepEqual(await stand(id), { bezahlt: 78.1, offen: 30, status: 'PARTIALLY_PAID' });
  });

  it('eine Rückerstattung, zu der auch nach Tagen keine Zahlung gehört, wird nicht endlos zurückgewiesen', async () => {
    const ereignis = neueId('evt');
    const vorVierTagen = Math.floor(Date.now() / 1000) - 4 * 24 * 60 * 60;
    assert.equal(await erstattet(neueId('pi'), 1_000, { eventId: ereignis, created: vorVierTagen }), 200);
    assert.equal(await testDb()!.providerWebhookEvent.count({ where: { eventId: ereignis } }), 1, 'endgültig vermerkt');
  });

  it('eine Stripe-Zahlung auf eine stornierte Rechnung wird gebucht, zur Rückzahlung markiert und nicht endlos wiederholt', async () => {
    const id = await rechnung();
    const storno = await post(`/api/invoices/${id}/cancel`, { reason: `${MARKE}: storniert vor der Zahlung` }, { jar: jars.admin });
    assert.equal(storno.status, 200, storno.text);

    const intent = neueId('pi');
    const ereignis = neueId('evt');
    assert.equal(await bezahlt(id, intent, ereignis), 200, 'eingegangenes Geld ist kein Fehler — sonst wiederholt Stripe tagelang');
    assert.equal(await bezahlt(id, intent, ereignis), 200, 'die Wiederholung bucht nicht doppelt');

    const db = testDb()!;
    const zahlungen = await db.payment.findMany({ where: { invoiceId: id } });
    assert.equal(zahlungen.length, 1, 'das Geld ist gebucht — genau einmal');
    assert.equal(zahlungen[0]!.status, 'SUCCEEDED');
    assert.equal(Number(zahlungen[0]!.amount), BRUTTO);
    assert.match(zahlungen[0]!.note ?? '', /stornierte Rechnung/, 'die Zahlung ist zur Rückzahlung markiert');

    const r = await db.invoice.findUniqueOrThrow({ where: { id }, select: { status: true, paidAmount: true, balance: true } });
    assert.equal(r.status, 'CANCELLED', 'der Storno bleibt bestehen');
    assert.equal(Number(r.paidAmount), BRUTTO, 'der eingegangene Betrag steht an der Rechnung');
    assert.equal(Number(r.balance), 0, 'eine stornierte Rechnung hat keinen offenen Posten');

    const protokoll = await db.auditLog.findMany({ where: { entity: 'Invoice', entityId: id, action: 'PAYMENT' } });
    assert.equal(protokoll.length, 1, 'eine Protokollzeile zur Zahlung');
    assert.match(protokoll[0]!.summary ?? '', /storniert/);

    // Die Rückzahlung über Stripe schliesst den Fall.
    assert.equal(await erstattet(intent, BRUTTO_RAPPEN), 200);
    const danach = await db.invoice.findUniqueOrThrow({ where: { id }, select: { status: true, paidAmount: true } });
    assert.equal(danach.status, 'CANCELLED');
    assert.equal(Number(danach.paidAmount), 0);
  });

  it('eine Stripe-Zahlung ohne Protokollzeile gibt es nicht — Stripe stellt erneut zu, dann stehen beide', async () => {
    const id = await rechnung();
    const db = testDb()!;
    const intent = neueId('pi');
    const ereignis = neueId('evt');

    await db.$executeRawUnsafe(`INSERT INTO ${SPERRE} ("entityId") VALUES ($1) ON CONFLICT DO NOTHING`, id);
    try {
      const gesperrt = await bezahlt(id, intent, ereignis);
      assert.ok(gesperrt >= 400, `ohne Protokoll darf die Zahlung nicht als verbucht gelten (kam ${gesperrt})`);
      assert.equal(await db.payment.count({ where: { invoiceId: id } }), 0, 'Zahlung ohne Protokollzeile gebucht');
      assert.deepEqual(await stand(id), { bezahlt: 0, offen: BRUTTO, status: 'ISSUED' });
    } finally {
      await db.$executeRawUnsafe(`DELETE FROM ${SPERRE} WHERE "entityId" = $1`, id);
    }

    assert.equal(await bezahlt(id, intent, ereignis), 200, 'die Wiederholung bucht');
    assert.equal(await db.payment.count({ where: { invoiceId: id } }), 1);
    assert.equal(await db.auditLog.count({ where: { entity: 'Invoice', entityId: id, action: 'PAYMENT' } }), 1);
    assert.deepEqual(await stand(id), { bezahlt: BRUTTO, offen: 0, status: 'PAID' });
  });
});
