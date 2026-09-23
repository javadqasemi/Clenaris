import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { BASE_URL, data, del, get, post, requireServer } from '../helpers/client';
import { loginAll, type AccountName } from '../helpers/accounts';
import { schutzfreiAufraeumen, testDb, testDbGrund, testDbSchliessen } from '../helpers/testdb';

/**
 * Wave 13 — Finanzbelege: Unveränderlichkeit in der Datenbank, Storno statt
 * Löschen, Gutschriften mit Obergrenze, lückenlose Nummern.
 *
 * Bis hierher stand „eine ausgestellte Rechnung wird nie geändert" nur im
 * Dienst. Diese Reihe prüft beides: den Weg über HTTP (der die Regeln
 * einhält) und den direkten Griff in die Datenbank (den die Trigger
 * verweigern).
 *
 * Die angelegten Belege tragen die Notiz „Prüfreihe Finanzbelege" und werden
 * vorher und nachher an den Triggern vorbei entfernt — die Anwendung und die
 * Datenbank lassen es zu Recht nicht zu. Die Kaskaden greifen unter
 * `replica` nicht; Positionen, Zahlungen und Gutschriften werden deshalb
 * ausdrücklich gelöscht.
 */

let jars: Record<AccountName, string>;
const MARKE = 'Prüfreihe Finanzbelege';
let kundeId = '';
let andereKundeId = '';

async function aufraeumen() {
  const db = testDb();
  if (!db) return;
  const rechnungen = await db.invoice.findMany({ where: { notes: { contains: MARKE } }, select: { id: true } });
  const ids = rechnungen.map((r) => r.id);
  if (ids.length === 0) return;
  const zahlungen = await db.payment.findMany({ where: { invoiceId: { in: ids } }, select: { amount: true, status: true } });
  await schutzfreiAufraeumen(async (tx) => {
    await tx.payment.deleteMany({ where: { invoiceId: { in: ids } } });
    await tx.creditNote.deleteMany({ where: { invoiceId: { in: ids } } });
    await tx.paymentReminder.deleteMany({ where: { invoiceId: { in: ids } } });
    await tx.invoiceItem.deleteMany({ where: { invoiceId: { in: ids } } });
    await tx.invoice.deleteMany({ where: { id: { in: ids } } });
  });
  // Eine nicht stornierte Zahlung aus einem abgebrochenen Lauf hat den Kundenwert erhöht.
  const offen = zahlungen.filter((z) => z.status === 'SUCCEEDED').reduce((s, z) => s + Number(z.amount), 0);
  if (offen > 0 && kundeId) await db.customer.update({ where: { id: kundeId }, data: { lifetimeValue: { decrement: offen } } });
}

async function rechnung(ausstellen: boolean, kunde = kundeId) {
  const antwort = await post<{ data: { id: string; number: string; status: string; grossTotal: string } }>(
    '/api/invoices',
    {
      customerId: kunde,
      notes: MARKE,
      items: [{ name: 'Unterhaltsreinigung', quantity: 2, unit: 'Std.', unitPrice: 50, vatRate: 8.1 }],
      issueImmediately: ausstellen,
    },
    { jar: jars.admin },
  );
  assert.equal(antwort.status, 201, JSON.stringify(antwort.payload));
  return data(antwort);
}

before(async () => {
  await requireServer();
  jars = await loginAll();
  assert.ok(testDb(), `kein Zugang zur Testdatenbank: ${testDbGrund()}`);
  const kunden = data(await get<{ data: { id: string }[] }>('/api/customers?pageSize=5', { jar: jars.admin }));
  kundeId = kunden[0]!.id;
  andereKundeId = kunden[1]!.id;
  await aufraeumen();
});

after(async () => {
  await aufraeumen();
  await testDbSchliessen();
});

describe('Ausgestellte Rechnungen sind in der Datenbank unveränderlich', () => {
  let ausgestellt: { id: string; number: string };

  it('lückenlose Nummern: zwei ausgestellte Rechnungen folgen unmittelbar aufeinander', async () => {
    const a = await rechnung(true);
    const b = await rechnung(true);
    assert.equal(a.status, 'ISSUED');
    const lauf = (n: string) => Number(n.split('-').at(-1));
    assert.equal(lauf(b.number), lauf(a.number) + 1, `${a.number} → ${b.number}`);
    ausgestellt = a;
  });

  it('Betrag, Empfänger und Nummer lassen sich nicht ändern', async () => {
    const db = testDb()!;
    await assert.rejects(db.invoice.update({ where: { id: ausgestellt.id }, data: { grossTotal: 1 } }), /unveränderlich/);
    await assert.rejects(db.invoice.update({ where: { id: ausgestellt.id }, data: { billToName: 'Jemand anders' } }), /unveränderlich/);
    await assert.rejects(db.invoice.update({ where: { id: ausgestellt.id }, data: { number: 'RE-0000-00000' } }), /unveränderlich/);
    await assert.rejects(db.invoice.update({ where: { id: ausgestellt.id }, data: { status: 'DRAFT' } }), /Entwurf/);
  });

  it('löschen — auch weich — ist ausgeschlossen', async () => {
    const db = testDb()!;
    await assert.rejects(db.invoice.delete({ where: { id: ausgestellt.id } }), /nicht gelöscht/);
    await assert.rejects(db.invoice.update({ where: { id: ausgestellt.id }, data: { deletedAt: new Date() } }), /nicht gelöscht/);
    const antwort = await del(`/api/invoices/${ausgestellt.id}`, { jar: jars.admin });
    assert.ok([409, 422].includes(antwort.status), `über HTTP abgewiesen (kam ${antwort.status})`);
  });

  it('die Positionen sind gesperrt, der Lebenslauf nicht', async () => {
    const db = testDb()!;
    const position = await db.invoiceItem.findFirst({ where: { invoiceId: ausgestellt.id }, select: { id: true } });
    await assert.rejects(db.invoiceItem.update({ where: { id: position!.id }, data: { unitPrice: 1 } }), /unveränderlich/);
    await assert.rejects(db.invoiceItem.delete({ where: { id: position!.id } }), /unveränderlich/);
    await assert.rejects(
      db.invoiceItem.create({ data: { invoiceId: ausgestellt.id, name: 'nachgeschoben', unitPrice: 1, netAmount: 1, vatAmount: 0, lineTotal: 1 } }),
      /unveränderlich/,
    );
    // Lebenslauf: Versand, Ansicht, interne Notiz bleiben änderbar.
    await db.invoice.update({ where: { id: ausgestellt.id }, data: { viewedAt: new Date(), notes: `${MARKE} — angesehen` } });
  });

  it('ein Entwurf bleibt frei bearbeitbar', async () => {
    const entwurf = await rechnung(false);
    const db = testDb()!;
    await db.invoice.update({ where: { id: entwurf.id }, data: { introText: 'Geändert' } });
    const position = await db.invoiceItem.findFirst({ where: { invoiceId: entwurf.id }, select: { id: true } });
    await db.invoiceItem.update({ where: { id: position!.id }, data: { description: 'frei' } });
  });
});

describe('Zahlungen: Storno statt Löschen', () => {
  let rechnungId = '';
  let zahlungId = '';

  it('eine verbuchte Zahlung behält Betrag und wird nicht gelöscht', async () => {
    const r = await rechnung(true);
    rechnungId = r.id;
    const z = await post('/api/invoices/' + r.id + '/payments', { amount: 50, reference: MARKE }, { jar: jars.admin });
    assert.ok([200, 201].includes(z.status), JSON.stringify(z.payload));
    const db = testDb()!;
    const zeile = await db.payment.findFirst({ where: { invoiceId: r.id }, select: { id: true } });
    zahlungId = zeile!.id;
    await assert.rejects(db.payment.update({ where: { id: zahlungId }, data: { amount: 999 } }), /behält Betrag/);
    await assert.rejects(db.payment.delete({ where: { id: zahlungId } }), /nicht gelöscht/);
  });

  it('der Storno lässt die Zeile stehen und setzt Saldo, bezahlten Betrag und Kundenwert zurück', async () => {
    const db = testDb()!;
    const wertVorher = Number((await db.customer.findUnique({ where: { id: kundeId }, select: { lifetimeValue: true } }))!.lifetimeValue);
    const storno = await del(`/api/payments/${zahlungId}`, { jar: jars.admin });
    assert.equal(storno.status, 204, storno.text);
    const zeile = await db.payment.findUnique({ where: { id: zahlungId }, select: { status: true } });
    assert.equal(zeile?.status, 'CANCELLED', 'die Zahlung bleibt als Beleg');
    const r = await db.invoice.findUnique({ where: { id: rechnungId }, select: { balance: true, paidAmount: true, grossTotal: true, status: true } });
    assert.equal(Number(r!.balance), Number(r!.grossTotal));
    assert.equal(Number(r!.paidAmount), 0);
    // Zurück auf den Stand vor dem Geld. Die Rechnung wurde ausgestellt, aber
    // nie versendet — bis Wave 24 hiess es hier pauschal `SENT`.
    assert.equal(r!.status, 'ISSUED');
    const wertNachher = Number((await db.customer.findUnique({ where: { id: kundeId }, select: { lifetimeValue: true } }))!.lifetimeValue);
    assert.equal(Math.round((wertVorher - wertNachher) * 100) / 100, 50);
    assert.equal((await del(`/api/payments/${zahlungId}`, { jar: jars.admin })).status, 422, 'ein zweiter Storno');
    await assert.rejects(db.payment.update({ where: { id: zahlungId }, data: { status: 'SUCCEEDED' } }), /wiederbelebt/);
  });
});

describe('Gutschriften', () => {
  let rechnungId = '';
  let gross = 0;

  it('Storno einer teilweise bezahlten Rechnung verweist auf die Gutschrift — und die lässt sich jetzt erstellen', async () => {
    const r = await rechnung(true);
    rechnungId = r.id;
    // Die Summen stehen nach dem Anlegen in der Datenbank, nicht zwingend in der Antwort.
    gross = Number((await testDb()!.invoice.findUnique({ where: { id: r.id }, select: { grossTotal: true } }))!.grossTotal);
    assert.equal(gross, 108.1, '2 × 50 + 8,1 % MWST');
    await post('/api/invoices/' + r.id + '/payments', { amount: 20, reference: MARKE }, { jar: jars.admin });
    const storno = await post(`/api/invoices/${r.id}/cancel`, { reason: 'Prüfreihe' }, { jar: jars.admin });
    assert.equal(storno.status, 422);
    assert.ok(storno.text.includes('Gutschrift'));

    const g = await post<{ data: { id: string; number: string; grossTotal: string } }>(
      `/api/invoices/${r.id}/credit-note`,
      { reason: 'Einsatz verspätet', name: 'Kulanz', unitPrice: 30, vatRate: 8.1 },
      { jar: jars.admin },
    );
    assert.equal(g.status, 201, JSON.stringify(g.payload));
    assert.equal(Number(data(g).grossTotal), 32.43);
    const db = testDb()!;
    const nach = await db.invoice.findUnique({ where: { id: r.id }, select: { balance: true } });
    assert.equal(Number(nach!.balance), Math.round((gross - 20 - 32.43) * 100) / 100, 'der offene Posten sinkt um die Gutschrift');
    const pdf = await fetch(`${BASE_URL}/api/credit-notes/${data(g).id}/pdf`, { headers: { cookie: jars.admin } });
    assert.equal(pdf.status, 200);
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
    await assert.rejects(db.creditNote.update({ where: { id: data(g).id }, data: { grossTotal: 1 } }), /unveränderlich/);
    await assert.rejects(db.creditNote.delete({ where: { id: data(g).id } }), /nicht gelöscht/);
  });

  /**
   * Wave 24: Verbuchen und Storno rechneten den Saldo als `Brutto − bezahlt`
   * und vergassen die Gutschrift. Wer nach der Gutschrift den Rest bezahlte,
   * behielt einen offenen Posten in Höhe der Gutschrift und wurde gemahnt.
   */
  it('Rest nach einer Gutschrift bezahlen ergibt „bezahlt", der Storno danach berücksichtigt die Gutschrift', async () => {
    const db = testDb()!;
    const rest = Math.round((gross - 20 - 32.43) * 100) / 100;
    const zahlung = await post('/api/invoices/' + rechnungId + '/payments', { amount: rest, reference: MARKE }, { jar: jars.admin });
    assert.ok([200, 201].includes(zahlung.status), JSON.stringify(zahlung.payload));
    const bezahlt = await db.invoice.findUniqueOrThrow({ where: { id: rechnungId }, select: { balance: true, paidAmount: true, status: true } });
    assert.equal(Number(bezahlt.balance), 0, 'kein Saldo in Höhe der Gutschrift');
    assert.equal(bezahlt.status, 'PAID');
    assert.equal(Number(bezahlt.paidAmount), Math.round((20 + rest) * 100) / 100);

    const letzte = await db.payment.findFirstOrThrow({ where: { invoiceId: rechnungId, status: 'SUCCEEDED' }, orderBy: { createdAt: 'desc' }, select: { id: true } });
    assert.equal((await del(`/api/payments/${letzte.id}`, { jar: jars.admin })).status, 204);
    const zurueck = await db.invoice.findUniqueOrThrow({ where: { id: rechnungId }, select: { balance: true, paidAmount: true, status: true } });
    assert.equal(Number(zurueck.balance), rest, 'offen ist der Rest, nicht Rest plus Gutschrift');
    assert.equal(Number(zurueck.paidAmount), 20);
    assert.equal(zurueck.status, 'PARTIALLY_PAID');
  });

  it('nie mehr gutschreiben, als die Rechnung betrug', async () => {
    const zuviel = await post(`/api/invoices/${rechnungId}/credit-note`, { reason: 'zu viel', name: 'Zu viel', unitPrice: gross, vatRate: 8.1 }, { jar: jars.admin });
    assert.equal(zuviel.status, 422);
    assert.ok(zuviel.text.includes('chstens noch CHF'), zuviel.text);
  });

  it('nicht auf Entwürfe, nicht an eine fremde Kundschaft', async () => {
    const entwurf = await rechnung(false);
    const aufEntwurf = await post(`/api/invoices/${entwurf.id}/credit-note`, { reason: 'Entwurf', name: 'Kulanz', unitPrice: 1 }, { jar: jars.admin });
    assert.equal(aufEntwurf.status, 422);
    assert.ok(aufEntwurf.text.includes('ausgestellte'), aufEntwurf.text);
    const fremd = await post(
      '/api/credit-notes',
      { customerId: andereKundeId, invoiceId: rechnungId, reason: 'falsche Kundschaft', items: [{ name: 'Kulanz', unitPrice: 1 }] },
      { jar: jars.admin },
    );
    assert.equal(fremd.status, 422);
    assert.ok(fremd.text.includes('Kundschaft der Rechnung'), fremd.text);
  });

  it('Rollen: Betriebsleitung ja, Mitarbeitende und Kundschaft nein', async () => {
    assert.equal((await get('/api/credit-notes', { jar: jars.manager })).status, 200);
    for (const rolle of ['employee', 'customer'] as AccountName[]) {
      assert.equal((await get('/api/credit-notes', { jar: jars[rolle] })).status, 403, rolle);
    }
  });
});
