import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Prisma } from '@prisma/client';
import Stripe from 'stripe';

import { BASE_URL, data, del, get, post, requireServer } from '../helpers/client';
import { loginAll, type AccountName } from '../helpers/accounts';
import { resetRateLimits } from '../helpers/rate-limit';
import { fremdeOrganisation, schutzfreiAufraeumen, testDb, testDbGrund, testDbSchliessen } from '../helpers/testdb';
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
  // Der Vermerk „Ausfall dieser Rückerstattung verbucht" trägt die Kennung der
  // Rückerstattung, nicht die des Ereignisses (`AUSFALL_VERMERK`).
  await db.providerWebhookEvent.deleteMany({ where: { eventId: { startsWith: 'rueckerstattung_ausgefallen:re_pruef_' } } });
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

/**
 * Eine Rückerstattung ändert ihren Status — wie Stripe es mit
 * `refund.updated`, `refund.failed` oder dem älteren `charge.refund.updated`
 * meldet. Das Objekt ist die *eine* Rückerstattung, nicht die Charge.
 */
function rueckerstattungGeaendert(
  intent: string,
  refundId: string,
  betragRappen: number,
  opts: { type?: string; status?: string; erstellt: number; created: number; eventId?: string },
) {
  return zustellen({
    id: opts.eventId ?? neueId('evt'),
    type: opts.type ?? 'refund.updated',
    created: opts.created,
    object: {
      id: refundId,
      object: 'refund',
      amount: betragRappen,
      currency: 'chf',
      charge: `ch_${intent}`,
      payment_intent: intent,
      status: opts.status ?? 'failed',
      created: opts.erstellt,
    },
  });
}

async function kundenwert(): Promise<number> {
  const k = await testDb()!.customer.findUniqueOrThrow({ where: { id: kundeId }, select: { lifetimeValue: true } });
  return Number(k.lifetimeValue);
}

const rund = (n: number) => Math.round(n * 100) / 100;

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

  /**
   * B-08 (2026-09-28): Zwei Rappen zu wenig sind eine Rundungsdifferenz —
   * bezahlt, und **nichts** offen. Gegen den alten Stand: Status PAID, aber
   * `offen` 0.02; das Kundenkonto zeigte die Rechnung als offen, und eine
   * weitere Zahlung über 0.02 wurde angenommen.
   */
  it('zwei Rappen zu wenig: bezahlt ohne offenen Rest, keine weitere Zahlung', async () => {
    const id = await rechnung();
    const knapp = Math.round((BRUTTO - 0.02) * 100) / 100;
    assert.equal((await post(`/api/invoices/${id}/payments`, { amount: knapp, method: 'BANK_TRANSFER' }, { jar: jars.admin })).status, 201);
    assert.deepEqual(await stand(id), { bezahlt: knapp, offen: 0, status: 'PAID' });
    const nachschuss = await post(`/api/invoices/${id}/payments`, { amount: 0.02, method: 'BANK_TRANSFER' }, { jar: jars.admin });
    assert.equal(nachschuss.status, 422, `Zahlung auf eine bezahlte Rechnung: HTTP ${nachschuss.status}`);
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

/**
 * Gescheiterte Rückerstattungen (2026-09-27, Rest von F-04).
 *
 * Eine Rückerstattung kann bei Stripe Tage nach ihrer Auslösung scheitern
 * (`failed`) oder, solange sie aussteht, abgebrochen werden (`canceled`).
 * Dann ist das Geld nie zurückgegangen, und Stripes kumulierter Stand der
 * Zahlung sinkt wieder. Bis hierher behandelte der Webhook keines der
 * Ereignisse dazu: Der Saldo blieb gesenkt, und die Rechnung wäre als offen
 * gemahnt worden, obwohl die Kundschaft bezahlt hatte.
 *
 * Geprüft wird, was an diesem Weg brechen kann: dass der Ausfall genau
 * einmal wirkt, obwohl Stripe ihn über drei Ereignistypen und beliebig oft
 * meldet; dass ein verspätetes `charge.refunded` den Ausfall nicht
 * zurückdreht; und dass ein Ausfall, der *vor* dem `charge.refunded` seiner
 * Rückerstattung ankommt, keine andere, gültige Rückerstattung ausbucht.
 */
describe('Gescheiterte Rückerstattungen folgen Stripes Stand', () => {
  it('eine Rückerstattung scheitert bei Stripe — Stand, Saldo und Kundenwert kehren zurück, genau einmal über alle drei Ereignistypen', async () => {
    const id = await rechnung();
    const intent = neueId('pi');
    const wertVorher = await kundenwert();
    assert.equal(await bezahlt(id, intent), 200);

    const frueh = Math.floor(Date.now() / 1000) - 600;
    const erste = neueId('re');
    const zweite = neueId('re');
    // Zwei Rückerstattungen: 10, dann 20 — Stripe meldet kumuliert 10 und 30.
    assert.equal(await erstattet(intent, 1_000, { created: frueh }), 200);
    assert.equal(await erstattet(intent, 3_000, { created: frueh + 30 }), 200);
    assert.deepEqual(await stand(id), { bezahlt: 78.1, offen: 30, status: 'PARTIALLY_PAID' });

    // Ein Statuswechsel ohne Ausfall ändert nichts und wird nicht vermerkt.
    const erfolgreich = neueId('evt');
    assert.equal(await rueckerstattungGeaendert(intent, zweite, 2_000, { status: 'succeeded', erstellt: frueh + 30, created: frueh + 40, eventId: erfolgreich }), 200);
    assert.deepEqual(await stand(id), { bezahlt: 78.1, offen: 30, status: 'PARTIALLY_PAID' });
    assert.equal(await testDb()!.providerWebhookEvent.count({ where: { eventId: erfolgreich } }), 0);

    // Die zweite Rückerstattung scheitert: Der Stand sinkt von 30 auf 10.
    const ausfall = neueId('evt');
    assert.equal(await rueckerstattungGeaendert(intent, zweite, 2_000, { erstellt: frueh + 30, created: frueh + 60, eventId: ausfall }), 200);
    assert.deepEqual(await stand(id), { bezahlt: 98.1, offen: 10, status: 'PARTIALLY_PAID' });

    // Dieselbe Zustellung noch einmal, derselbe Ausfall über die beiden
    // anderen Ereignistypen, und das verspätete `charge.refunded` von
    // damals mit neuer Kennung — nichts davon darf den Stand bewegen.
    assert.equal(await rueckerstattungGeaendert(intent, zweite, 2_000, { erstellt: frueh + 30, created: frueh + 60, eventId: ausfall }), 200);
    assert.equal(await rueckerstattungGeaendert(intent, zweite, 2_000, { type: 'refund.failed', erstellt: frueh + 30, created: frueh + 61 }), 200);
    assert.equal(await rueckerstattungGeaendert(intent, zweite, 2_000, { type: 'charge.refund.updated', erstellt: frueh + 30, created: frueh + 61 }), 200);
    assert.equal(await erstattet(intent, 3_000, { created: frueh + 30 }), 200);
    assert.deepEqual(await stand(id), { bezahlt: 98.1, offen: 10, status: 'PARTIALLY_PAID' }, 'der Ausfall wirkt genau einmal');

    const db = testDb()!;
    let zahlung = await db.payment.findFirstOrThrow({ where: { invoiceId: id } });
    assert.equal(Number(zahlung.refundedAmount), 10);
    assert.equal(zahlung.status, 'PARTIALLY_REFUNDED');
    assert.equal(rund((await kundenwert()) - wertVorher), rund(BRUTTO - 10), 'der Kundenwert trägt nur die gültige Rückerstattung');

    // Auch die erste scheitert: Die Zahlung steht wieder ganz.
    assert.equal(await rueckerstattungGeaendert(intent, erste, 1_000, { type: 'refund.failed', erstellt: frueh, created: frueh + 90 }), 200);
    assert.deepEqual(await stand(id), { bezahlt: BRUTTO, offen: 0, status: 'PAID' });
    zahlung = await db.payment.findFirstOrThrow({ where: { invoiceId: id } });
    assert.equal(Number(zahlung.refundedAmount), 0);
    assert.equal(zahlung.status, 'SUCCEEDED');
    assert.equal(zahlung.refundedAt, null);
    assert.equal(rund((await kundenwert()) - wertVorher), BRUTTO);
  });

  it('ein Ausfall vor dem charge.refunded seiner Rückerstattung bucht keine andere Rückerstattung aus', async () => {
    const id = await rechnung();
    const intent = neueId('pi');
    assert.equal(await bezahlt(id, intent), 200);

    const frueh = Math.floor(Date.now() / 1000) - 600;
    assert.equal(await erstattet(intent, 1_000, { created: frueh }), 200);
    assert.deepEqual(await stand(id), { bezahlt: 98.1, offen: 10, status: 'PARTIALLY_PAID' });

    // Die zweite Rückerstattung (20) wird abgebrochen, und die Meldung
    // darüber kommt an, bevor ihr `charge.refunded` (kumuliert 30) da ist.
    // Sie ist im Stand noch nicht enthalten — abzuziehen wäre die erste.
    const zweite = neueId('re');
    assert.equal(await rueckerstattungGeaendert(intent, zweite, 2_000, { status: 'canceled', erstellt: frueh + 30, created: frueh + 60 }), 200);
    assert.deepEqual(await stand(id), { bezahlt: 98.1, offen: 10, status: 'PARTIALLY_PAID' });

    // Das verspätete `charge.refunded` zählt die abgebrochene noch mit — es ist älter als der Ausfall.
    assert.equal(await erstattet(intent, 3_000, { created: frueh + 30 }), 200);
    assert.deepEqual(await stand(id), { bezahlt: 98.1, offen: 10, status: 'PARTIALLY_PAID' });
    assert.equal(Number((await testDb()!.payment.findFirstOrThrow({ where: { invoiceId: id } })).refundedAmount), 10);
  });
});

/**
 * Monotonie der Rückerstattung (2026-09-29).
 *
 * `charge.refunded` trägt Stripes **kumulierten** Stand. Er wächst — ausser
 * wenn eine Rückerstattung scheitert oder abgebrochen wird, und dafür gibt es
 * den eigenen Weg über `refund.failed`/`refund.updated` (oben). Deshalb die
 * Regel, die diese Fälle festhalten: **`charge.refunded` bewegt den Stand nur
 * nach oben; gesenkt wird er ausschliesslich über den Ausfall.**
 *
 * Bis 2026-09-29 übernahm ein *neueres* `charge.refunded` auch einen
 * kleineren Stand. Zusammen mit dem Ausfallereignis derselben Rückerstattung
 * wurde dann zweimal gesenkt: 30 + 20 erstattet, 30 scheitert, ein
 * `charge.refunded` meldet 20 (übernommen), dann `refund.failed` über 30
 * (nochmals abgezogen) — der Stand fiel auf 0, und die gültige
 * Rückerstattung über 20 verschwand aus Saldo und Kundenwert.
 *
 * Erwartungen in `Prisma.Decimal` gerechnet, nicht in Gleitkomma.
 */
describe('Monotonie der Rückerstattung', () => {
  const D = (wert: string | number) => new Prisma.Decimal(wert);
  const brutto = D(BRUTTO);
  const sekunde = () => Math.floor(Date.now() / 1000) - 900;

  it('gleiche Sekunde: kleinerer Stand übergangen, gleicher idempotent, grösserer genau einmal übernommen', async () => {
    const id = await rechnung();
    const intent = neueId('pi');
    const wertVorher = await kundenwert();
    assert.equal(await bezahlt(id, intent), 200);
    const s = sekunde();

    assert.equal(await erstattet(intent, 3_000, { created: s }), 200);
    const nach30 = { bezahlt: brutto.minus(30).toNumber(), offen: 30, status: 'PARTIALLY_PAID' };
    assert.deepEqual(await stand(id), nach30);

    assert.equal(await erstattet(intent, 1_000, { created: s }), 200, 'kleinerer Stand, gleiche Sekunde');
    assert.deepEqual(await stand(id), nach30, 'ein kleinerer Stand derselben Sekunde dreht zurück');

    assert.equal(await erstattet(intent, 3_000, { created: s }), 200, 'gleicher Stand, neue Kennung');
    assert.deepEqual(await stand(id), nach30, 'derselbe Stand ändert nichts');

    const hoeher = neueId('evt');
    assert.equal(await erstattet(intent, 5_000, { created: s, eventId: hoeher }), 200);
    assert.equal(await erstattet(intent, 5_000, { created: s, eventId: hoeher }), 200, 'dieselbe Zustellung erneut');
    assert.equal(await erstattet(intent, 5_000, { created: s }), 200, 'derselbe Stand mit neuer Kennung');
    assert.deepEqual(await stand(id), { bezahlt: brutto.minus(50).toNumber(), offen: 50, status: 'PARTIALLY_PAID' });
    assert.equal(D(await kundenwert()).minus(D(wertVorher)).toNumber(), brutto.minus(50).toNumber(), 'der Kundenwert sinkt genau einmal um 50');
  });

  /*
    Älter und höher: Ein Stand, der älter ist als der gespeicherte, aber
    höher, kann nur eine Rückerstattung mitzählen, die inzwischen
    gescheitert ist (der Stand wächst sonst nur). Er gilt als veraltet — die
    Entscheidung ist gewollt, nicht zufällig, und hier festgehalten.
  */
  it('älteres Ereignis mit höherem Stand wird übergangen — der neuere Stand gilt', async () => {
    const id = await rechnung();
    const intent = neueId('pi');
    assert.equal(await bezahlt(id, intent), 200);
    const s = sekunde();
    assert.equal(await erstattet(intent, 1_000, { created: s + 60 }), 200);
    assert.equal(await erstattet(intent, 3_000, { created: s }), 200, 'älter, aber höher');
    assert.deepEqual(await stand(id), { bezahlt: brutto.minus(10).toNumber(), offen: 10, status: 'PARTIALLY_PAID' });
  });

  it('neueres Ereignis mit kleinerem Stand dreht nichts zurück — gesenkt wird nur über den Ausfall, und nur einmal', async () => {
    const id = await rechnung();
    const intent = neueId('pi');
    const wertVorher = await kundenwert();
    assert.equal(await bezahlt(id, intent), 200);
    const s = sekunde();
    const rueckerstattungA = neueId('re');

    // A über 30, B über 20 — Stripe meldet kumuliert 30, dann 50.
    assert.equal(await erstattet(intent, 3_000, { created: s }), 200);
    assert.equal(await erstattet(intent, 5_000, { created: s + 30 }), 200);
    assert.deepEqual(await stand(id), { bezahlt: brutto.minus(50).toNumber(), offen: 50, status: 'PARTIALLY_PAID' });

    // A scheitert. Ein neueres `charge.refunded` meldet schon den gesenkten
    // Stand 20 — bevor das Ausfallereignis da ist. Es darf nicht senken.
    assert.equal(await erstattet(intent, 2_000, { created: s + 60 }), 200);
    assert.deepEqual(
      await stand(id),
      { bezahlt: brutto.minus(50).toNumber(), offen: 50, status: 'PARTIALLY_PAID' },
      'ein neueres charge.refunded mit kleinerem Stand hat zurückgedreht',
    );

    // Das Ausfallereignis senkt genau um A.
    assert.equal(await rueckerstattungGeaendert(intent, rueckerstattungA, 3_000, { type: 'refund.failed', erstellt: s, created: s + 61 }), 200);
    assert.deepEqual(await stand(id), { bezahlt: brutto.minus(20).toNumber(), offen: 20, status: 'PARTIALLY_PAID' }, 'die gültige Rückerstattung B ist verschwunden');
    const zahlung = await testDb()!.payment.findFirstOrThrow({ where: { invoiceId: id } });
    assert.equal(Number(zahlung.refundedAmount), 20);
    assert.equal(D(await kundenwert()).minus(D(wertVorher)).toNumber(), brutto.minus(20).toNumber());
  });

  it('Zahlung, Rückerstattung, Gutschrift — fester Endstand, und derselbe nach erneuter Zustellung aller Ereignisse', async () => {
    const id = await rechnung();
    const intent = neueId('pi');
    const wertVorher = await kundenwert();
    const zahlungsEreignis = neueId('evt');
    const erstattungsEreignis = neueId('evt');
    const s = sekunde();

    assert.equal(await bezahlt(id, intent, zahlungsEreignis), 200);
    assert.equal(await erstattet(intent, 3_000, { created: s, eventId: erstattungsEreignis }), 200);
    const gutschrift = await post(`/api/invoices/${id}/credit-note`, { reason: 'Kulanz Prüfreihe', name: 'Kulanz', unitPrice: 10, vatRate: 8.1 }, { jar: jars.admin });
    assert.equal(gutschrift.status, 201, gutschrift.text);

    // 108.10 − Gutschrift 10.81 (10 + 8.1 % MWST) − (108.10 − 30) = 19.19 offen.
    const gutschriftBrutto = D(10).times(D('1.081'));
    const bezahltErwartet = brutto.minus(30);
    const offenErwartet = brutto.minus(gutschriftBrutto).minus(bezahltErwartet);
    const endstand = { bezahlt: bezahltErwartet.toNumber(), offen: offenErwartet.toNumber(), status: 'PARTIALLY_PAID' };
    assert.deepEqual(await stand(id), endstand);
    const wertNachher = await kundenwert();

    // Alles noch einmal: dieselben Ereignisse, dazu die Erstattung mit neuer Kennung.
    assert.equal(await bezahlt(id, intent, zahlungsEreignis), 200);
    assert.equal(await erstattet(intent, 3_000, { created: s, eventId: erstattungsEreignis }), 200);
    assert.equal(await erstattet(intent, 3_000, { created: s }), 200);
    assert.deepEqual(await stand(id), endstand, 'die erneute Zustellung hat den Stand bewegt');
    assert.equal(await kundenwert(), wertNachher, 'die erneute Zustellung hat den Kundenwert bewegt');
    assert.equal(await testDb()!.payment.count({ where: { invoiceId: id, providerPaymentId: { not: null } } }), 1);
    assert.equal(D(wertNachher).minus(D(wertVorher)).toNumber(), bezahltErwartet.toNumber());
  });
});

/**
 * Storno gegen Zahlung, gleichzeitig (2026-09-27, Befund N-05).
 *
 * Der Code ist seit `66a5de5` behoben — Zahlung und Rechnungsstorno sperren
 * dieselbe Rechnungszeile, der Zahlungsstorno ist ein bedingter Übergang —,
 * aber nichts bewies es. Die Anfragen gehen hier ohne Wartezeit dazwischen
 * hinaus (`Promise.all`), und geprüft wird danach der Bestand, nicht nur die
 * Statuscodes: Ein Wettlauf, der zweimal abzieht und beiden Anfragen ein 204
 * schickt, sähe an den Codes gesund aus.
 *
 * Welche Seite im zweiten Fall gewinnt, entscheidet der Zufall; geprüft wird
 * deshalb nicht der Gewinner, sondern dass es genau einen gibt und der
 * Endstand zu ihm passt. Mehrere Runden, damit beide Ausgänge vorkommen
 * können.
 */
describe('Storno und Zahlung gleichzeitig (N-05)', () => {
  it('fünf gleichzeitige Stornos derselben Büro-Zahlung — genau ein 204, Kundenwert einmal gesenkt, eine Protokollzeile', async () => {
    const id = await rechnung();
    const db = testDb()!;
    const erfasst = await post(`/api/invoices/${id}/payments`, { amount: 50, method: 'BANK_TRANSFER' }, { jar: jars.admin });
    assert.equal(erfasst.status, 201, erfasst.text);
    const zahlung = await db.payment.findFirstOrThrow({ where: { invoiceId: id } });
    const wertVorher = await kundenwert();

    resetRateLimits();
    const antworten = await Promise.all(Array.from({ length: 5 }, () => del(`/api/payments/${zahlung.id}`, { jar: jars.admin })));
    const codes = antworten.map((a) => a.status);

    assert.equal(codes.filter((c) => c === 204).length, 1, `genau ein Storno wirkt: ${codes.join(', ')}`);
    assert.deepEqual(codes.filter((c) => c !== 204), [422, 422, 422, 422], `die übrigen hören „bereits storniert": ${codes.join(', ')}`);
    assert.equal(rund((await kundenwert()) - wertVorher), -50, 'der Kundenwert sinkt genau einmal');
    assert.equal(
      await db.auditLog.count({ where: { entity: 'Payment', entityId: zahlung.id, action: 'DELETE' } }),
      1,
      'eine Protokollzeile zum Storno',
    );
    assert.equal((await db.payment.findUniqueOrThrow({ where: { id: zahlung.id } })).status, 'CANCELLED');
    const s = await stand(id);
    assert.equal(s.bezahlt, 0);
    assert.equal(s.offen, BRUTTO);
    assert.ok(['ISSUED', 'SENT'].includes(s.status), `Status nach dem Storno: ${s.status}`);
  });

  it('Büro-Zahlung und Rechnungsstorno gleichzeitig — nie beides, und der Saldo passt zum Gewinner', async () => {
    const db = testDb()!;
    for (let runde = 0; runde < 4; runde++) {
      const id = await rechnung();
      resetRateLimits();
      const [zahlung, storno] = await Promise.all([
        post(`/api/invoices/${id}/payments`, { amount: BRUTTO, method: 'BANK_TRANSFER' }, { jar: jars.admin }),
        post(`/api/invoices/${id}/cancel`, { reason: `${MARKE}: Wettlauf Runde ${runde + 1}` }, { jar: jars.admin }),
      ]);
      const zahlungGewann = zahlung.status === 201;
      const stornoGewann = storno.status === 200;
      assert.ok(zahlungGewann !== stornoGewann, `Runde ${runde + 1}: genau einer gewinnt (Zahlung ${zahlung.status}, Storno ${storno.status})`);
      assert.equal((zahlungGewann ? storno : zahlung).status, 422, `Runde ${runde + 1}: der Verlierer wird als unmöglich abgewiesen`);

      const r = await db.invoice.findUniqueOrThrow({ where: { id }, select: { status: true, paidAmount: true, balance: true } });
      const zahlungen = await db.payment.findMany({ where: { invoiceId: id }, select: { amount: true, refundedAmount: true, status: true } });
      const eingegangen = zahlungen
        .filter((z) => ['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(z.status))
        .reduce((summe, z) => summe + Number(z.amount) - Number(z.refundedAmount), 0);
      assert.equal(Number(r.paidAmount), rund(eingegangen), `Runde ${runde + 1}: bezahlter Betrag = Summe der Zahlungen`);

      if (zahlungGewann) {
        assert.equal(zahlungen.length, 1);
        assert.deepEqual({ status: r.status, bezahlt: Number(r.paidAmount), offen: Number(r.balance) }, { status: 'PAID', bezahlt: BRUTTO, offen: 0 });
      } else {
        assert.equal(zahlungen.length, 0, `Runde ${runde + 1}: Geld auf einer stornierten Rechnung`);
        assert.deepEqual({ status: r.status, bezahlt: Number(r.paidAmount), offen: Number(r.balance) }, { status: 'CANCELLED', bezahlt: 0, offen: 0 });
      }
    }
  });
});

/**
 * Falscher Bezug (2026-09-27, Testmatrix `zahlung.falscherBezug`).
 *
 * Die Signaturprüfung beweist nur, dass Stripe die Meldung geschickt hat —
 * nicht, dass sie zu der Rechnung passt, die in ihren Metadaten steht. Drei
 * Abweichungen, drei Regeln (Begründung in `recordPayment` und im
 * `checkout.session.completed`-Zweig des Webhooks):
 *
 *  • **Rechnung einer fremden Organisation:** nicht gefunden, nichts gebucht,
 *    auch die Zahlungsabsicht nicht vermerkt. Der Zustand ist dauerhaft; das
 *    Ereignis wird vermerkt, dem Büro gemeldet und mit 200 beantwortet statt
 *    drei Tage lang mit 404 in Stripes Wiederholung zu laufen.
 *  • **Andere Währung als die Rechnung:** nicht gebucht. EUR 108.10 sind
 *    nicht CHF 108.10; vorher stand die Rechnung danach als „bezahlt" da.
 *  • **Anderer Betrag als der offene Saldo:** gebucht, was eingegangen ist —
 *    eingegangenes Geld wird nie verschwiegen —, aber nicht mehr still:
 *    Hinweis an der Zahlung, Vermerk im Protokoll, Meldung ans Büro.
 */
describe('Falscher Bezug: Rechnung, Währung und Betrag müssen passen', () => {
  const TITEL_NICHT_ZUGEORDNET = 'Online-Zahlung nicht zugeordnet';
  const TITEL_ABWEICHEND = 'Zahlung mit abweichendem Betrag';
  let fremdeRechnung = '';
  let fremdeKundschaft = '';

  /** Eine vollständige Checkout-Session — mit Währung, wie Stripe sie immer mitschickt. */
  function session(invoiceId: string, intent: string, opts: { eventId?: string; sessionId?: string; betragRappen?: number; waehrung?: string } = {}) {
    return zustellen({
      id: opts.eventId ?? neueId('evt'),
      type: 'checkout.session.completed',
      object: {
        id: opts.sessionId ?? neueId('cs'),
        object: 'checkout.session',
        payment_status: 'paid',
        payment_intent: intent,
        amount_total: opts.betragRappen ?? BRUTTO_RAPPEN,
        currency: opts.waehrung ?? 'chf',
        client_reference_id: invoiceId,
        metadata: { invoiceId, method: 'CARD' },
      },
    });
  }

  const meldungen = (titel: string, enthaelt: string) =>
    testDb()!.notification.count({ where: { title: titel, body: { contains: enthaelt } } });

  /** Nur Meldungen, die diese Reihe ausgelöst hat: Stripe-Kennungen mit `_pruef_` bzw. Rechnungen mit der Marke. */
  async function meldungenAufraeumen() {
    const db = testDb();
    if (!db) return;
    const eigene = await db.invoice.findMany({ where: { notes: { contains: MARKE } }, select: { id: true } });
    await db.notification.deleteMany({
      where: {
        OR: [
          { title: TITEL_NICHT_ZUGEORDNET, body: { contains: '_pruef_' } },
          { title: TITEL_ABWEICHEND, link: { in: eigene.map((r) => `/admin/rechnungen/${r.id}`) } },
        ],
      },
    });
  }

  before(async () => {
    const db = testDb()!;
    const org = await fremdeOrganisation();
    assert.ok(org, 'fremde Organisation nicht angelegt');
    fremdeKundschaft = (
      await db.customer.create({
        data: { organizationId: org, number: `K-ZB-FREMD-${RUN}`, firstName: 'Fremd', lastName: 'Zahlungsbuch', email: `zahlungsbuch.fremd.${RUN}@example.ch` },
      })
    ).id;
    // Die fremde Rechnung trägt die Marke dieser Reihe in `notes` — `aufraeumen()`
    // entfernt sie damit zusammen mit den eigenen.
    fremdeRechnung = (
      await db.invoice.create({
        data: {
          organizationId: org,
          number: `RE-ZB-FREMD-${RUN}`,
          customerId: fremdeKundschaft,
          status: 'SENT',
          sentAt: new Date(),
          issueDate: new Date(),
          dueDate: new Date(Date.now() + 30 * 86_400_000),
          grossTotal: BRUTTO,
          balance: BRUTTO,
          notes: MARKE,
          billToName: 'Fremde Empfängerin',
          billToStreet: 'Fremdweg 1',
          billToZip: '3000',
          billToCity: 'Bern',
        },
      })
    ).id;
  });

  after(async () => {
    const db = testDb();
    if (!db) return;
    await meldungenAufraeumen();
    // Die fremde Kundschaft hängt an der fremden Rechnung; beide hier, in
    // dieser Reihenfolge, weil das dateiweite `aufraeumen()` erst danach läuft.
    await schutzfreiAufraeumen(async (tx) => {
      await tx.payment.deleteMany({ where: { invoiceId: fremdeRechnung } });
      await tx.invoice.deleteMany({ where: { id: fremdeRechnung } });
    });
    if (fremdeKundschaft) await db.customer.deleteMany({ where: { id: fremdeKundschaft } });
  });

  it('eine korrekt signierte Zahlung auf die Rechnung einer fremden Organisation bucht nichts, wird vermerkt, gemeldet und nicht endlos wiederholt', async () => {
    const db = testDb()!;
    const intent = neueId('pi');
    const ereignis = neueId('evt');
    const sitzung = neueId('cs');

    assert.equal(await session(fremdeRechnung, intent, { eventId: ereignis, sessionId: sitzung }), 200, 'dauerhafter Zustand — Stripe soll nicht tagelang wiederholen');
    assert.equal(await session(fremdeRechnung, intent, { eventId: ereignis, sessionId: sitzung }), 200, 'die Wiederholung ebenso');

    assert.equal(await db.payment.count({ where: { invoiceId: fremdeRechnung } }), 0, 'Zahlung auf fremde Rechnung gebucht');
    assert.equal(await db.payment.count({ where: { providerPaymentId: intent } }), 0, 'Zahlung irgendwo gebucht');
    const fremd = await db.invoice.findUniqueOrThrow({ where: { id: fremdeRechnung }, select: { paidAmount: true, balance: true, status: true, stripePaymentIntentId: true } });
    assert.deepEqual(
      { bezahlt: Number(fremd.paidAmount), offen: Number(fremd.balance), status: fremd.status, intent: fremd.stripePaymentIntentId },
      { bezahlt: 0, offen: BRUTTO, status: 'SENT', intent: null },
      'die fremde Rechnung wurde angefasst',
    );
    assert.equal(await db.providerWebhookEvent.count({ where: { eventId: ereignis } }), 1, 'das Ereignis ist nicht als behandelt vermerkt');
    const gemeldet = await meldungen(TITEL_NICHT_ZUGEORDNET, sitzung);
    assert.ok(gemeldet > 0, 'das Büro erfährt nichts von Geld ohne Rechnung');
    // Die Meldung verrät nichts über die fremde Rechnung — nur, was Stripe schickte.
    const text = await db.notification.findFirstOrThrow({ where: { title: TITEL_NICHT_ZUGEORDNET, body: { contains: sitzung } }, select: { body: true, link: true } });
    assert.ok(!text.body.includes(`RE-ZB-FREMD-${RUN}`), 'die Meldung nennt die fremde Rechnungsnummer');
    assert.equal(text.link, null);

    // Eine dritte Zustellung meldet nicht noch einmal.
    assert.equal(await session(fremdeRechnung, intent, { eventId: ereignis, sessionId: sitzung }), 200);
    assert.equal(await meldungen(TITEL_NICHT_ZUGEORDNET, sitzung), gemeldet, 'jede Wiederholung meldet erneut');
  });

  it('eine Zahlung in EUR auf eine CHF-Rechnung wird nicht als CHF gebucht — Rechnung bleibt offen, Ereignis vermerkt, Büro gemeldet', async () => {
    const db = testDb()!;
    const id = await rechnung();
    const intent = neueId('pi');
    const ereignis = neueId('evt');
    const sitzung = neueId('cs');

    assert.equal(await session(id, intent, { eventId: ereignis, sessionId: sitzung, waehrung: 'eur' }), 200);
    assert.equal(await db.payment.count({ where: { invoiceId: id } }), 0, 'EUR als CHF gebucht');
    assert.deepEqual(await stand(id), { bezahlt: 0, offen: BRUTTO, status: 'ISSUED' });
    assert.equal(await db.auditLog.count({ where: { entity: 'Invoice', entityId: id, action: 'PAYMENT' } }), 0);
    assert.equal(await db.providerWebhookEvent.count({ where: { eventId: ereignis } }), 1);
    assert.ok((await meldungen(TITEL_NICHT_ZUGEORDNET, sitzung)) > 0, 'das Büro erfährt nichts von der Zahlung in fremder Währung');

    // Gegenprobe: Dieselbe Rechnung, in CHF bezahlt, bucht regulär und ohne Hinweis.
    assert.equal(await session(id, neueId('pi'), { waehrung: 'chf' }), 200);
    assert.deepEqual(await stand(id), { bezahlt: BRUTTO, offen: 0, status: 'PAID' });
    const zahlung = await db.payment.findFirstOrThrow({ where: { invoiceId: id } });
    assert.equal(zahlung.currency, 'CHF');
    assert.doesNotMatch(zahlung.note ?? '', /weicht/);
  });

  it('ein Betrag, der nicht zum offenen Saldo passt, wird gebucht wie eingegangen — aber markiert, protokolliert und gemeldet, nicht still', async () => {
    const db = testDb()!;
    const id = await rechnung();
    const nummer = (await db.invoice.findUniqueOrThrow({ where: { id }, select: { number: true } })).number;
    const intent = neueId('pi');
    const ereignis = neueId('evt');

    // CHF 200 auf offene CHF 108.10 — eine Überzahlung von 91.90.
    assert.equal(await session(id, intent, { eventId: ereignis, betragRappen: 20_000 }), 200);
    assert.equal(await session(id, intent, { eventId: ereignis, betragRappen: 20_000 }), 200, 'die Wiederholung bucht nicht doppelt');

    const zahlungen = await db.payment.findMany({ where: { invoiceId: id } });
    assert.equal(zahlungen.length, 1, 'eingegangenes Geld ist gebucht — genau einmal');
    assert.equal(Number(zahlungen[0]!.amount), 200, 'gebucht wird, was eingegangen ist, nicht der Rechnungsbetrag');
    assert.match(zahlungen[0]!.note ?? '', /weicht vom offenen Saldo ab/, 'die Zahlung trägt keinen Hinweis auf die Abweichung');

    // Der offene Posten fällt nie unter 0 — die Regel von `saldoNeuBilden`
    // (`max0`), auf die Mahnlauf und Kennzahlen mit `balance > 0` bauen. Die
    // Überzahlung steht im bezahlten Betrag, über dem Rechnungsbetrag, und in
    // Hinweis, Protokoll und Meldung (unten) — sichtbar, nur nicht als
    // negativer Saldo.
    const s = await stand(id);
    assert.equal(s.bezahlt, 200);
    assert.ok(s.bezahlt > BRUTTO, 'die Überzahlung ist im bezahlten Betrag nicht sichtbar');
    assert.equal(rund(s.offen), 0, 'der offene Posten fällt unter 0');

    const protokoll = await db.auditLog.findMany({ where: { entity: 'Invoice', entityId: id, action: 'PAYMENT' }, select: { summary: true } });
    assert.equal(protokoll.length, 1);
    assert.match(protokoll[0]!.summary ?? '', /weicht vom offenen Saldo/);

    const gemeldet = await meldungen(TITEL_ABWEICHEND, nummer);
    assert.ok(gemeldet > 0, 'das Büro erfährt nichts von der Überzahlung');
    assert.equal(await session(id, intent, { eventId: neueId('evt'), betragRappen: 20_000 }), 200, 'dieselbe Zahlung unter neuer Ereigniskennung');
    assert.equal(await meldungen(TITEL_ABWEICHEND, nummer), gemeldet, 'eine erneute Zustellung meldet erneut');
  });
});
