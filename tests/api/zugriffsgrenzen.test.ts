import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { call, data, del, get, patch, post, requireServer, sleep, type ApiResponse } from '../helpers/client';
import { ACCOUNTS, login, loginAll, type AccountName } from '../helpers/accounts';
import { resetRateLimits } from '../helpers/rate-limit';
import { cookieValue, totp } from '../helpers/totp';
import { eigeneOrganisationId, testDb, testDbGrund, testDbSchliessen } from '../helpers/testdb';

/**
 * Zugriffsgrenzen, die bisher nur behauptet und nicht geprüft waren.
 *
 * Drei Lücken, die eine Durchsicht der Prüfreihe am 2026-09-27 fand:
 *
 *  A) **Ohne Anmeldung.** `defineRoute` antwortet ohne Sitzung mit 401 — aber
 *     ob ein Endpunkt überhaupt `defineRoute` benutzt und nicht aus Versehen
 *     `definePublicRoute`, sieht man nur, wenn man ihn ohne Cookie anfährt.
 *     Für Offerten, Verträge, Zeiterfassung, Lohn, Gutschriften, Nachrichten,
 *     Anfragen und die Geräteübergabe tat das bisher keine Datei. Ein Wechsel
 *     der Fabrik bei einem einzelnen Endpunkt wäre durch die ganze Reihe
 *     gerutscht. Mitgeprüft wird ein gefälschtes und ein unsigniertes Token:
 *     „irgendein Cookie" darf nicht mehr öffnen als „kein Cookie".
 *
 *  B) **Rollengrenzen, an denen Daten hängen.** Dass Mitarbeitende und
 *     Kundschaft keine Offerten anlegen, ändern oder versenden, stand in
 *     `rbac.ts`, aber in keiner Prüfung. Bei den Nachrichten ist die Grenze
 *     keine Berechtigung, sondern eine Eigentümerschaft (`loadThread` in
 *     `message.service.ts`): Kundschaft hat `message:read_own`, Mitarbeitende
 *     ebenso — und ein fehlender Filter liesse sie fremde Verläufe lesen, ohne
 *     dass ein Statuscode-Test es je bemerkte.
 *
 *  C) **Zweiter Faktor über Kontogrenzen.** Der Zwischenschein trägt nur die
 *     Benutzer-ID; der Code wird gegen das Geheimnis *dieses* Kontos geprüft.
 *     Dass der gültige Code eines anderen Kontos den Schein nicht einlöst, war
 *     nirgends belegt — ebenso wenig, dass Ein- und Ausschalten und die
 *     Rücksetzung im Prüfprotokoll und bei den Sicherheitsereignissen landen.
 *
 * Was hier entsteht, trägt die Marke `MARKE` oder die Domain `KONTO_DOMAIN`
 * und wird vor und nach dem Lauf entfernt. Die geteilten Demokonten werden
 * nur gelesen: Der zweite Faktor wird an zwei Wegwerfkonten eingeschaltet,
 * nie an einem Konto, das andere Dateien über den Sitzungs-Cache benutzen —
 * bliebe dort ein Faktor stehen, scheiterte jede folgende Datei an der
 * Anmeldung, und man suchte den Fehler an der falschen Stelle.
 */

type Jars = Record<AccountName, string>;

const RUN = Date.now();
const MARKE = 'ZUGRIFFSGRENZE-PRUEF';
/** Bewusst eine eigene Unter-Marke: Die Spurensuche in A darf nicht auf die Verläufe aus B treffen. */
const MARKE_ANONYM = `${MARKE}-ANONYM`;
const KONTO_DOMAIN = '@zugriffsgrenzen-pruef.example.ch';
const KONTO_PASSWORT = 'Zugriff#2026Grenze';

/**
 * Eine Kennung, die es nicht gibt. Für die Prüfung ohne Anmeldung genügt sie:
 * `defineRoute` fragt die Sitzung ab, *bevor* es die Parameter liest. Würde
 * ein Endpunkt öffentlich, antwortete er mit 404 oder 422 statt 401 — und
 * fiele damit genauso durch wie mit einer echten Kennung.
 */
const GIBT_ES_NICHT = 'cmzugriffsgrenze000000000';

let jars: Jars;

const inTagen = (tage: number) => new Date(Date.now() + tage * 86_400_000).toISOString().slice(0, 10);

/**
 * Alles entfernen, was diese Datei anlegen kann — auch das, was nur ein
 * fehlerhaftes Produkt angelegt hätte (eine Offerte der Kundschaft, eine
 * Anfrage ohne Anmeldung). Sonst bliebe genau der Beweis eines Fehlers als
 * Altlast für den nächsten Lauf liegen und verfälschte dessen Zählung.
 */
async function aufraeumen(): Promise<void> {
  const db = testDb();
  if (!db) return;
  await db.messageThread.deleteMany({ where: { subject: { startsWith: MARKE } } });
  await db.quote.deleteMany({ where: { title: { startsWith: MARKE } } });
  await db.lead.deleteMany({ where: { email: { endsWith: KONTO_DOMAIN } } });

  const konten = await db.user.findMany({ where: { email: { endsWith: KONTO_DOMAIN } }, select: { id: true } });
  const ids = konten.map((konto) => konto.id);
  if (ids.length > 0) {
    // Protokollzeilen hängen mit `SET NULL` am Konto. Ohne dieses Löschen
    // blieben sie als herrenlose Einträge über ein Konto stehen, das es nie
    // gab — und die Sicherheitsübersicht zählte sie mit.
    await db.securityEvent.deleteMany({ where: { userId: { in: ids } } });
    await db.auditLog.deleteMany({ where: { OR: [{ userId: { in: ids } }, { entityId: { in: ids } }] } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
  }
}

before(async () => {
  await requireServer();
  jars = await loginAll();
  await aufraeumen();
});

after(async () => {
  await aufraeumen();
  await testDbSchliessen();
});

// ===========================================================================
//  A) Ohne Anmeldung
// ===========================================================================

type Methode = 'GET' | 'POST' | 'PATCH' | 'DELETE';

interface Endpunkt {
  bereich: string;
  methode: Methode;
  pfad: string;
  body?: unknown;
}

/**
 * Lesende **und** schreibende Wege je Bereich. Die Körper sind gültig
 * gemeint: Fiele die Anmeldepflicht weg, soll der Aufruf durchlaufen können
 * — nur dann sagt die Spurensuche danach etwas aus.
 */
const OHNE_ANMELDUNG: Endpunkt[] = [
  // Offerten
  { bereich: 'Offerten', methode: 'GET', pfad: '/api/quotes' },
  {
    bereich: 'Offerten',
    methode: 'POST',
    pfad: '/api/quotes',
    body: {
      customerId: GIBT_ES_NICHT,
      title: `${MARKE_ANONYM} Offerte`,
      validUntil: inTagen(30),
      items: [{ name: 'Unterhaltsreinigung', quantity: 1, unit: 'Std.', unitPrice: 60, discount: 0, vatRate: 8.1, optional: false }],
      discountValue: 0,
    },
  },
  { bereich: 'Offerten', methode: 'GET', pfad: `/api/quotes/${GIBT_ES_NICHT}` },
  { bereich: 'Offerten', methode: 'PATCH', pfad: `/api/quotes/${GIBT_ES_NICHT}`, body: { title: `${MARKE_ANONYM} geändert` } },
  { bereich: 'Offerten', methode: 'POST', pfad: `/api/quotes/${GIBT_ES_NICHT}/send`, body: {} },

  // Verträge — samt zwei Zustandswechseln, denn ein Vertrag bindet den
  // Betrieb über Monate, und Aktivieren ist die Zusage nach aussen.
  { bereich: 'Verträge', methode: 'GET', pfad: '/api/contracts' },
  { bereich: 'Verträge', methode: 'POST', pfad: '/api/contracts', body: {} },
  { bereich: 'Verträge', methode: 'GET', pfad: `/api/contracts/${GIBT_ES_NICHT}` },
  { bereich: 'Verträge', methode: 'POST', pfad: `/api/contracts/${GIBT_ES_NICHT}/activate`, body: {} },
  { bereich: 'Verträge', methode: 'POST', pfad: `/api/contracts/${GIBT_ES_NICHT}/pause`, body: {} },

  // Zeiterfassung
  { bereich: 'Zeiterfassung', methode: 'GET', pfad: '/api/time' },
  { bereich: 'Zeiterfassung', methode: 'POST', pfad: '/api/time/clock-in', body: {} },
  { bereich: 'Zeiterfassung', methode: 'POST', pfad: '/api/time/clock-out', body: {} },

  // Lohn
  { bereich: 'Lohn', methode: 'POST', pfad: '/api/payroll/run', body: {} },
  { bereich: 'Lohn', methode: 'GET', pfad: '/api/payroll/payslips' },

  // Gutschriften — beide Schreibwege, der freie und der zur Rechnung.
  { bereich: 'Gutschriften', methode: 'GET', pfad: '/api/credit-notes' },
  {
    bereich: 'Gutschriften',
    methode: 'POST',
    pfad: '/api/credit-notes',
    body: { customerId: GIBT_ES_NICHT, reason: `${MARKE_ANONYM} Gutschrift`, items: [{ name: 'Kulanz', quantity: 1, unitPrice: 10 }] },
  },
  {
    bereich: 'Gutschriften',
    methode: 'POST',
    pfad: `/api/invoices/${GIBT_ES_NICHT}/credit-note`,
    body: { reason: `${MARKE_ANONYM} Gutschrift`, name: 'Kulanz', quantity: 1, unitPrice: 10 },
  },
  { bereich: 'Gutschriften', methode: 'GET', pfad: `/api/credit-notes/${GIBT_ES_NICHT}/pdf` },

  // Nachrichten
  { bereich: 'Nachrichten', methode: 'GET', pfad: '/api/messages' },
  { bereich: 'Nachrichten', methode: 'POST', pfad: '/api/messages', body: { subject: `${MARKE_ANONYM} Verlauf`, body: 'Ohne Anmeldung geschrieben.' } },
  { bereich: 'Nachrichten', methode: 'GET', pfad: `/api/messages/${GIBT_ES_NICHT}` },
  { bereich: 'Nachrichten', methode: 'POST', pfad: `/api/messages/${GIBT_ES_NICHT}`, body: { body: 'Antwort ohne Anmeldung.' } },

  // Anfragen
  { bereich: 'Anfragen', methode: 'GET', pfad: '/api/leads' },
  {
    bereich: 'Anfragen',
    methode: 'POST',
    pfad: '/api/leads',
    body: { firstName: 'Anonym', lastName: 'Zugriffsgrenze', email: `anonym.${RUN}${KONTO_DOMAIN}`, source: 'PHONE', tagIds: [] },
  },
  { bereich: 'Anfragen', methode: 'PATCH', pfad: `/api/leads/${GIBT_ES_NICHT}`, body: { message: 'übernommen' } },

  // Geräteübergabe (Vor-Ort-Abnahme): Zustand, Beginn, Abbruch, Entsperren.
  // Das Entsperren ist der heikelste: Es nimmt ein Passwort entgegen und
  // trägt `allowDuringHandoff` — gerade deshalb muss es ohne Sitzung zu sein.
  { bereich: 'Geräteübergabe', methode: 'GET', pfad: '/api/handoff' },
  { bereich: 'Geräteübergabe', methode: 'POST', pfad: `/api/jobs/${GIBT_ES_NICHT}/handoff`, body: {} },
  { bereich: 'Geräteübergabe', methode: 'DELETE', pfad: `/api/jobs/${GIBT_ES_NICHT}/handoff` },
  { bereich: 'Geräteübergabe', methode: 'POST', pfad: '/api/handoff/unlock', body: { password: 'Irgendein#2026Passwort' } },
];

const b64url = (wert: object) => Buffer.from(JSON.stringify(wert)).toString('base64url');

/**
 * Ein Zugangstoken mit allem, was ein echtes trägt — Rolle SUPER_ADMIN,
 * echte Konto- und Organisationskennung, gültige Laufzeit —, nur mit dem
 * falschen Schlüssel signiert. Prüft, dass die Anwendung die Signatur prüft
 * und nicht nur die Form.
 */
function gefaelschtesToken(sub: string, org: string): string {
  const jetzt = Math.floor(Date.now() / 1000);
  const kopf = b64url({ alg: 'HS256', typ: 'JWT' });
  const nutzlast = b64url({ sub, org, role: 'SUPER_ADMIN', email: ACCOUNTS.super.email, name: 'Gefälschte Sitzung', iat: jetzt, exp: jetzt + 600 });
  const signatur = createHmac('sha256', 'das-ist-nicht-der-schluessel').update(`${kopf}.${nutzlast}`).digest('base64url');
  return `${kopf}.${nutzlast}.${signatur}`;
}

/** Dasselbe ohne Signatur (`alg: none`) — der klassische JWT-Fehlgriff. */
function unsigniertesToken(sub: string, org: string): string {
  const jetzt = Math.floor(Date.now() / 1000);
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ sub, org, role: 'SUPER_ADMIN', email: ACCOUNTS.super.email, name: 'Unsigniert', iat: jetzt, exp: jetzt + 600 })}.`;
}

describe('A) Ohne gültige Anmeldung antworten Offerten, Verträge, Zeit, Lohn, Gutschriften, Nachrichten, Anfragen und Geräteübergabe mit 401', { concurrency: 1 }, () => {
  let falscheJars: { name: string; jar: string }[] = [];

  before(async () => {
    // Die Fälschung soll so echt wie möglich aussehen: echte Kennung der
    // Systemverantwortung, echte Organisation. Ohne Datenbankzugang bleibt
    // es bei Platzhaltern — die Signaturprüfung muss auch dann greifen.
    const db = testDb();
    const superId = db ? ((await db.user.findUnique({ where: { email: ACCOUNTS.super.email }, select: { id: true } }))?.id ?? 'unbekannt') : 'unbekannt';
    const org = (await eigeneOrganisationId()) ?? 'unbekannt';
    falscheJars = [
      { name: 'gefälschte Signatur', jar: `clenaris_at=${gefaelschtesToken(superId, org)}` },
      { name: 'unsigniertes Token', jar: `clenaris_at=${unsigniertesToken(superId, org)}` },
    ];
  });

  for (const endpunkt of OHNE_ANMELDUNG) {
    it(`${endpunkt.bereich}: ${endpunkt.methode} ${endpunkt.pfad.replace(GIBT_ES_NICHT, ':id')} verlangt eine Sitzung — ohne Cookie und mit gefälschtem Token 401`, async () => {
      const varianten: { name: string; jar?: string }[] = [{ name: 'ohne Cookie' }, ...falscheJars];
      for (const variante of varianten) {
        const antwort: ApiResponse<{ data?: unknown }> = await call(endpunkt.methode, endpunkt.pfad, {
          jar: variante.jar,
          ...(endpunkt.body !== undefined ? { body: endpunkt.body } : {}),
        });
        assert.equal(antwort.status, 401, `${variante.name}: HTTP ${antwort.status} — ${antwort.text.slice(0, 200)}`);
        assert.equal(
          (antwort.payload as { data?: unknown } | null)?.data,
          undefined,
          `${variante.name}: eine 401 trägt keine Nutzdaten`,
        );
        // Eine abgewiesene Anfrage darf weder eine Sitzung noch eine
        // Signatursitzung ausstellen — bei der Geräteübergabe setzt der
        // Erfolgsweg genau dieses Cookie.
        assert.ok(!/clenaris_(at|rt|sig)=[^;\s]/.test(antwort.cookies), `${variante.name}: Cookie ausgestellt: ${antwort.cookies}`);
      }
    });
  }

  it('die abgewiesenen Schreibversuche ohne Anmeldung hinterlassen keinen Datensatz', async (t) => {
    const db = testDb();
    if (!db) return t.skip(`kein Zugang zur Testdatenbank: ${testDbGrund()}`);
    assert.equal(await db.lead.count({ where: { email: { endsWith: KONTO_DOMAIN } } }), 0, 'Anfrage ohne Anmeldung entstanden');
    assert.equal(await db.quote.count({ where: { title: { startsWith: MARKE_ANONYM } } }), 0, 'Offerte ohne Anmeldung entstanden');
    assert.equal(await db.messageThread.count({ where: { subject: { startsWith: MARKE_ANONYM } } }), 0, 'Verlauf ohne Anmeldung entstanden');
    assert.equal(await db.creditNote.count({ where: { reason: { startsWith: MARKE_ANONYM } } }), 0, 'Gutschrift ohne Anmeldung entstanden');
  });
});

// ===========================================================================
//  B) Rollengrenzen: Offerten
// ===========================================================================

interface OfferteDetail {
  id: string;
  title: string;
  status: string;
  updatedAt?: string;
  grossTotal?: string | number;
}

describe('B) Mitarbeitende und Kundschaft legen keine Offerten an, ändern und versenden keine (403)', { concurrency: 1 }, () => {
  let offerteId = '';
  let kundeId = '';
  let vorher = '';

  const abbild = (offerte: OfferteDetail) =>
    JSON.stringify({ title: offerte.title, status: offerte.status, updatedAt: offerte.updatedAt, grossTotal: offerte.grossTotal });

  before(async () => {
    // Eine bestehende Offerte, keine eigens angelegte: Die Prüfung soll
    // zeigen, dass ein *echter* Datensatz unberührt bleibt, und sie legt
    // dafür nichts an, das danach wieder weg müsste.
    const liste = data(await get<{ data: { id: string }[] }>('/api/quotes?pageSize=5', { jar: jars.admin }));
    assert.ok(liste?.length, 'keine Offerte in den Demodaten — `npm run db:seed:demo`?');
    offerteId = liste[0]!.id;

    const kunden = data(await get<{ data: { id: string }[] }>('/api/customers?pageSize=1', { jar: jars.admin }));
    assert.ok(kunden?.length, 'keine Kundschaft in den Demodaten');
    kundeId = kunden[0]!.id;

    vorher = abbild(data(await get<{ data: OfferteDetail }>(`/api/quotes/${offerteId}`, { jar: jars.admin })));
  });

  for (const rolle of ['employee', 'customer'] as const) {
    const bezeichnung = rolle === 'employee' ? 'Mitarbeitende' : 'Kundschaft';

    it(`${bezeichnung}: POST /api/quotes → 403 (kein quote:create)`, async () => {
      const antwort = await post(
        '/api/quotes',
        {
          customerId: kundeId,
          title: `${MARKE} Offerte ${rolle}`,
          validUntil: inTagen(30),
          items: [{ name: 'Unterhaltsreinigung', quantity: 2, unit: 'Std.', unitPrice: 60, discount: 0, vatRate: 8.1, optional: false }],
          discountValue: 0,
        },
        { jar: jars[rolle] },
      );
      assert.equal(antwort.status, 403, antwort.text);
    });

    it(`${bezeichnung}: PATCH /api/quotes/:id auf eine bestehende Offerte → 403 (kein quote:update)`, async () => {
      const antwort = await patch(`/api/quotes/${offerteId}`, { title: `${MARKE} übernommen durch ${rolle}` }, { jar: jars[rolle] });
      assert.equal(antwort.status, 403, antwort.text);
    });

    it(`${bezeichnung}: POST /api/quotes/:id/send → 403 (kein quote:send)`, async () => {
      const antwort = await post(`/api/quotes/${offerteId}/send`, { attachPdf: false }, { jar: jars[rolle] });
      assert.equal(antwort.status, 403, antwort.text);
    });
  }

  it('nach allen verweigerten Versuchen ist die Offerte unverändert und keine neue entstanden', async (t) => {
    const nachher = abbild(data(await get<{ data: OfferteDetail }>(`/api/quotes/${offerteId}`, { jar: jars.admin })));
    assert.equal(nachher, vorher, 'Titel, Status, Summe oder Änderungszeit haben sich verschoben');

    const db = testDb();
    if (!db) return t.skip(`kein Zugang zur Testdatenbank: ${testDbGrund()}`);
    assert.equal(await db.quote.count({ where: { title: { startsWith: MARKE } } }), 0, 'eine verweigerte Offerte wurde trotzdem angelegt');
  });
});

// ===========================================================================
//  B) Eigentümerschaft: Nachrichten
// ===========================================================================

describe('B) Nachrichtenverläufe: fremde Kundschaft und nicht zugeteilte Einsätze bleiben verschlossen', { concurrency: 1 }, () => {
  let fremderKundenverlauf = '';
  let fremderEinsatzverlauf = '';
  let eigenerEinsatzverlauf = '';
  let fremderEinsatz = '';

  before(async () => {
    const db = testDb();
    assert.ok(db, `kein Zugang zur Testdatenbank: ${testDbGrund()}`);
    const org = await eigeneOrganisationId();
    assert.ok(org, 'eigene Organisation nicht gefunden');

    /**
     * Ein Verlauf einer **anderen** Kundschaft derselben Organisation.
     *
     * Über HTTP lässt er sich nicht herstellen: `openThread` bindet einen
     * neuen Verlauf an die Kundschaft der *eröffnenden* Sitzung, und das Büro
     * hat keine — es kann einen Verlauf nur zu einem Einsatz eröffnen,
     * nicht im Namen einer Kundin. Im Demobestand hat nur Nicole Wyss ein
     * Konto. Der Verlauf wird deshalb direkt angelegt, für Martin Schneider
     * (Demokundschaft ohne Konto), und am Ende wieder entfernt — dieselbe
     * Ausnahme, die `mandanten.test.ts` für die fremde Organisation macht.
     */
    const nicole = await db.user.findUnique({ where: { email: ACCOUNTS.customer.email }, select: { id: true } });
    assert.ok(nicole, 'Demokonto der Kundschaft fehlt');
    const andereKundschaft =
      (await db.customer.findFirst({ where: { organizationId: org, deletedAt: null, email: 'martin.schneider@example.ch' }, select: { id: true } })) ??
      (await db.customer.findFirst({
        where: { organizationId: org, deletedAt: null, OR: [{ userId: null }, { userId: { not: nicole.id } }] },
        select: { id: true },
      }));
    assert.ok(andereKundschaft, 'keine zweite Kundschaft in den Demodaten');

    fremderKundenverlauf = (
      await db.messageThread.create({
        data: {
          organizationId: org,
          customerId: andereKundschaft.id,
          subject: `${MARKE} Verlauf einer anderen Kundschaft`,
          messages: { create: { authorType: 'CUSTOMER', body: `${MARKE} vertraulicher Inhalt der anderen Kundschaft` } },
        },
      })
    ).id;

    // Einsätze relativ zur Demo-Mitarbeiterin: einer, dem sie nicht
    // zugeteilt ist, und — als Gegenprobe — einer, dem sie zugeteilt ist.
    const anna = await db.employee.findFirst({ where: { user: { email: ACCOUNTS.employee.email } }, select: { id: true } });
    assert.ok(anna, 'Personalakte der Demo-Mitarbeiterin fehlt');

    const fremd = await db.job.findFirst({
      where: { organizationId: org, deletedAt: null, assignments: { none: { employeeId: anna.id } } },
      select: { id: true },
    });
    assert.ok(fremd, 'kein Einsatz ohne Zuteilung der Demo-Mitarbeiterin');
    fremderEinsatz = fremd.id;

    // Die Einsatzverläufe entstehen über den regulären Weg: Das Büro eröffnet
    // sie zu einem Einsatz, wie es die Oberfläche tut.
    const offen = await post<{ data: { id: string } }>(
      '/api/messages',
      { subject: `${MARKE} Verlauf zu fremdem Einsatz`, body: 'Interne Notiz zu einem Einsatz ohne Zuteilung.', jobId: fremderEinsatz },
      { jar: jars.admin },
    );
    assert.equal(offen.status, 201, offen.text);
    fremderEinsatzverlauf = data(offen).id;

    const eigen = await db.job.findFirst({
      where: { organizationId: org, deletedAt: null, assignments: { some: { employeeId: anna.id } } },
      select: { id: true },
    });
    if (eigen) {
      const eigenerVerlauf = await post<{ data: { id: string } }>(
        '/api/messages',
        { subject: `${MARKE} Verlauf zu zugeteiltem Einsatz`, body: 'Notiz zu einem zugeteilten Einsatz.', jobId: eigen.id },
        { jar: jars.admin },
      );
      assert.equal(eigenerVerlauf.status, 201, eigenerVerlauf.text);
      eigenerEinsatzverlauf = data(eigenerVerlauf).id;
    }
  });

  const idsDerListe = async (jar: string) => {
    const antwort = await get<{ data: { id: string }[] }>('/api/messages?status=all', { jar });
    assert.equal(antwort.status, 200, antwort.text);
    return new Set(data(antwort).map((verlauf) => verlauf.id));
  };

  // --- Kundschaft -----------------------------------------------------------

  it('Kundschaft: der Verlauf einer anderen Kundschaft derselben Organisation fehlt in der eigenen Liste', async () => {
    assert.ok(!(await idsDerListe(jars.customer)).has(fremderKundenverlauf), 'fremder Verlauf in der Kundenliste');
    // Gegenprobe: Das Büro sieht ihn — sonst bewiese die Zeile oben nur,
    // dass der Verlauf gar nicht existiert.
    assert.ok((await idsDerListe(jars.admin)).has(fremderKundenverlauf), 'das Büro sieht den Verlauf nicht');
  });

  it('Kundschaft: GET /api/messages/:id auf den Verlauf einer anderen Kundschaft → 404 (wie „nicht vorhanden", C19), ohne Inhalt', async () => {
    const antwort = await get(`/api/messages/${fremderKundenverlauf}`, { jar: jars.customer });
    assert.equal(antwort.status, 404, antwort.text);
    assert.ok(!antwort.text.includes('vertraulicher Inhalt'), 'Nachrichtentext in der Ablehnung');
    assert.ok(!antwort.text.includes('Verlauf einer anderen Kundschaft'), 'Betreff in der Ablehnung');
  });

  it('Kundschaft: POST /api/messages/:id in den Verlauf einer anderen Kundschaft → 404 (wie „nicht vorhanden", C19), und es entsteht keine Nachricht', async () => {
    const antwort = await post(`/api/messages/${fremderKundenverlauf}`, { body: 'Untergeschobene Antwort' }, { jar: jars.customer });
    assert.equal(antwort.status, 404, antwort.text);
    const db = testDb()!;
    assert.equal(await db.message.count({ where: { threadId: fremderKundenverlauf } }), 1, 'die Antwort entstand trotzdem');
  });

  // --- Mitarbeitende --------------------------------------------------------

  it('Mitarbeitende: Verläufe ohne zugeteilten Einsatz fehlen in der eigenen Liste', async () => {
    const eigene = await idsDerListe(jars.employee);
    assert.ok(!eigene.has(fremderEinsatzverlauf), 'Verlauf zu einem fremden Einsatz sichtbar');
    assert.ok(!eigene.has(fremderKundenverlauf), 'Kundenverlauf ohne Einsatzbezug sichtbar');
  });

  it('Mitarbeitende: GET /api/messages/:id auf einen Verlauf zu einem nicht zugeteilten Einsatz → 404 (wie „nicht vorhanden", C19)', async () => {
    const antwort = await get(`/api/messages/${fremderEinsatzverlauf}`, { jar: jars.employee });
    assert.equal(antwort.status, 404, antwort.text);
    assert.ok(!antwort.text.includes('Interne Notiz'), 'Nachrichtentext in der Ablehnung');
  });

  it('Mitarbeitende: GET /api/messages/:id auf einen Kundenverlauf ohne Einsatzbezug → 404 (wie „nicht vorhanden", C19)', async () => {
    const antwort = await get(`/api/messages/${fremderKundenverlauf}`, { jar: jars.employee });
    assert.equal(antwort.status, 404, antwort.text);
  });

  it('Mitarbeitende: POST /api/messages/:id in einen Verlauf zu einem nicht zugeteilten Einsatz → 404 (wie „nicht vorhanden", C19), ohne neue Nachricht', async () => {
    const antwort = await post(`/api/messages/${fremderEinsatzverlauf}`, { body: 'Antwort ohne Zuteilung' }, { jar: jars.employee });
    assert.equal(antwort.status, 404, antwort.text);
    const db = testDb()!;
    assert.equal(await db.message.count({ where: { threadId: fremderEinsatzverlauf } }), 1, 'die Antwort entstand trotzdem');
  });

  it('Mitarbeitende: POST /api/messages zu einem nicht zugeteilten Einsatz → 404, kein Verlauf entsteht', async () => {
    // 404 statt 403: `openThread` sucht den Einsatz mit der Zuteilung in der
    // Bedingung — ein fremder Einsatz wird schlicht nicht gefunden, und die
    // Antwort bestätigt nicht einmal, dass es ihn gibt.
    const betreff = `${MARKE} Eröffnung durch Mitarbeitende`;
    const antwort = await post('/api/messages', { subject: betreff, body: 'Ohne Zuteilung eröffnet.', jobId: fremderEinsatz }, { jar: jars.employee });
    assert.equal(antwort.status, 404, antwort.text);
    const db = testDb()!;
    assert.equal(await db.messageThread.count({ where: { subject: betreff } }), 0, 'der Verlauf entstand trotzdem');
  });

  it('Gegenprobe: den Verlauf zu einem zugeteilten Einsatz lesen Mitarbeitende (200)', async (t) => {
    // Ohne diese Probe bewiesen die 403 oben nur, dass Mitarbeitende gar
    // keinen Verlauf lesen können — eine kaputte Funktion, keine Grenze.
    if (!eigenerEinsatzverlauf) return t.skip('die Demo-Mitarbeiterin ist keinem Einsatz zugeteilt');
    const antwort = await get(`/api/messages/${eigenerEinsatzverlauf}`, { jar: jars.employee });
    assert.equal(antwort.status, 200, antwort.text);
    assert.ok((await idsDerListe(jars.employee)).has(eigenerEinsatzverlauf), 'der eigene Verlauf fehlt in der Liste');
  });
});

// ===========================================================================
//  C) Zweiter Faktor über Kontogrenzen und im Protokoll
// ===========================================================================

interface Konto {
  id: string;
  email: string;
  secret: string;
  recoveryCodes: string[];
}

/**
 * Der aktuelle Code eines Kontos, der garantiert **nicht** zufällig auch für
 * das andere Konto gilt.
 *
 * Sechs Ziffern, drei Zeitfenster (der Server nimmt ±30 Sekunden an): Die
 * Wahrscheinlichkeit einer Übereinstimmung liegt bei drei zu einer Million.
 * Klein, aber eine Prüfung, die einmal im Jahr aus Zufall rot wird, ist eine,
 * der man danach nicht mehr glaubt. Trifft es, wird das nächste Fenster
 * abgewartet.
 */
async function codeNurFuer(konto: Konto, anderes: Konto): Promise<string> {
  for (let versuch = 0; versuch < 3; versuch += 1) {
    const jetzt = Date.now();
    const code = totp(konto.secret, jetzt);
    const fremdeFenster = [-30_000, 0, 30_000].map((versatz) => totp(anderes.secret, jetzt + versatz));
    if (!fremdeFenster.includes(code)) return code;
    await sleep(30_000 - (jetzt % 30_000) + 250);
  }
  throw new Error('drei Zeitfenster hintereinander mit gleichem Code — das ist kein Zufall mehr');
}

describe('C) Zwei-Faktor-Anmeldung: kein Code über Kontogrenzen, jede Zustandsänderung im Protokoll', { concurrency: 1 }, () => {
  const a: Konto = { id: '', email: `a.${RUN}${KONTO_DOMAIN}`, secret: '', recoveryCodes: [] };
  const b: Konto = { id: '', email: `b.${RUN}${KONTO_DOMAIN}`, secret: '', recoveryCodes: [] };
  let superId = '';
  let jarA = '';
  let scheinA = '';
  let codeVonB = '';

  before(async () => {
    const db = testDb();
    assert.ok(db, `kein Zugang zur Testdatenbank: ${testDbGrund()}`);
    const org = await eigeneOrganisationId();
    assert.ok(org, 'eigene Organisation nicht gefunden');

    // Die Anmeldewege liegen hinter dem strengen Anmeldelimit; diese Reihe
    // fährt sie mehrfach an und soll mit vollem Kontingent beginnen.
    resetRateLimits();

    /**
     * Zwei Wegwerfkonten statt der Demokonten.
     *
     * Die Demokonten teilen alle Dateien über den Sitzungs-Cache. Ein
     * eingeschalteter Faktor, der nach einem Abbruch stehen bliebe, legte
     * die ganze folgende Reihe lahm (`loginAs` verweigert Konten mit
     * zweitem Faktor). Konten dieser Domain räumt `aufraeumen()` vor und nach
     * dem Lauf vollständig weg — samt Protokollzeilen.
     */
    const { hashPassword } = await import('../../src/lib/auth/password');
    const passwordHash = await hashPassword(KONTO_PASSWORT);
    for (const [konto, name] of [[a, 'A'], [b, 'B']] as const) {
      const user = await db.user.create({
        data: { organizationId: org, email: konto.email, passwordHash, firstName: 'Zugriff', lastName: `Konto ${name}`, role: 'CUSTOMER', status: 'ACTIVE' },
        select: { id: true },
      });
      konto.id = user.id;
    }

    const systemverantwortung = await db.user.findUnique({ where: { email: ACCOUNTS.super.email }, select: { id: true } });
    assert.ok(systemverantwortung, 'Konto der Systemverantwortung fehlt');
    superId = systemverantwortung.id;
  });

  const einschalten = async (konto: Konto): Promise<string> => {
    const anmeldung = await login(konto.email, KONTO_PASSWORT);
    assert.equal(anmeldung.status, 200, anmeldung.text);
    assert.notEqual(anmeldung.payload?.data?.twoFactorRequired, true, 'frisches Konto ohne Faktor');
    const jar = anmeldung.jar;

    const setup = await post<{ data: { secret: string } }>('/api/auth/2fa/setup', undefined, { jar });
    assert.equal(setup.status, 200, setup.text);
    konto.secret = data(setup).secret;

    const confirm = await post<{ data: { recoveryCodes: string[] } }>('/api/auth/2fa/confirm', { token: totp(konto.secret) }, { jar });
    assert.equal(confirm.status, 200, confirm.text);
    konto.recoveryCodes = data(confirm).recoveryCodes;
    return jar;
  };

  it('Einschalten schreibt einen Protokolleintrag und das Sicherheitsereignis TWO_FACTOR_ENABLED', async () => {
    jarA = await einschalten(a);
    await einschalten(b);

    const db = testDb()!;
    for (const konto of [a, b]) {
      const eintrag = await db.auditLog.findFirst({
        where: { entity: 'User', entityId: konto.id, action: 'PERMISSION_CHANGE', summary: { contains: 'eingeschaltet' } },
        select: { userId: true },
      });
      assert.ok(eintrag, `kein Protokolleintrag für das Einschalten (${konto.email})`);
      assert.equal(eintrag.userId, konto.id, 'das Konto selbst hat eingeschaltet');
      assert.equal(
        await db.securityEvent.count({ where: { userId: konto.id, kind: 'TWO_FACTOR_ENABLED' } }),
        1,
        `kein Sicherheitsereignis TWO_FACTOR_ENABLED (${konto.email})`,
      );
    }
  });

  it('der Zwischenschein von A lässt sich mit dem gültigen Code von B nicht einlösen (401, keine Sitzung)', async () => {
    const schritt1 = await login(a.email, KONTO_PASSWORT);
    assert.equal(schritt1.status, 200, schritt1.text);
    assert.equal(schritt1.payload.data.twoFactorRequired, true);
    scheinA = schritt1.jar;

    codeVonB = await codeNurFuer(b, a);
    const fremd = await post('/api/auth/2fa/verify', { token: codeVonB }, { jar: scheinA });
    assert.equal(fremd.status, 401, fremd.text);
    assert.ok(!/clenaris_at=[^;\s]/.test(fremd.cookies), 'trotz fremdem Code wurde ein Zugangstoken ausgestellt');

    // Der Fehlversuch zählt beim Konto, dessen Schein benutzt wurde — dort
    // soll die Sicherheitsübersicht „Passwort bekannt, Faktor falsch" zeigen.
    // B hat nichts falsch gemacht und darf keinen Eintrag bekommen.
    const db = testDb()!;
    assert.equal(await db.securityEvent.count({ where: { userId: a.id, kind: 'TWO_FACTOR_FAILED' } }), 1, 'Fehlversuch nicht bei A');
    assert.equal(await db.securityEvent.count({ where: { userId: b.id, kind: 'TWO_FACTOR_FAILED' } }), 0, 'Fehlversuch B zugeschrieben');
    assert.ok(
      await db.auditLog.findFirst({ where: { entity: 'User', entityId: a.id, action: 'ACCESS_DENIED', summary: { contains: 'Zweiter Faktor' } } }),
      'kein ACCESS_DENIED-Eintrag für A',
    );
  });

  it('derselbe Code öffnet die Anmeldung von B — er war gültig, nur nicht für A', async () => {
    // Ohne diese Probe könnte die 401 oben auch ein schlicht ungültiger Code
    // gewesen sein; dann hätte der Test die Kontogrenze gar nicht geprüft.
    const schritt1 = await login(b.email, KONTO_PASSWORT);
    assert.equal(schritt1.payload.data.twoFactorRequired, true);
    const eigen = await post<{ data: { id: string } }>('/api/auth/2fa/verify', { token: codeVonB }, { jar: schritt1.jar });
    assert.equal(eigen.status, 200, eigen.text);
    assert.equal(data(eigen).id, b.id);
  });

  it('der Zwischenschein von A lässt sich auch mit einem Wiederherstellungscode von B nicht einlösen', async () => {
    const fremd = await post('/api/auth/2fa/verify', { token: b.recoveryCodes[0] }, { jar: scheinA });
    assert.equal(fremd.status, 401, fremd.text);
    assert.ok(!/clenaris_at=[^;\s]/.test(fremd.cookies));

    // Und der Code von B ist dabei nicht verbraucht worden: Ein fremder
    // Fehlversuch darf den Vorrat eines anderen Kontos nicht anfassen.
    const db = testDb()!;
    const vorrat = await db.user.findUniqueOrThrow({ where: { id: b.id }, select: { twoFactorRecoveryCodes: true } });
    assert.equal(vorrat.twoFactorRecoveryCodes.length, 10);
  });

  it('der Zwischenschein von B lässt sich mit dem gültigen Code von A nicht einlösen', async () => {
    const schritt1 = await login(b.email, KONTO_PASSWORT);
    assert.equal(schritt1.payload.data.twoFactorRequired, true);
    const fremd = await post('/api/auth/2fa/verify', { token: await codeNurFuer(a, b) }, { jar: schritt1.jar });
    assert.equal(fremd.status, 401, fremd.text);
    assert.ok(!/clenaris_at=[^;\s]/.test(fremd.cookies));
  });

  it('der Zwischenschein taugt nicht als Zugangstoken, auch nicht ins Sitzungscookie umgefüllt', async () => {
    /**
     * Der Schein ist mit demselben Schlüssel signiert wie ein Zugangstoken
     * (`issueMfaChallenge` nutzt `signAccessToken`). Wer ihn aus
     * `clenaris_mfa` in `clenaris_at` umfüllt, hält also ein gültig
     * signiertes Token. Dass es trotzdem nichts öffnet, verdankt sich heute
     * dem Organisationsvergleich in `getSession` (`org: 'mfa-pending'`) —
     * diese Prüfung hält fest, dass es so bleibt, falls jemand dort etwas
     * lockert.
     */
    const schein = cookieValue(scheinA, 'clenaris_mfa');
    assert.ok(schein, 'kein Zwischenschein im Cookie');
    const umgefuellt = `clenaris_at=${schein}`;

    assert.equal((await get('/api/auth/2fa', { jar: umgefuellt })).status, 401);
    assert.equal((await get('/api/messages', { jar: umgefuellt })).status, 401);
    const sitzung = await get<{ data: { authenticated: boolean } }>('/api/auth/session', { jar: umgefuellt });
    assert.notEqual(sitzung.payload?.data?.authenticated, true, 'der Zwischenschein gilt als Sitzung');
  });

  it('Gegenprobe: der Zwischenschein von A bleibt an A gebunden und öffnet mit dem Code von A die Sitzung von A', async () => {
    const eigen = await post<{ data: { id: string } }>('/api/auth/2fa/verify', { token: await codeNurFuer(a, b) }, { jar: scheinA });
    assert.equal(eigen.status, 200, eigen.text);
    assert.equal(data(eigen).id, a.id, 'die Sitzung gehört einem anderen Konto');
    assert.match(eigen.cookies, /clenaris_at=[^;\s]/);
    jarA = eigen.cookies;
  });

  it('Ausschalten schreibt einen Protokolleintrag und das Sicherheitsereignis TWO_FACTOR_DISABLED', async () => {
    const aus = await post('/api/auth/2fa/disable', { password: KONTO_PASSWORT, token: totp(a.secret) }, { jar: jarA });
    assert.equal(aus.status, 204, aus.text);

    const db = testDb()!;
    const eintrag = await db.auditLog.findFirst({
      where: { entity: 'User', entityId: a.id, action: 'PERMISSION_CHANGE', summary: { contains: 'ausgeschaltet' } },
      select: { userId: true },
    });
    assert.ok(eintrag, 'kein Protokolleintrag für das Ausschalten');
    assert.equal(eintrag.userId, a.id);
    assert.equal(await db.securityEvent.count({ where: { userId: a.id, kind: 'TWO_FACTOR_DISABLED' } }), 1, 'kein TWO_FACTOR_DISABLED');
  });

  it('Rücksetzung durch die Systemverantwortung: Protokolleintrag mit handelnder Person, TWO_FACTOR_DISABLED und SESSIONS_REVOKED beim betroffenen Konto', async () => {
    const reset = await del(`/api/users/${b.id}/2fa`, { jar: jars.super });
    assert.equal(reset.status, 204, reset.text);

    const db = testDb()!;
    const eintrag = await db.auditLog.findFirst({
      where: { entity: 'User', entityId: b.id, action: 'PERMISSION_CHANGE', summary: { contains: 'zurückgesetzt' } },
      select: { userId: true },
    });
    assert.ok(eintrag, 'kein Protokolleintrag für die Rücksetzung');
    // Im Prüfprotokoll steht, *wer* gehandelt hat — die Systemverantwortung,
    // nicht das betroffene Konto. Umgekehrt bei den Sicherheitsereignissen:
    // Sie hängen am betroffenen Konto, damit die Übersicht je Konto beide zeigt.
    assert.equal(eintrag.userId, superId, 'die handelnde Person fehlt im Protokoll');

    const arten = (await db.securityEvent.findMany({ where: { userId: b.id }, select: { kind: true } })).map((e) => e.kind);
    assert.ok(arten.includes('TWO_FACTOR_DISABLED'), `kein TWO_FACTOR_DISABLED bei B: ${arten.join(', ')}`);
    assert.ok(arten.includes('SESSIONS_REVOKED'), `kein SESSIONS_REVOKED bei B: ${arten.join(', ')}`);

    // Der alte Stand muss wirklich weg sein, nicht nur protokolliert.
    const zustand = await db.user.findUniqueOrThrow({ where: { id: b.id }, select: { twoFactorEnabled: true, twoFactorSecret: true } });
    assert.equal(zustand.twoFactorEnabled, false);
    assert.equal(zustand.twoFactorSecret, null);
  });
});
