import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import Stripe from 'stripe';
import { PDFDocument, StandardFonts } from 'pdf-lib';

import { BASE_URL, call, data, del, get, patch, post, put, requireServer, type ApiResponse } from '../helpers/client';
import { loginAll, type AccountName } from '../helpers/accounts';
import { rateLimitResetAvailable, resetRateLimits } from '../helpers/rate-limit';
import { eigeneOrganisationId, schutzfreiAufraeumen, testDb, testDbGrund, testDbSchliessen } from '../helpers/testdb';
import { PRUEF_STRIPE_GEHEIMNIS } from '../helpers/webhooks';

/**
 * Nebenläufigkeit — höchstens eine Wirkung, auch wenn derselbe Vorgang
 * mehrfach gleichzeitig eintrifft.
 *
 * ---------------------------------------------------------------------------
 *  Warum eine eigene Datei
 * ---------------------------------------------------------------------------
 *
 * Die Fachreihen prüfen ihre Regeln **nacheinander**: erste Erfassung 201,
 * zweite 422. Das beweist, dass die Regel existiert — nicht, dass sie hält,
 * wenn beide Anfragen im selben Augenblick ankommen. Genau dort liegt der
 * typische Fehler dieser Codebasis, und er ist schon mehrmals aufgetreten
 * (Rechnungsausstellung, Zuteilung, Offertannahme): lesen, entscheiden,
 * später schreiben — und zwei Anfragen lesen beide „frei".
 *
 * Doppelklicks, eine Wiederholung durch den Browser nach einem Zeitlimit,
 * zwei Personen im Büro vor derselben Akte, Stripe, das ein Ereignis erneut
 * zustellt, zwei Scheduler, die sich überlappen: Das ist kein
 * Ausnahmefall, sondern Alltag. Jede Prüfung hier schickt deshalb mehrere
 * Anfragen **ohne Wartezeit dazwischen** (`Promise.all`) und prüft danach den
 * Bestand — nicht die Statuscodes allein, denn ein Wettlauf, der zwei
 * Datensätze erzeugt und beiden ein 201 schickt, sähe an den Codes gesund aus.
 *
 * ---------------------------------------------------------------------------
 *  Woher die Erwartungen kommen
 * ---------------------------------------------------------------------------
 *
 * Aus der **Geschäftsregel**, nicht aus dem heutigen Verhalten. Wo der Dienst
 * für einen Wettlauf keine Vorkehrung trifft (keine Zeilensperre, kein
 * eindeutiger Index, keine Transaktionssperre), steht hier trotzdem die
 * richtige Erwartung — eine Prüfung, die das heutige Verhalten festschriebe,
 * wäre die Dokumentation eines Fehlers. Wo das Produkt eine Zusage **nicht**
 * macht (eine doppelt abgeschickte Buchung zum Beispiel), wird auch keine
 * erfunden; siehe den Block „Öffentliche Formulare".
 *
 * Ein Wettlauf ohne Vorkehrung tritt nicht bei jedem Lauf auf. Wo es darauf
 * ankommt, wird deshalb mehrfach oder mit mehr als zwei Anfragen gefahren —
 * mit Vorkehrung muss **jeder** Durchgang halten.
 *
 * ---------------------------------------------------------------------------
 *  Rate-Limits
 * ---------------------------------------------------------------------------
 *
 * Diese Datei schreibt in kurzer Zeit mehr als die 90 Schreibaufrufe je
 * Minute, die `apiWrite` der Verwaltung erlaubt. Ein 429 mitten in einer
 * gleichzeitigen Salve wäre doppelt schädlich: Der Klient wartet dann die
 * Fenstergrenze ab und schickt die Anfrage **allein** noch einmal — der
 * Wettlauf fände nicht mehr statt, und die Prüfung würde grün, ohne etwas
 * bewiesen zu haben. Deshalb leert `gleichzeitig()` die Zähler des
 * Testservers unmittelbar vor jeder Salve (`helpers/rate-limit.ts`).
 *
 * Die öffentlichen Formulare haben Stundenfenster (Kontakt 6, Newsletter 5).
 * Ein 429 dort hiesse eine Stunde warten; diese Aufrufe gehen deshalb ohne
 * Wiederholung hinaus, und ohne dateibasierten Zähler wird der Block
 * übersprungen statt eine Stunde zu blockieren.
 *
 * ---------------------------------------------------------------------------
 *  Aufräumen
 * ---------------------------------------------------------------------------
 *
 * Jeder Block räumt vor **und** nach sich auf, über feste Marken (nicht über
 * die Laufkennung — sonst fände das Aufräumen die Reste eines abgebrochenen
 * früheren Laufs nicht). Ausgestellte Belege werden wie in
 * `finanzbelege.test.ts` unter `replica` an den Unveränderlichkeitstriggern
 * vorbei entfernt; die Nummernlücke, die das in der Testdatenbank hinterlässt,
 * meldet `datenintegritaet.test.ts` bewusst nur als Hinweis.
 */

let jars: Record<AccountName, string>;
const RUN = Date.now().toString(36);

/** Wie viele Anfragen eine Salve umfasst, wo nichts anderes begründet ist. */
const SALVE = 6;

function db() {
  const verbindung = testDb();
  assert.ok(verbindung, `kein Zugang zur Testdatenbank: ${testDbGrund()}`);
  return verbindung;
}

/**
 * `n` Anfragen ohne jede Wartezeit dazwischen — und mit frischem
 * Rate-Limit-Kontingent, damit kein 429 die Salve in Einzelaufrufe zerlegt
 * (siehe Dateikopf).
 */
async function gleichzeitig<T>(n: number, anfrage: (index: number) => Promise<T>): Promise<T[]> {
  resetRateLimits();
  return Promise.all(Array.from({ length: n }, (_, index) => anfrage(index)));
}

const codes = (antworten: ApiResponse[]) => antworten.map((antwort) => antwort.status);
const anzahl = (antworten: ApiResponse[], status: number) => antworten.filter((antwort) => antwort.status === status).length;
const texte = (antworten: ApiResponse[]) => antworten.map((antwort) => `${antwort.status} ${antwort.text.slice(0, 160)}`).join(' | ');

/** Eine Salve darf nie als Serverfehler enden — ein 500 ist ein verlorener Klick ohne Begründung. */
function keinServerfehler(antworten: ApiResponse[], was: string): void {
  const fehler = antworten.filter((antwort) => antwort.status >= 500);
  assert.equal(fehler.length, 0, `${was}: ${fehler.length} Serverfehler — ${texte(fehler)}`);
}

const rund = (betrag: number) => Math.round(betrag * 100) / 100;

before(async () => {
  await requireServer();
  jars = await loginAll();
  db();
});

after(async () => {
  await testDbSchliessen();
});

// ===========================================================================
//  1. Zeiterfassung — überlappende Zeiten derselben Person
// ===========================================================================

/**
 * Die Regel aus `timetracking.service.ts`: keine Überschneidungen je Person,
 * weil zwei gleichzeitige Zeiten doppelten Lohn für dieselbe Stunde ergäben.
 * `zeiterfassung.test.ts` prüft sie nacheinander. Hier kommen sechs sich
 * überlappende Erfassungen im selben Augenblick — der Fall „zweimal auf
 * Speichern gedrückt" oder „zwei Personen im Büro erfassen dieselbe
 * vergessene Schicht".
 */
describe('Nebenläufigkeit — Zeiterfassung', () => {
  const MARKE = 'Prüfreihe Nebenläufigkeit Zeit';
  let employeeId = '';

  const aufraeumen = async () => {
    await db().timeEntry.deleteMany({ where: { note: MARKE } });
  };

  before(async () => {
    const liste = await get<{ data: { id: string }[] }>('/api/employees', { jar: jars.admin });
    assert.equal(liste.status, 200, liste.text);
    employeeId = data(liste)[0]?.id ?? '';
    assert.ok(employeeId, 'für diese Prüfung braucht es eine Personalakte im Bestand');
    await aufraeumen();
  });

  after(aufraeumen);

  it('sechs gleichzeitige, sich überlappende Erfassungen derselben Person — genau eine wird angenommen', async () => {
    // Weit in der Vergangenheit und an einem Tag, den `zeiterfassung.test.ts`
    // nicht belegt; um fünf Minuten versetzt, damit es wirklich
    // Überschneidungen sind und nicht bloss dieselbe Zeile sechsmal.
    const beginn = new Date();
    beginn.setUTCDate(beginn.getUTCDate() - 47);
    beginn.setUTCHours(5, 0, 0, 0);

    const antworten = await gleichzeitig(SALVE, (i) => {
      const start = new Date(beginn.getTime() + i * 5 * 60_000);
      const ende = new Date(start.getTime() + 2 * 3_600_000);
      return post<{ data: { id: string } }>(
        '/api/time',
        { employeeId, startedAt: start.toISOString(), endedAt: ende.toISOString(), breakMin: 0, note: MARKE },
        { jar: jars.admin },
      );
    });

    const eintraege = await db().timeEntry.findMany({
      where: { employeeId, note: MARKE },
      select: { id: true, startedAt: true, endedAt: true },
      orderBy: { startedAt: 'asc' },
    });

    // Zuerst der Bestand: Er ist, was in die Lohnabrechnung geht.
    assert.ok(
      eintraege.length <= 1,
      `${eintraege.length} sich überschneidende Zeiten derselben Person gespeichert — doppelter Lohn für dieselbe Stunde (${codes(antworten).join(', ')})`,
    );
    assert.equal(anzahl(antworten, 201), 1, `genau eine Erfassung soll gelingen: ${texte(antworten)}`);
    assert.equal(anzahl(antworten, 422), SALVE - 1, `die übrigen als Überschneidung abgewiesen: ${texte(antworten)}`);
  });
});

// ===========================================================================
//  Gemeinsame Belege: Rechnungen, Gutschriften, Stripe
// ===========================================================================

const MARKE_BELEG = 'Prüfreihe Nebenläufigkeit Belege';
const STRIPE_PRAEFIX = 'evt_nebenlaeufig_';

/**
 * Belege dieser Datei entfernen — an den Unveränderlichkeitstriggern vorbei,
 * wie `finanzbelege.test.ts` und `zahlungsbuch.test.ts`.
 *
 * Der Kundenwert wird **je Zahlung** zurückgenommen, über deren eigene
 * Kundenkennung: Zahlungen erhöhen `lifetimeValue`, und ein abgebrochener
 * Lauf hinterliesse sonst eine Demokundschaft mit erfundenem Umsatz.
 */
async function belegeAufraeumen(): Promise<void> {
  const verbindung = db();
  await verbindung.providerWebhookEvent.deleteMany({ where: { eventId: { startsWith: STRIPE_PRAEFIX } } });
  const rechnungen = await verbindung.invoice.findMany({ where: { notes: { contains: MARKE_BELEG } }, select: { id: true } });
  const ids = rechnungen.map((r) => r.id);
  if (ids.length === 0) return;
  const zahlungen = await verbindung.payment.findMany({
    where: { invoiceId: { in: ids } },
    select: { amount: true, refundedAmount: true, status: true, customerId: true },
  });
  await schutzfreiAufraeumen(async (tx) => {
    await tx.payment.deleteMany({ where: { invoiceId: { in: ids } } });
    await tx.creditNote.deleteMany({ where: { invoiceId: { in: ids } } });
    await tx.paymentReminder.deleteMany({ where: { invoiceId: { in: ids } } });
    await tx.invoiceItem.deleteMany({ where: { invoiceId: { in: ids } } });
    await tx.invoice.deleteMany({ where: { id: { in: ids } } });
  });
  const netto = new Map<string, number>();
  for (const z of zahlungen) {
    if (!z.customerId || !['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(z.status)) continue;
    netto.set(z.customerId, (netto.get(z.customerId) ?? 0) + Number(z.amount) - Number(z.refundedAmount));
  }
  for (const [customerId, betrag] of netto) {
    if (Math.abs(betrag) > 0.001) {
      await verbindung.customer.update({ where: { id: customerId }, data: { lifetimeValue: { decrement: rund(betrag) } } });
    }
  }
}

let belegKundeId = '';

async function belegKunde(): Promise<string> {
  if (belegKundeId) return belegKundeId;
  const kunden = await get<{ data: { id: string }[] }>('/api/customers?pageSize=1', { jar: jars.admin });
  belegKundeId = data(kunden)[0]?.id ?? '';
  assert.ok(belegKundeId, 'keine Kundschaft im Bestand');
  return belegKundeId;
}

/** 2 × 50 zu 8.1 % — brutto 108.10, wie in den Fachreihen. */
const BRUTTO = 108.1;
const BRUTTO_RAPPEN = 10_810;

async function rechnung(ausstellen: boolean): Promise<string> {
  const antwort = await post<{ data: { id: string } }>(
    '/api/invoices',
    {
      customerId: await belegKunde(),
      notes: MARKE_BELEG,
      items: [{ name: 'Unterhaltsreinigung', quantity: 2, unit: 'Std.', unitPrice: 50, vatRate: 8.1 }],
      issueImmediately: ausstellen,
    },
    { jar: jars.admin },
  );
  assert.equal(antwort.status, 201, antwort.text);
  return data(antwort).id;
}

// ===========================================================================
//  2. Gutschriften — nie mehr als der Rechnungsbetrag
// ===========================================================================

/**
 * Die Regel aus `createCreditNote`: Über alle Gutschriften hinweg wird nie
 * mehr gutgeschrieben, als die Rechnung betrug. Nacheinander prüft das
 * `finanzbelege.test.ts`. Gleichzeitig läsen zwei Gutschriften ohne
 * Vorkehrung beide denselben Rest und schrieben beide — und der Betrieb hätte
 * mehr Geld gutgeschrieben, als er je in Rechnung gestellt hat.
 */
describe('Nebenläufigkeit — Gutschriften', () => {
  before(belegeAufraeumen);
  after(belegeAufraeumen);

  const gutschrift = (rechnungId: string, nettoJeStueck: number) =>
    post<{ data: { id: string; grossTotal: string } }>(
      `/api/invoices/${rechnungId}/credit-note`,
      { reason: MARKE_BELEG, name: 'Kulanz', unitPrice: nettoJeStueck, vatRate: 8.1 },
      { jar: jars.admin },
    );

  async function summeUndSaldo(rechnungId: string) {
    const verbindung = db();
    const summe = await verbindung.creditNote.aggregate({ where: { invoiceId: rechnungId }, _sum: { grossTotal: true } });
    const r = await verbindung.invoice.findUniqueOrThrow({ where: { id: rechnungId }, select: { balance: true, grossTotal: true } });
    return { gutgeschrieben: Number(summe._sum.grossTotal ?? 0), offen: Number(r.balance), brutto: Number(r.grossTotal) };
  }

  it('zwei gleichzeitige Gutschriften, die zusammen die Rechnung übersteigen — genau eine gelingt', async () => {
    const id = await rechnung(true);
    // Je 60 netto = 64.86 brutto; zusammen 129.72 > 108.10.
    const antworten = await gleichzeitig(2, () => gutschrift(id, 60));

    const stand = await summeUndSaldo(id);
    assert.equal(stand.brutto, BRUTTO);
    assert.ok(stand.gutgeschrieben <= stand.brutto, `gutgeschrieben ${stand.gutgeschrieben} > Rechnung ${stand.brutto}`);
    assert.deepEqual(codes(antworten).sort(), [201, 422], texte(antworten));
    assert.equal(stand.gutgeschrieben, 64.86);
    assert.equal(stand.offen, rund(BRUTTO - 64.86), 'der offene Posten sinkt um genau eine Gutschrift');
  });

  /**
   * Die schärfere Form: Mit der Sperre werden die sechs Anfragen der Reihe
   * nach entschieden, und es passen **genau drei** (3 × 32.43 = 97.29; eine
   * vierte ergäbe 129.72). Weniger als drei hiesse, die Sperre wiese zu viel
   * ab; mehr, sie hielte nicht.
   */
  it('sechs gleichzeitige Gutschriften zu je 32.43 — genau drei, und nie mehr als die Rechnung', async () => {
    const id = await rechnung(true);
    const antworten = await gleichzeitig(SALVE, () => gutschrift(id, 30));

    const stand = await summeUndSaldo(id);
    assert.ok(stand.gutgeschrieben <= stand.brutto, `gutgeschrieben ${stand.gutgeschrieben} > Rechnung ${stand.brutto}`);
    assert.equal(anzahl(antworten, 201), 3, texte(antworten));
    assert.equal(anzahl(antworten, 422), 3, texte(antworten));
    assert.equal(stand.gutgeschrieben, 97.29);
    assert.equal(stand.offen, rund(BRUTTO - 97.29));
  });
});

// ===========================================================================
//  5. Rechnungen — lückenlose, eindeutige Nummern (Art. 957a OR)
// ===========================================================================

/**
 * Die Nummer entsteht beim Ausstellen, in derselben Transaktion wie der
 * Beleg (`nextNumber` in `numbering.service.ts`). Geprüft wird hier nicht
 * nur „verschieden", sondern „lückenlos": Der Zähler steht danach genau um
 * die Zahl der ausgestellten Belege weiter, und die Nummern füllen diesen
 * Bereich ohne Loch. Eine Nummer, die ein gescheiterter Parallelaufruf
 * gezogen und nicht verwendet hat, wäre genau die Lücke, die das Gesetz
 * verbietet.
 */
describe('Nebenläufigkeit — Rechnungsnummern', () => {
  before(belegeAufraeumen);
  after(belegeAufraeumen);

  const zuercherJahr = () => Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year: 'numeric' }).format(new Date()));
  const laufnummer = (nummer: string) => Number(nummer.split('-').at(-1));

  async function zaehlerstand(): Promise<number> {
    const organizationId = await eigeneOrganisationId();
    assert.ok(organizationId, 'eigene Organisation nicht gefunden');
    const zeile = await db().numberSequence.findUnique({
      where: { organizationId_scope_year: { organizationId, scope: 'invoice', year: zuercherJahr() } },
      select: { current: true },
    });
    return zeile?.current ?? 0;
  }

  it('fünf Entwürfe gleichzeitig ausgestellt — fünf verschiedene, lückenlos aufeinanderfolgende Nummern', async () => {
    const entwuerfe: string[] = [];
    for (let i = 0; i < 5; i++) entwuerfe.push(await rechnung(false));

    const vorher = await zaehlerstand();
    const antworten = await gleichzeitig(entwuerfe.length, (i) => post(`/api/invoices/${entwuerfe[i]}/issue`, undefined, { jar: jars.admin }));
    const nachher = await zaehlerstand();

    assert.deepEqual(codes(antworten), [200, 200, 200, 200, 200], texte(antworten));

    const belege = await db().invoice.findMany({ where: { id: { in: entwuerfe } }, select: { number: true, status: true } });
    for (const beleg of belege) assert.equal(beleg.status, 'ISSUED');
    const nummern = belege.map((b) => b.number);
    assert.equal(new Set(nummern).size, 5, `doppelte Nummer: ${nummern.join(', ')}`);
    for (const nummer of nummern) {
      assert.equal(await db().invoice.count({ where: { number: nummer } }), 1, `${nummer} steht mehr als einmal im Bestand`);
    }

    const folge = nummern.map(laufnummer).sort((a, b) => a - b);
    assert.deepEqual(folge, [vorher + 1, vorher + 2, vorher + 3, vorher + 4, vorher + 5], `nicht lückenlos: ${nummern.join(', ')} (Zähler vorher ${vorher})`);
    assert.equal(nachher, vorher + 5, 'der Zähler steht um genau die ausgestellten Belege weiter');
  });

  it('derselbe Entwurf fünfmal gleichzeitig ausgestellt — eine Nummer, kein verbrauchter Zählerstand', async () => {
    const entwurf = await rechnung(false);

    const vorher = await zaehlerstand();
    const antworten = await gleichzeitig(5, () => post(`/api/invoices/${entwurf}/issue`, undefined, { jar: jars.admin }));
    const nachher = await zaehlerstand();

    assert.equal(anzahl(antworten, 200), 1, texte(antworten));
    assert.equal(anzahl(antworten, 422), 4, texte(antworten));
    assert.equal(nachher, vorher + 1, `der Zähler ist um ${nachher - vorher} gewachsen — gezogene, unbenutzte Nummern sind Lücken`);
    const beleg = await db().invoice.findUniqueOrThrow({ where: { id: entwurf }, select: { number: true } });
    assert.equal(laufnummer(beleg.number), vorher + 1);
  });

  /**
   * Ausstellen gegen Löschen (2026-09-28, B-03). Das Löschen prüfte „noch
   * Entwurf?" ohne Sperre und schrieb `deletedAt` danach ohne Bedingung; das
   * Ausstellen prüfte `deletedAt` nicht unter seiner Sperre. Beides
   * gleichzeitig ergab eine nummerierte, ausgestellte Rechnung im Papierkorb —
   * in keiner Liste sichtbar, eine Lücke nach Art. 957a OR. Fünf Durchgänge,
   * weil ein Wettlauf ohne Vorkehrung nicht in jedem auftritt; mit Vorkehrung
   * muss jeder halten.
   */
  it('Ausstellen und Löschen desselben Entwurfs gleichzeitig — nie eine ausgestellte Rechnung im Papierkorb', async () => {
    for (let durchgang = 0; durchgang < 5; durchgang++) {
      const entwurf = await rechnung(false);
      const [ausstellen, loeschen] = await Promise.all([
        post(`/api/invoices/${entwurf}/issue`, undefined, { jar: jars.admin }),
        del(`/api/invoices/${entwurf}`, { jar: jars.admin }),
      ]);
      const beleg = await db().invoice.findUniqueOrThrow({ where: { id: entwurf }, select: { status: true, deletedAt: true, number: true } });
      assert.ok(
        !(beleg.status !== 'DRAFT' && beleg.deletedAt),
        `Durchgang ${durchgang}: ${beleg.number} ist ausgestellt und gelöscht (Ausstellen ${ausstellen.status}, Löschen ${loeschen.status})`,
      );
      // Genau eine der beiden Handlungen wirkt.
      assert.equal([ausstellen.status, loeschen.status].filter((s) => s < 300).length, 1, `${ausstellen.text} / ${loeschen.text}`);
    }
  });

  /**
   * B-05: Die Platzhalternummer eines Entwurfs bestand nur aus der
   * Millisekunde; zwei im selben Augenblick angelegte Entwürfe verletzten den
   * eindeutigen Index und ergaben einen 500.
   */
  it('fünf Entwürfe gleichzeitig angelegt — fünf Entwürfe, kein 500', async () => {
    const kunde = await belegKunde();
    const antworten = await gleichzeitig(5, () =>
      post<{ data: { id: string } }>(
        '/api/invoices',
        {
          customerId: kunde,
          notes: MARKE_BELEG,
          items: [{ name: 'Unterhaltsreinigung', quantity: 1, unit: 'Std.', unitPrice: 50, vatRate: 8.1 }],
          issueImmediately: false,
        },
        { jar: jars.admin },
      ),
    );
    assert.deepEqual(codes(antworten), [201, 201, 201, 201, 201], texte(antworten));
  });

  /**
   * B-04: Die QR-Referenz enthielt nur die laufende Nummer, und die beginnt
   * jedes Jahr bei 1 — `RE-2026-00001` und `RE-2027-00001` hätten dieselbe
   * Referenz getragen, und die Bank meldet Zahlungen genau damit. Jetzt steht
   * das Jahr des Nummernkreises vorne, gefolgt von der Laufnummer.
   */
  it('die QR-Referenz einer ausgestellten Rechnung trägt Jahr und Laufnummer', async () => {
    const id = await rechnung(true);
    const beleg = await db().invoice.findUniqueOrThrow({ where: { id }, select: { number: true, qrReference: true } });
    const [, jahr, lauf] = /-(\d{4})-(\d+)$/.exec(beleg.number) ?? [];
    assert.ok(beleg.qrReference, 'keine QR-Referenz');
    assert.equal(beleg.qrReference!.length, 27);
    assert.equal(beleg.qrReference!.slice(0, 4), jahr, `Referenz ${beleg.qrReference} beginnt nicht mit dem Jahr ${jahr}`);
    assert.equal(Number(beleg.qrReference!.slice(4, 26)), Number(lauf));
  });
});

// ===========================================================================
//  7. Stripe — dasselbe Ereignis gleichzeitig zugestellt
// ===========================================================================

/**
 * Stripe stellt ein Ereignis erneut zu, sobald eine Antwort ausbleibt — und
 * die erneute Zustellung kann eintreffen, während die erste noch läuft.
 * `zahlungsbuch.test.ts` prüft die Wiederholung **nacheinander**; hier
 * kommen sechs Zustellungen desselben Ereignisses gleichzeitig.
 *
 * Über HTTP prüfbar, weil der Testserver das Prüfgeheimnis
 * `PRUEF_STRIPE_GEHEIMNIS` als `STRIPE_WEBHOOK_SECRET` trägt und die
 * Signatur mit Stripes eigener Funktion entsteht — dieselbe Prüfung, die der
 * Endpunkt im Betrieb macht.
 */
describe('Nebenläufigkeit — Stripe-Webhook', () => {
  before(belegeAufraeumen);
  after(belegeAufraeumen);

  let zaehler = 0;
  const neueId = (art: string) => `${art}_nebenlaeufig_${RUN}_${++zaehler}`;

  async function zustellen(ereignis: { id: string; type: string; object: Record<string, unknown> }): Promise<number> {
    const payload = JSON.stringify({
      id: ereignis.id,
      object: 'event',
      api_version: '2024-06-20',
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      type: ereignis.type,
      data: { object: ereignis.object },
    });
    const signatur = Stripe.webhooks.generateTestHeaderString({ payload, secret: PRUEF_STRIPE_GEHEIMNIS });
    const antwort = await fetch(`${BASE_URL}/api/webhooks/stripe`, {
      method: 'POST',
      headers: { 'stripe-signature': signatur, 'content-type': 'application/json' },
      body: payload,
    });
    await antwort.text();
    return antwort.status;
  }

  const kundenwert = async (customerId: string) =>
    Number((await db().customer.findUniqueOrThrow({ where: { id: customerId }, select: { lifetimeValue: true } })).lifetimeValue);

  it('dasselbe Zahlungsereignis sechsmal gleichzeitig zugestellt — eine Zahlung, einmal Kundenwert', async () => {
    const id = await rechnung(true);
    const kunde = await belegKunde();
    const intent = neueId('pi');
    // Das Präfix `evt_nebenlaeufig_` ist die Marke für das Aufräumen.
    const ereignis = {
      id: `${STRIPE_PRAEFIX}${RUN}_zahlung`,
      type: 'checkout.session.completed',
      object: { id: neueId('cs'), object: 'checkout.session', payment_status: 'paid', payment_intent: intent, amount_total: BRUTTO_RAPPEN, client_reference_id: id, metadata: { invoiceId: id, method: 'CARD' } },
    };

    const wertVorher = await kundenwert(kunde);
    resetRateLimits();
    const status = await Promise.all(Array.from({ length: SALVE }, () => zustellen(ereignis)));

    assert.equal(await db().payment.count({ where: { invoiceId: id } }), 1, 'mehr als eine Zahlung für dasselbe Ereignis gebucht');
    assert.deepEqual(status, Array(SALVE).fill(200), `jede Zustellung wird bestätigt, sonst stellt Stripe weiter zu: ${status.join(', ')}`);
    const r = await db().invoice.findUniqueOrThrow({ where: { id }, select: { paidAmount: true, balance: true, status: true } });
    assert.deepEqual({ bezahlt: Number(r.paidAmount), offen: Number(r.balance), status: r.status }, { bezahlt: BRUTTO, offen: 0, status: 'PAID' });
    assert.equal(rund((await kundenwert(kunde)) - wertVorher), BRUTTO, 'der Kundenwert wächst genau einmal');
  });

  it('dieselbe Rückerstattung sechsmal gleichzeitig zugestellt — genau einmal abgezogen', async () => {
    const id = await rechnung(true);
    const kunde = await belegKunde();
    const intent = neueId('pi');
    assert.equal(
      await zustellen({
        id: `${STRIPE_PRAEFIX}${RUN}_vorzahlung`,
        type: 'checkout.session.completed',
        object: { id: neueId('cs'), object: 'checkout.session', payment_status: 'paid', payment_intent: intent, amount_total: BRUTTO_RAPPEN, client_reference_id: id, metadata: { invoiceId: id, method: 'CARD' } },
      }),
      200,
    );

    const wertVorher = await kundenwert(kunde);
    const erstattung = {
      id: `${STRIPE_PRAEFIX}${RUN}_erstattung`,
      type: 'charge.refunded',
      object: { id: `ch_${intent}`, object: 'charge', payment_intent: intent, amount: BRUTTO_RAPPEN, amount_refunded: 3_000 },
    };
    resetRateLimits();
    const status = await Promise.all(Array.from({ length: SALVE }, () => zustellen(erstattung)));

    const zahlung = await db().payment.findFirstOrThrow({ where: { invoiceId: id } });
    assert.equal(Number(zahlung.refundedAmount), 30, 'erstattet ist der gemeldete Stand, nicht ein Vielfaches');
    const r = await db().invoice.findUniqueOrThrow({ where: { id }, select: { paidAmount: true, balance: true } });
    assert.equal(Number(r.paidAmount), rund(BRUTTO - 30));
    assert.equal(Number(r.balance), 30);
    assert.equal(rund(wertVorher - (await kundenwert(kunde))), 30, 'der Kundenwert sinkt genau einmal');
    assert.deepEqual(status, Array(SALVE).fill(200), status.join(', '));
  });
});

// ===========================================================================
//  3. Kundschaft und Adressen
// ===========================================================================

/**
 * Zwei Regeln der Kundenverwaltung:
 *
 *  • **Genau eine Standardadresse** (`address.service.ts`): „Zwei
 *    Standardadressen wären kein sichtbarer Fehler — die Buchung nähme
 *    einfach irgendeine, und das Team stünde vor der falschen Tür."
 *  • **Eine Kundenakte je E-Mail-Adresse** (`createCustomer`): Die zweite
 *    Anlage mit derselben Adresse antwortet 409 — „doppelte
 *    Kundendatensätze sind im Tagesgeschäft eine der teuersten
 *    Fehlerquellen" (`/api/leads/:id/convert`). Einen Idempotenzschlüssel
 *    für die Anlage gibt es nicht; die Regel, die einen Doppelklick
 *    auffangen muss, ist also genau diese.
 */
describe('Nebenläufigkeit — Kundschaft und Adressen', () => {
  const EMAIL_PRAEFIX = 'nebenlaeufig.';

  const aufraeumen = async () => {
    const verbindung = db();
    await verbindung.lead.deleteMany({ where: { email: { startsWith: EMAIL_PRAEFIX } } });
    // Nur Akten ohne Belege — diese Datei stellt auf ihre eigenen Akten nie etwas aus.
    await verbindung.customer.deleteMany({ where: { email: { startsWith: EMAIL_PRAEFIX }, invoices: { none: {} }, creditNotes: { none: {} } } });
  };

  before(aufraeumen);
  after(aufraeumen);

  const kundschaft = (email: string) => ({
    type: 'PRIVATE',
    firstName: 'Gleichzeitig',
    lastName: 'Prüfakte',
    email,
    language: 'DE',
    paymentTermDays: 30,
    discountPercent: 0,
    taxExempt: false,
    tagIds: [],
    createLogin: false,
    address: { street: 'Aarbergergasse', streetNo: '1', postalCode: '3011', city: 'Bern', country: 'CH' },
  });

  it('vier Adressen gleichzeitig zur Standardadresse gemacht — danach genau eine', async () => {
    const angelegt = await post<{ data: { id: string } }>('/api/customers', kundschaft(`${EMAIL_PRAEFIX}standard.${RUN}@example.ch`), { jar: jars.admin });
    assert.equal(angelegt.status, 201, angelegt.text);
    const kundeId = data(angelegt).id;

    const weitere: string[] = [];
    for (let i = 2; i <= 5; i++) {
      const adresse = await post<{ data: { id: string } }>(
        `/api/customers/${kundeId}/addresses`,
        { label: `Adresse ${i}`, street: 'Kramgasse', streetNo: String(i), postalCode: '3011', city: 'Bern' },
        { jar: jars.admin },
      );
      assert.equal(adresse.status, 201, adresse.text);
      weitere.push(data(adresse).id);
    }

    const antworten = await gleichzeitig(weitere.length, (i) =>
      patch(`/api/customers/${kundeId}/addresses/${weitere[i]}`, { isDefault: true }, { jar: jars.admin }),
    );

    const adressen = await db().address.findMany({ where: { customerId: kundeId }, select: { id: true, isDefault: true } });
    const standard = adressen.filter((a) => a.isDefault);
    assert.equal(standard.length, 1, `${standard.length} Standardadressen nach gleichzeitigem Umsetzen (${codes(antworten).join(', ')})`);

    const gelungen = weitere.filter((_, i) => antworten[i]!.status === 200);
    assert.ok(gelungen.length >= 1, `keine einzige Umsetzung gelang: ${texte(antworten)}`);
    assert.ok(gelungen.includes(standard[0]!.id), 'Standard ist eine Adresse, deren Umsetzung abgewiesen wurde');
    keinServerfehler(antworten, 'Standardadresse umsetzen');
  });

  it('dieselbe Kundschaft fünfmal gleichzeitig angelegt — eine Akte, die übrigen 409', async () => {
    const email = `${EMAIL_PRAEFIX}doppelt.${RUN}@example.ch`;
    const antworten = await gleichzeitig(5, () => post<{ data: { id: string } }>('/api/customers', kundschaft(email), { jar: jars.admin }));

    const akten = await db().customer.count({ where: { email, deletedAt: null } });
    assert.equal(akten, 1, `${akten} Kundenakten mit derselben E-Mail-Adresse aus einem Doppelklick (${codes(antworten).join(', ')})`);
    assert.equal(anzahl(antworten, 201), 1, texte(antworten));
    assert.equal(anzahl(antworten, 409), 4, texte(antworten));
  });

  // =========================================================================
  //  4. Anfragen — doppelte Umwandlung
  // =========================================================================

  /**
   * „Existiert bereits ein Kunde mit derselben E-Mail-Adresse, wird verknüpft
   * statt dupliziert" (`/api/leads/:id/convert`). Wer im Kanban zweimal auf
   * „In Kundschaft umwandeln" klickt, bekommt dieselbe Akte zurück — nicht
   * zwei. Die Umwandlung ist damit idempotent, und jede Antwort nennt
   * dieselbe Kundschaft.
   */
  it('eine Anfrage sechsmal gleichzeitig umgewandelt — genau eine Kundschaft, überall dieselbe', async () => {
    const email = `${EMAIL_PRAEFIX}umwandlung.${RUN}@example.ch`;
    const anfrage = await post<{ data: { id: string } }>(
      '/api/leads',
      { firstName: 'Gleichzeitig', lastName: 'Umwandlung', email, street: 'Marktgasse 3', postalCode: '3011', city: 'Bern', source: 'PHONE', tagIds: [] },
      { jar: jars.admin },
    );
    assert.equal(anfrage.status, 201, anfrage.text);
    const leadId = data(anfrage).id;

    const antworten = await gleichzeitig(SALVE, () => post<{ data: { id: string } }>(`/api/leads/${leadId}/convert`, undefined, { jar: jars.admin }));

    const akten = await db().customer.findMany({ where: { email, deletedAt: null }, select: { id: true } });
    assert.equal(akten.length, 1, `${akten.length} Kundenakten aus einer Anfrage (${codes(antworten).join(', ')})`);

    const lead = await db().lead.findUniqueOrThrow({ where: { id: leadId }, select: { customerId: true, status: true } });
    assert.equal(lead.customerId, akten[0]!.id, 'die Anfrage zeigt auf die eine Akte');
    assert.equal(lead.status, 'WON');

    assert.deepEqual(codes(antworten), Array(SALVE).fill(201), texte(antworten));
    const genannt = new Set(antworten.map((a) => data(a)?.id));
    assert.deepEqual([...genannt], [akten[0]!.id], 'jede Antwort nennt dieselbe Kundschaft');
  });
});

// ===========================================================================
//  6. Automatisierung — zwei Scheduler, ein fälliger Lauf
// ===========================================================================

/**
 * Der stündliche Takt kann sich überlappen: ein Lauf, der länger dauert als
 * geplant, und der nächste, der pünktlich startet — oder eine Plattform, die
 * einen Cron-Aufruf nach einem Zeitlimit wiederholt. Ein fälliger Lauf darf
 * dabei nur einmal ausgeführt werden; sonst bekommt eine Kundschaft zwei
 * E-Mails oder das Büro zwei Aufgaben.
 *
 * Aufbau wie in `automatisierungen.test.ts` (RB-012): Regel „Aufgabe wird
 * fällig" mit einer Folgeaufgabe als Wirkung — die sich zählen lässt, ohne
 * eine E-Mail abzufangen.
 */
describe('Nebenläufigkeit — Automatisierung', () => {
  const REGEL = 'Prüfreihe Nebenläufigkeit Automatisierung';
  const AUFGABE = `Nebenläufig ${RUN}`;
  const FOLGE_PRAEFIX = 'Folgeaufgabe Nebenläufig';
  const cron = () => get('/api/cron/hourly', { headers: { authorization: `Bearer ${process.env.CRON_SECRET ?? 'dev-cron-secret'}` } });

  const aufraeumen = async () => {
    const verbindung = db();
    const regeln = await verbindung.automation.findMany({ where: { name: { startsWith: REGEL } }, select: { id: true } });
    for (const regel of regeln) await del(`/api/automations/${regel.id}`, { jar: jars.admin });
    await verbindung.task.deleteMany({ where: { OR: [{ title: { startsWith: 'Nebenläufig ' } }, { title: { startsWith: FOLGE_PRAEFIX } }] } });
  };

  before(aufraeumen);
  after(aufraeumen);

  it('fünf gleichzeitige stündliche Läufe mit einem fälligen Lauf — die Aktion läuft genau einmal', async () => {
    const regel = await post<{ data: { id: string } }>(
      '/api/automations',
      {
        name: `${REGEL} ${RUN}`,
        trigger: 'TASK_DUE',
        delayMinutes: 0,
        active: true,
        actions: [{ type: 'CREATE_TASK', config: { titel: `${FOLGE_PRAEFIX} ${RUN} {{titel}}`, faelligInTagen: 1 } }],
      },
      { jar: jars.admin },
    );
    assert.equal(regel.status, 201, regel.text);
    const regelId = data(regel).id;

    const aufgabe = await post<{ data: { id: string } }>(
      '/api/tasks',
      { title: AUFGABE, dueAt: new Date(Date.now() + 30 * 60_000).toISOString() },
      { jar: jars.admin },
    );
    assert.equal(aufgabe.status, 201, aufgabe.text);
    const eigene = { automationId: regelId, entityId: data(aufgabe).id };

    // Erster Takt meldet den Lauf (fällig zur Frist); dann wird er fällig gemacht.
    const erster = await cron();
    assert.ok([200, 500].includes(erster.status), `stündlicher Lauf: HTTP ${erster.status}`);
    assert.equal(await db().automationRun.count({ where: eigene }), 1, 'der Lauf wurde nicht gemeldet');
    await db().automationRun.updateMany({ where: eigene, data: { scheduledFor: new Date(Date.now() - 60_000) } });

    const antworten = await gleichzeitig(5, () => cron());
    for (const antwort of antworten) assert.ok([200, 500].includes(antwort.status), `stündlicher Lauf: HTTP ${antwort.status}`);

    // Gezählt wird die Folgeaufgabe der *eigenen* Aufgabe — `{{titel}}` setzt
    // deren Titel ein. Eine Demoaufgabe im Suchfenster löst dieselbe Regel zu
    // Recht ebenfalls aus und hätte einen anderen Titel.
    const folge = await db().task.count({ where: { title: `${FOLGE_PRAEFIX} ${RUN} ${AUFGABE}` } });
    assert.equal(folge, 1, `die Aktion lief ${folge}-mal`);

    const laeufe = await db().automationRun.findMany({ where: eigene, include: { aktionen: true } });
    assert.equal(laeufe.length, 1, 'je Vorgang genau ein Lauf');
    assert.equal(laeufe[0]!.status, 'SUCCESS', `Lauf: ${laeufe[0]!.status} ${laeufe[0]!.error ?? ''}`);
    assert.equal(laeufe[0]!.attempts, 1, 'der Lauf wurde von mehr als einem Takt beansprucht');
    assert.equal(laeufe[0]!.aktionen[0]?.attempts, 1, 'die Aktion wurde mehr als einmal ausgeführt');
  });
});

// ===========================================================================
//  8. Führung — Dokumentfassungen
// ===========================================================================

/**
 * Zwei Personen laden gleichzeitig eine neue Fassung desselben Dokuments
 * hoch. Die Fassungsnummern müssen eindeutig und lückenlos bleiben, und die
 * „geltende" Fassung muss die höchste sein — sonst zeigt das Dokument eine
 * ältere Fassung als die, die zuletzt angenommen wurde, und eine
 * Unterzeichnung bände womöglich die falschen Bytes.
 *
 * Nicht verlangt wird, dass jede gleichzeitige Fassung angenommen wird: Eine
 * abgewiesene Fassung mit sauberem 409 lässt sich erneut hochladen. Verlangt
 * wird, dass sie dann **gar nicht** entsteht — keine halbe Fassung, keine
 * verbrauchte Datei — und dass die Abweisung kein Serverfehler ist.
 */
describe('Nebenläufigkeit — Dokumentfassungen', () => {
  const TITEL = 'Prüfreihe Nebenläufigkeit Dokument';
  const DATEI_PRAEFIX = 'nebenlaeufig-';

  const aufraeumen = async () => {
    const verbindung = db();
    const dokumente = await verbindung.managedDocument.findMany({ where: { title: { startsWith: TITEL } }, select: { id: true } });
    const ids = dokumente.map((d) => d.id);
    if (ids.length > 0) {
      await verbindung.managedDocument.updateMany({ where: { id: { in: ids } }, data: { currentVersionId: null } });
      await verbindung.documentVersion.deleteMany({ where: { documentId: { in: ids } } });
      await verbindung.managedDocument.deleteMany({ where: { id: { in: ids } } });
    }
    const dateien = await verbindung.fileAsset.findMany({ where: { filename: { startsWith: DATEI_PRAEFIX } }, select: { id: true, storedFileId: true } });
    await verbindung.fileAsset.deleteMany({ where: { id: { in: dateien.map((d) => d.id) } } });
    const ablage = dateien.map((d) => d.storedFileId).filter((x): x is string => Boolean(x));
    if (ablage.length > 0) await verbindung.storedFile.deleteMany({ where: { id: { in: ablage } } });
  };

  before(aufraeumen);
  after(aufraeumen);

  /** Ein echtes PDF mit zufälligem Inhalt — jede Fassung hat eigene Bytes. */
  async function pdf(): Promise<Buffer> {
    const doc = await PDFDocument.create();
    const seite = doc.addPage([595.28, 841.89]);
    const schrift = await doc.embedFont(StandardFonts.Helvetica);
    seite.drawText(`Fassung ${randomBytes(8).toString('hex')}`, { x: 56, y: 780, size: 14, font: schrift });
    return Buffer.from(await doc.save());
  }

  /** Upload wie in `signatur.test.ts`: Ticket, Bytes, Abschluss. */
  async function hochladen(name: string): Promise<string> {
    const bytes = await pdf();
    const filename = `${DATEI_PRAEFIX}${RUN}-${name}.pdf`;
    const ticket = await post<{ data: { ticketId: string; signedUrl: string } }>(
      '/api/files/upload-url',
      { profile: 'document', filename, mimeType: 'application/pdf', sizeBytes: bytes.byteLength },
      { jar: jars.admin },
    );
    assert.equal(ticket.status, 201, ticket.text);
    const pfad = `${BASE_URL}${new URL(data(ticket).signedUrl, BASE_URL).pathname}`;
    const upload = await fetch(pfad, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: new Uint8Array(bytes) });
    assert.equal(upload.status, 200, await upload.text());
    const abschluss = await post<{ data: { id: string } }>('/api/files/finalize', { ticketId: data(ticket).ticketId, filename }, { jar: jars.admin });
    assert.equal(abschluss.status, 201, abschluss.text);
    return data(abschluss).id;
  }

  it('fünf Fassungen gleichzeitig hochgeladen — eindeutige, lückenlose Nummern, die höchste gilt', async () => {
    resetRateLimits();
    const erste = await hochladen('v1');
    const dokument = await post<{ data: { id: string } }>('/api/bi/documents', { title: `${TITEL} ${RUN}`, category: 'OTHER', fileId: erste }, { jar: jars.admin });
    assert.equal(dokument.status, 201, dokument.text);
    const dokumentId = data(dokument).id;

    const dateien: string[] = [];
    for (let i = 0; i < 5; i++) dateien.push(await hochladen(`neu-${i}`));

    const antworten = await gleichzeitig(dateien.length, (i) =>
      post<{ data: { id: string; version: number } }>(`/api/bi/documents/${dokumentId}/versions`, { fileId: dateien[i] }, { jar: jars.admin }),
    );

    const fassungen = await db().documentVersion.findMany({ where: { documentId: dokumentId }, orderBy: { version: 'asc' }, select: { id: true, version: true, fileAssetId: true } });
    const nummern = fassungen.map((f) => f.version);
    assert.deepEqual(nummern, Array.from({ length: fassungen.length }, (_, i) => i + 1), `Fassungsnummern nicht lückenlos: ${nummern.join(', ')}`);

    const angenommen = antworten.filter((a) => a.status === 201);
    assert.ok(angenommen.length >= 1, `keine Fassung angenommen: ${texte(antworten)}`);
    assert.equal(fassungen.length, 1 + angenommen.length, 'jede angenommene Fassung steht genau einmal im Bestand');
    assert.deepEqual(
      angenommen.map((a) => data(a).version).sort((x, y) => x - y),
      nummern.slice(1),
      'die gemeldeten Nummern sind die gespeicherten',
    );

    const geltend = await db().managedDocument.findUniqueOrThrow({ where: { id: dokumentId }, select: { currentVersionId: true } });
    assert.equal(geltend.currentVersionId, fassungen.at(-1)!.id, 'die geltende Fassung ist nicht die höchste');

    const abgewiesen = dateien.filter((_, i) => antworten[i]!.status !== 201);
    for (const antwort of antworten) assert.ok([201, 409].includes(antwort.status), `unerwartete Antwort: ${antwort.status} ${antwort.text.slice(0, 200)}`);
    assert.equal(await db().documentVersion.count({ where: { fileAssetId: { in: abgewiesen } } }), 0, 'eine abgewiesene Datei hängt trotzdem an einer Fassung');
    keinServerfehler(antworten, 'Fassung hochladen');
  });
});

// ===========================================================================
//  9. Öffentliche Formulare — schneller Doppelklick
// ===========================================================================

/**
 * Was das Produkt für einen doppelt abgeschickten öffentlichen Aufruf
 * **zusagt** — und nur das wird geprüft:
 *
 *  • **Newsletter:** eine Anmeldung je Adresse (eindeutiger Index
 *    `organizationId_email`), und die Antwort ist „immer identisch — auch
 *    bei einer bereits eingetragenen Adresse" (`/api/public/newsletter`).
 *    Ein 409 für den zweiten Klick verriete, dass die Adresse schon
 *    eingetragen ist.
 *  • **Kontakt:** Eine weitere Anfrage derselben Person wird an die offene
 *    Anfrage angehängt, „nicht als neuer Vorgang gezählt"
 *    (`findMatchingLead`/`createLeadFromContactForm`). Ein Doppelklick ist
 *    genau dieser Fall, nur schneller.
 *  • **Buchung:** Hier gibt es **keine** Zusage gegen Doppelungen — keinen
 *    Idempotenzschlüssel, keine Regel „eine Buchung je Person und Termin"
 *    (zwei Buchungen derselben Kundschaft zur selben Zeit können gewollt
 *    sein, etwa zwei Objekte). Zugesagt ist nur die Kapazität: zwei
 *    gleichzeitige Buchungen für den letzten Platz ergeben genau eine; das
 *    prüfen `mehrere-leistungen.test.ts` und `buchung-integritaet.test.ts`.
 *    Eine Doppelbuchungsprüfung hier wäre eine erfundene Regel.
 */
describe('Nebenläufigkeit — öffentliche Formulare', () => {
  const EMAIL_PRAEFIX = 'nebenlaeufig.oeffentlich.';

  const aufraeumen = async () => {
    const verbindung = db();
    await verbindung.newsletterSubscriber.deleteMany({ where: { email: { startsWith: EMAIL_PRAEFIX } } });
    await verbindung.lead.deleteMany({ where: { email: { startsWith: EMAIL_PRAEFIX } } });
  };

  before(aufraeumen);
  after(aufraeumen);

  /** Ohne Wiederholung: Ein 429 hier hiesse eine Stunde warten (siehe Dateikopf). */
  const oeffentlich = (pfad: string, body: unknown) => call('POST', pfad, { body, retries: 0 });

  it('dieselbe Adresse dreimal gleichzeitig zum Newsletter angemeldet — ein Eintrag, dreimal dieselbe Antwort', async (t) => {
    if (!rateLimitResetAvailable()) return t.skip('ohne dateibasierten Zähler des Testservers liefe das Stundenlimit voll');
    const email = `${EMAIL_PRAEFIX}news.${RUN}@example.ch`;
    const antworten = await gleichzeitig(3, () => oeffentlich('/api/public/newsletter', { email, locale: 'DE', website: '' }));

    assert.equal(anzahl(antworten, 429), 0, `Rate-Limit statt Prüfung: ${texte(antworten)}`);
    assert.equal(await db().newsletterSubscriber.count({ where: { email } }), 1, 'mehr als ein Eintrag für dieselbe Adresse');
    assert.deepEqual(codes(antworten), [201, 201, 201], `die Antwort verrät sonst, dass die Adresse schon eingetragen ist: ${texte(antworten)}`);
    assert.equal(new Set(antworten.map((a) => a.text)).size, 1, 'drei verschiedene Antworten auf dieselbe Anmeldung');
  });

  it('dieselbe Kontaktanfrage doppelt abgeschickt — eine offene Anfrage, beide Nachrichten daran', async (t) => {
    if (!rateLimitResetAvailable()) return t.skip('ohne dateibasierten Zähler des Testservers liefe das Stundenlimit voll');
    const email = `${EMAIL_PRAEFIX}kontakt.${RUN}@example.ch`;
    const anfrage = {
      firstName: 'Gleichzeitig',
      lastName: 'Kontakt',
      email,
      phone: '+41 31 555 00 11',
      message: 'Wir suchen eine Unterhaltsreinigung für eine Praxis in Bern.',
      acceptPrivacy: true,
      website: '',
    };
    const antworten = await gleichzeitig(2, () => oeffentlich('/api/public/contact', anfrage));

    assert.equal(anzahl(antworten, 429), 0, `Rate-Limit statt Prüfung: ${texte(antworten)}`);
    assert.deepEqual(codes(antworten), [201, 201], texte(antworten));

    const leads = await db().lead.findMany({ where: { email, deletedAt: null }, select: { id: true, _count: { select: { activities: true } } } });
    assert.equal(leads.length, 1, `${leads.length} Anfragen aus einem Doppelklick — das Büro ruft zweimal an`);
    assert.ok(leads[0]!._count.activities >= 2, 'die zweite Nachricht ging verloren statt angehängt zu werden');
  });
});

// ===========================================================================
//  10. Zuteilung gegen Bewilligung einer Abwesenheit
// ===========================================================================

/**
 * Die beiden Regeln greifen ineinander (`dispatch.test.ts`, Block
 * „Abwesenheit"): Eine bewilligte Abwesenheit blockiert die Zuteilung, und
 * die Bewilligung wird verweigert, solange im Zeitraum Einsätze zugeteilt
 * sind — „erst umplanen, dann bewilligen". Nacheinander hält das.
 *
 * Gleichzeitig gefahren darf es **nie** beides geben: eine zugeteilte
 * Person **und** eine bewilligte Abwesenheit über denselben Einsatz. Sonst
 * steht am Einsatztag niemand vor der Tür, und keine der beiden Stellen hat
 * es gemeldet. Fünf Durchgänge, weil ein Wettlauf ohne Vorkehrung nicht bei
 * jedem Versuch sichtbar wird; mit Vorkehrung muss jeder halten.
 */
describe('Nebenläufigkeit — Zuteilung gegen Abwesenheit', () => {
  const MARKE = 'Prüfreihe Nebenläufigkeit Zuteilung';
  const DURCHGAENGE = 5;
  let annaId = '';
  let customerId = '';
  let addressId = '';
  let tag0 = 0;

  /** Wie in `dispatch.test.ts`: lokale Zeit, damit Tag und Wochentag zusammenpassen. */
  function zeitpunkt(offsetTage: number, stunde: number): string {
    const datum = new Date();
    datum.setDate(datum.getDate() + offsetTage);
    datum.setHours(stunde, 0, 0, 0);
    return datum.toISOString();
  }

  /** Kalendertag aus der lokalen Zeit — nicht `toISOString()`, siehe `dispatch.test.ts`. */
  function kalendertag(offsetTage: number): string {
    const datum = new Date();
    datum.setDate(datum.getDate() + offsetTage);
    return `${datum.getFullYear()}-${String(datum.getMonth() + 1).padStart(2, '0')}-${String(datum.getDate()).padStart(2, '0')}`;
  }

  const aufraeumen = async () => {
    const verbindung = db();
    const einsaetze = await verbindung.job.findMany({ where: { title: { startsWith: MARKE }, deletedAt: null }, select: { id: true } });
    for (const einsatz of einsaetze) {
      // Zuerst das Team leeren: Eine Zuteilung an einem gelöschten Einsatz
      // soll keine spätere Prüfung derselben Person irritieren.
      await put(`/api/jobs/${einsatz.id}/team`, { members: [], notify: false }, { jar: jars.admin });
      await del(`/api/jobs/${einsatz.id}`, { jar: jars.admin });
    }
    if (annaId) await verbindung.absence.deleteMany({ where: { employeeId: annaId, reason: MARKE } });
  };

  before(async () => {
    const objekte = data(await get<{ data: { address: { id: string } | null; customer: { id: string } }[] }>('/api/properties', { jar: jars.admin }));
    const mitAdresse = objekte.find((o) => o.address !== null);
    assert.ok(mitAdresse, 'der Demobestand enthält ein Objekt mit Adresse');
    addressId = mitAdresse.address!.id;
    customerId = mitAdresse.customer.id;

    const personal = data(await get<{ data: { id: string; user: { email: string } }[] }>('/api/employees', { jar: jars.admin }));
    annaId = personal.find((p) => p.user.email === 'anna.keller@clenaris.ch')?.id ?? '';
    assert.ok(annaId, 'Anna Keller fehlt im Demobestand');

    await aufraeumen();

    /**
     * Das Fenster hinter alles legen, was Anna an Abwesenheiten hat — und
     * weiter hinaus als `dispatch.test.ts` (ab Tag 300), damit sich die beiden
     * Reihen nicht begegnen. Anker ist ein Dienstag: Die Abwesenheit reicht
     * bis Mittwoch, beides Werktage, sonst wiese `requestAbsence` sie als
     * „ohne Arbeitstage" ab.
     */
    const abwesenheiten = data(await get<{ data: { endDate: string; status: string }[] }>(`/api/absences?employeeId=${annaId}`, { jar: jars.admin }));
    const heute = Date.now();
    const spaetestesEnde = abwesenheiten
      .filter((a) => a.status === 'APPROVED' || a.status === 'REQUESTED')
      .reduce((max, a) => Math.max(max, new Date(a.endDate).getTime()), heute);
    const roh = Math.max(450, Math.ceil((spaetestesEnde - heute) / 86_400_000) + 21);
    const datum = new Date();
    datum.setDate(datum.getDate() + roh);
    tag0 = roh + ((2 - datum.getDay() + 7) % 7);
  });

  after(aufraeumen);

  it('Zuteilung und Bewilligung gleichzeitig — nie beides, fünfmal', async () => {
    const verstoesse: string[] = [];

    for (let durchgang = 0; durchgang < DURCHGAENGE; durchgang++) {
      const tag = tag0 + 7 * durchgang;
      resetRateLimits();

      const einsatz = await post<{ data: { id: string } }>(
        '/api/jobs',
        { customerId, addressId, title: `${MARKE} ${RUN} ${durchgang}`, scheduledStart: zeitpunkt(tag, 8), scheduledEnd: zeitpunkt(tag, 11) },
        { jar: jars.admin },
      );
      assert.equal(einsatz.status, 201, einsatz.text);
      const jobId = data(einsatz).id;

      /**
       * Dienstag bis Mittwoch, nicht nur Dienstag. `decideAbsence` vergleicht
       * den Einsatzbeginn mit dem Enddatum als Zeitpunkt (Mitternacht UTC);
       * ein Einsatz am letzten Abwesenheitstag fiele dort durch die Prüfung.
       * Das ist ein eigener Befund — diese Prüfung soll den Wettlauf messen,
       * nicht ihn.
       */
      const gesuch = await post<{ data: { id: string } }>(
        '/api/absences',
        { type: 'TRAINING', startDate: kalendertag(tag), endDate: kalendertag(tag + 1), reason: MARKE },
        { jar: jars.employee },
      );
      assert.equal(gesuch.status, 201, gesuch.text);
      const gesuchId = data(gesuch).id;

      const [zuteilung, bewilligung] = await Promise.all([
        post(`/api/jobs/${jobId}/assign`, { employeeIds: [annaId], notify: false }, { jar: jars.admin }),
        post(`/api/absences/${gesuchId}/decide`, { status: 'APPROVED', decisionNote: MARKE }, { jar: jars.admin }),
      ]);

      const stand = await db().absence.findUniqueOrThrow({ where: { id: gesuchId }, select: { status: true } });
      const zugeteilt = await db().jobAssignment.count({ where: { jobId, employeeId: annaId } });

      if (stand.status === 'APPROVED' && zugeteilt > 0) {
        verstoesse.push(`Durchgang ${durchgang}: zugeteilt (${zuteilung.status}) und bewilligt (${bewilligung.status})`);
      } else {
        // Genau eine Seite gewinnt; die andere wird mit Begründung abgewiesen.
        assert.deepEqual(
          [zuteilung.status, bewilligung.status].sort(),
          [200, 422],
          `Durchgang ${durchgang}: Zuteilung ${zuteilung.text.slice(0, 200)} | Bewilligung ${bewilligung.text.slice(0, 200)}`,
        );
      }
    }

    assert.deepEqual(verstoesse, [], `Person eingeteilt und zugleich bewilligt abwesend:\n${verstoesse.join('\n')}`);
  });
});
