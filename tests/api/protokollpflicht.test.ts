import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { GESCHWAERZT, istSensiblerSchluessel } from '../../src/lib/sensitive-fields';
import { BASE_URL, data, del, get, patch, post, requireServer } from '../helpers/client';
import { ACCOUNTS, login, loginAll, type AccountName } from '../helpers/accounts';
import { zuercherHeute } from '../helpers/datum';
import { alleMails } from '../helpers/mail';
import { eigeneOrganisationId, schutzfreiAufraeumen, testDb, testDbGrund, testDbSchliessen } from '../helpers/testdb';
import { totp } from '../helpers/totp';

/**
 * Protokollpflicht — jede heikle Handlung hinterlässt eine Zeile in
 * `audit_logs`, und diese Zeile verrät kein Geheimnis.
 *
 * ---------------------------------------------------------------------------
 *  Warum es diese Datei gibt
 * ---------------------------------------------------------------------------
 *
 * Die Regel steht in `CLAUDE.md` und in `src/lib/audit.ts`: Mutationen laufen
 * durch die Route Handler, weil dort — und nur dort — Rechte, Prüfung,
 * Kontingent **und das Prüfprotokoll** sitzen. Geprüft wurde sie bisher nur
 * stichprobenweise: `protokoll-schwaerzung` an der Personalakte,
 * `protokoll-und-schranken` am Zugangslink und an der Zuteilung,
 * `release-center` an den Freigaben. Ob die Offerte, die Rechnung, die
 * Zahlung, der Vertrag oder die geöffnete Nachricht protokolliert wird, sagte
 * keine Prüfung. Ein fehlender `audit.*`-Aufruf fällt im Alltag nicht auf —
 * die Handlung gelingt ja —, sondern erst, wenn jemand nach einem Vorfall
 * fragt, wer eine Rechnung storniert hat, und die Antwort fehlt.
 *
 * ---------------------------------------------------------------------------
 *  Was je Handlung geprüft wird
 * ---------------------------------------------------------------------------
 *
 *  • Die Handlung läuft über echtes HTTP mit den Demositzungen — nie über
 *    einen direkten Dienstaufruf. Ein Test, der `issueInvoice()` aufriefe,
 *    bewiese nicht, dass die Route den Dienst mit der handelnden Person
 *    aufruft.
 *  • Danach ein Blick in `audit_logs`: **neue** Zeile (vorher/nachher, nicht
 *    „irgendeine"), richtige Entität, richtige Kennung, richtige Handlung,
 *    richtige Person, eigene Organisation. Eine Zeile ohne Kennung lässt sich
 *    im Protokoll nicht zum Datensatz zurückverfolgen — sie gilt hier als
 *    fehlend, nicht als halbe Erfüllung.
 *  • Und dieselbe Zeile als Text gegen alles, was nie darin stehen darf:
 *    Passwörter der Prüfkonten, JWT, Passwort-Hashes, Sitzungscookies, rohe
 *    Zugangstoken und ihre SHA-256-Hashes (jeder 64-stellige Hexwert, der
 *    nicht ausdrücklich eine Dateiprüfsumme ist), das TOTP-Geheimnis und die
 *    Wiederherstellungscodes, und jeder sensible Schlüssel in `changes`, der
 *    nicht geschwärzt ist.
 *
 * ---------------------------------------------------------------------------
 *  Was hier absichtlich nicht abgeschwächt wird
 * ---------------------------------------------------------------------------
 *
 * Einige Handlungen protokollieren heute nicht oder nicht auffindbar (die
 * Nachricht, der Mahnlauf, die Umwandlung in eine bestehende Kundschaft, die
 * Zeitfreigabe als Sammeleintrag ohne Kennung, die Veröffentlichung von
 * Website-Texten ohne Bezug zum Baustein). Die Prüfungen verlangen trotzdem die
 * Zeile. Eine Prüfung, die sich dem Ist-Zustand anpasst, hielte genau den
 * Befund fest, den sie aufdecken soll — sie wäre grün und falsch.
 *
 * ---------------------------------------------------------------------------
 *  Aufräumen
 * ---------------------------------------------------------------------------
 *
 * Jeder Bereich räumt vor und nach sich auf, gefunden über eine Marke im
 * Titel, in der Notiz oder im Namen — nie über die Laufnummer, damit auch die
 * Reste eines abgebrochenen Laufs verschwinden. Ausgestellte Rechnungen,
 * Zahlungen, Gutschriften und Mahnungen verweigern Anwendung und Datenbank zu
 * Recht jede Löschung; sie gehen an den Triggern vorbei weg
 * (`schutzfreiAufraeumen`, wie in `finanzbelege.test.ts`). Ein Vertrag, der in
 * Kraft war, wird beendet statt gelöscht (`vertraege.test.ts`). Die
 * Protokollzeilen selbst bleiben stehen: Ein Prüfprotokoll, aus dem die
 * Prüfreihe Zeilen entfernt, wäre kein Prüfprotokoll mehr.
 *
 * Die Zwei-Faktor-Prüfung steht zuletzt. Die Rücksetzung durch die
 * Systemverantwortung beendet alle Sitzungen der Betriebsleitung — auch das
 * zwischengespeicherte Cookie, das die übrigen Bereiche dieser Datei benutzen.
 */

const RUN = Date.now();
const db = testDb();
const ohneDb = db ? false : `kein Zugang zur Testdatenbank: ${testDbGrund()}`;

/** Die gemeinsame Marke — jeder Bereich hängt seinen Namen an. */
const MARKE = 'Prüfreihe Protokollpflicht';
const MARKE_OFFERTE = `${MARKE} Offerte`;
const MARKE_VERTRAG = `${MARKE} Vertrag`;
const MARKE_ZEIT = `${MARKE} Zeit`;
const MARKE_RECHNUNG = `${MARKE} Rechnung`;
const MARKE_DATEI = 'protokollpflicht-';
const MARKE_DOKUMENT = `${MARKE} Dokument`;
const MARKE_NACHRICHT = `${MARKE} Nachricht`;
const MARKE_ANFRAGE = 'Protokollpflicht';
const ANFRAGE_EMAIL_PRAEFIX = 'pruef.protokollpflicht.';
const MARKE_REGEL = `${MARKE} Regel`;

let jars: Record<AccountName, string>;

/** Stammdaten aus dem Demobestand — gelesen, nie verändert. */
const stamm = {
  org: '',
  kundeId: '',
  kundeEmail: '',
  objektId: '',
  leistungId: '',
  employeeId: '',
  nutzer: {} as Record<AccountName, string>,
};

// ---------------------------------------------------------------------------
//  Werkzeuge
// ---------------------------------------------------------------------------

type Db = NonNullable<ReturnType<typeof testDb>>;
type Eintrag = Awaited<ReturnType<Db['auditLog']['findMany']>>[number];

// Der Zürcher Kalendertag, wie ihn die Dienste nehmen (`tests/helpers/datum.ts`).
const heute = zuercherHeute();
const tagIn = (tage: number) =>
  new Date(Date.UTC(heute.getUTCFullYear(), heute.getUTCMonth(), heute.getUTCDate() + tage)).toISOString().slice(0, 10);

async function eintraegeZu(entity: string, entityId?: string): Promise<Eintrag[]> {
  return db!.auditLog.findMany({
    where: { entity, ...(entityId !== undefined ? { entityId } : {}) },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * Die Zeilen, die **während** einer Handlung entstanden sind.
 *
 * Vorher/nachher über die Kennungen der Zeilen, nicht über einen Zeitstempel:
 * Die Uhr des Prüfprozesses und die der Datenbank müssen nicht übereinstimmen,
 * und eine Zeile aus einem früheren Lauf („irgendwann wurde diese Offerte
 * einmal versendet") darf nicht als Beleg für diesen Lauf durchgehen.
 */
async function beobachten<T>(
  filter: { entity: string; entityId?: string },
  handlung: () => Promise<T>,
): Promise<{ ergebnis: T; neu: Eintrag[] }> {
  const vorher = new Set((await eintraegeZu(filter.entity, filter.entityId)).map((e) => e.id));
  const ergebnis = await handlung();
  const neu = (await eintraegeZu(filter.entity, filter.entityId)).filter((e) => !vorher.has(e.id));
  return { ergebnis, neu };
}

interface Erwartung {
  entity: string;
  entityId: string;
  action: string;
  userId: string | null;
  summary?: RegExp;
}

const kurz = (eintraege: Eintrag[]) =>
  JSON.stringify(eintraege.map((e) => ({ entity: e.entity, entityId: e.entityId, action: e.action, summary: e.summary })));

/**
 * Genau die erwartete Zeile — oder ein Fehlschlag, der sagt, was stattdessen
 * da ist. Organisation und Person werden an der gefundenen Zeile geprüft,
 * nicht als Filter: Eine Zeile mit falscher Person soll als „falsche Person"
 * scheitern, nicht als „fehlt".
 */
function erwarteEintrag(eintraege: Eintrag[], erwartet: Erwartung, vorgang: string): Eintrag {
  const passend = eintraege.filter(
    (e) =>
      e.entity === erwartet.entity &&
      e.entityId === erwartet.entityId &&
      e.action === erwartet.action &&
      (!erwartet.summary || erwartet.summary.test(e.summary ?? '')),
  );
  assert.ok(
    passend.length > 0,
    `${vorgang}: keine Protokollzeile ${erwartet.entity}/${erwartet.action} zu ${erwartet.entityId}` +
      `${erwartet.summary ? ` (${erwartet.summary})` : ''} — vorhanden: ${kurz(eintraege)}`,
  );
  const eintrag = passend.at(-1)!;
  assert.equal(eintrag.organizationId, stamm.org, `${vorgang}: Protokollzeile in einer fremden Organisation`);
  assert.equal(eintrag.userId, erwartet.userId, `${vorgang}: falsche handelnde Person im Protokoll`);
  return eintrag;
}

const HEX64 = /\b[0-9a-f]{64}\b/gi;

/**
 * Sensible Schlüssel in `changes` müssen geschwärzt sein — als Wert oder in
 * der `diff`-Form `{ from, to }`. Die Tatsache der Änderung darf sichtbar
 * bleiben (so will es `diff()` in `src/lib/audit.ts`), der Inhalt nicht.
 */
function sensibleSchluesselGeschwaerzt(wert: unknown, entity: string, pfad: string): void {
  if (wert === null || typeof wert !== 'object') return;
  if (Array.isArray(wert)) {
    wert.forEach((w, i) => sensibleSchluesselGeschwaerzt(w, entity, `${pfad}[${i}]`));
    return;
  }
  for (const [schluessel, inhalt] of Object.entries(wert as Record<string, unknown>)) {
    if (istSensiblerSchluessel(schluessel, entity)) {
      const alsDiff = inhalt as { from?: unknown; to?: unknown } | null;
      const geschwaerzt =
        inhalt === GESCHWAERZT ||
        (alsDiff !== null && typeof alsDiff === 'object' && alsDiff.from === GESCHWAERZT && alsDiff.to === GESCHWAERZT);
      assert.ok(geschwaerzt, `${entity}: „${pfad}.${schluessel}" steht ungeschwärzt im Protokoll: ${JSON.stringify(inhalt)}`);
      continue;
    }
    sensibleSchluesselGeschwaerzt(inhalt, entity, `${pfad}.${schluessel}`);
  }
}

/**
 * Nichts, was ein Geheimnis ist, steht in der Zeile — geprüft am ganzen Text
 * von Zusammenfassung, Änderungen und User-Agent, nicht Feld für Feld. Ein
 * Token in einem unerwarteten Feld wäre sonst unsichtbar.
 *
 * `erlaubteHex` nimmt ausdrücklich benannte Prüfsummen aus (die SHA-256 einer
 * hochgeladenen Datei ist eine Aussage über öffentliche Bytes, kein
 * Schlüssel); jeder andere 64-stellige Hexwert gilt als Token oder Hash.
 */
function keineGeheimnisse(
  eintraege: Eintrag[],
  vorgang: string,
  opts: { geheimnisse?: (string | null | undefined)[]; erlaubteHex?: string[] } = {},
): void {
  const erlaubt = new Set((opts.erlaubteHex ?? []).map((h) => h.toLowerCase()));
  for (const eintrag of eintraege) {
    const text = JSON.stringify({ summary: eintrag.summary, changes: eintrag.changes, userAgent: eintrag.userAgent });
    for (const geheimnis of opts.geheimnisse ?? []) {
      if (!geheimnis || geheimnis.length < 6) continue;
      assert.ok(!text.includes(geheimnis), `${vorgang}: ein Geheimnis steht im Protokoll (${geheimnis.slice(0, 6)}…)`);
    }
    for (const konto of Object.values(ACCOUNTS)) {
      assert.ok(!text.includes(konto.password), `${vorgang}: ein Passwort steht im Protokoll`);
    }
    assert.doesNotMatch(text, /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, `${vorgang}: ein JWT steht im Protokoll`);
    assert.doesNotMatch(text, /\$argon2|\$2[aby]\$\d/, `${vorgang}: ein Passwort-Hash steht im Protokoll`);
    assert.doesNotMatch(text, /clenaris_(at|rt|mfa)=/, `${vorgang}: ein Sitzungscookie steht im Protokoll`);
    const hex = (text.match(HEX64) ?? []).filter((h) => !erlaubt.has(h.toLowerCase()));
    assert.deepEqual(hex, [], `${vorgang}: ein 64-stelliger Hexwert (Token oder Hash) steht im Protokoll`);
    sensibleSchluesselGeschwaerzt(eintrag.changes, eintrag.entity, 'changes');
  }
}

/**
 * Die Tokenhashes, die für eine Ressource ausgestellt wurden, und die rohen
 * Werte, die tatsächlich verschickt wurden (aus dem Postausgang des
 * Testservers — ohne ihn bleiben die Hashes, und die allgemeine
 * Hexwert-Prüfung deckt den Rest).
 */
async function zugangsgeheimnisse(resourceId: string): Promise<string[]> {
  const hashes = (await db!.publicAccessToken.findMany({ where: { resourceId }, select: { tokenHash: true } })).map(
    (t) => t.tokenHash,
  );
  const roh = alleMails()
    .filter((m) => m.entityId === resourceId)
    .flatMap((m) => m.html.match(HEX64) ?? []);
  return [...hashes, ...roh];
}

// ---------------------------------------------------------------------------
//  Vorbereitung
// ---------------------------------------------------------------------------

before(async () => {
  await requireServer();
  jars = await loginAll();
  if (!db) return;

  stamm.org = (await eigeneOrganisationId()) ?? '';
  assert.ok(stamm.org, 'die eigene Organisation fehlt — `npm run db:test:setup`?');

  for (const name of Object.keys(ACCOUNTS) as AccountName[]) {
    stamm.nutzer[name] = (
      await db.user.findUniqueOrThrow({ where: { email: ACCOUNTS[name].email }, select: { id: true } })
    ).id;
  }

  const kunden = data(await get<{ data: { id: string }[] }>('/api/customers?pageSize=1', { jar: jars.admin }));
  stamm.kundeId = kunden[0]!.id;
  const kunde = await db.customer.findUniqueOrThrow({ where: { id: stamm.kundeId }, select: { email: true } });
  stamm.kundeEmail = kunde.email ?? '';

  // Ein Objekt **dieser** Kundschaft — wie `vertraege.test.ts`.
  const objekte = data(
    await get<{ data: { id: string; customerId: string }[] }>('/api/properties?pageSize=50', { jar: jars.admin }),
  );
  stamm.objektId = objekte.find((o) => o.customerId === stamm.kundeId)?.id ?? objekte[0]!.id;

  stamm.leistungId = data(await get<{ data: { id: string }[] }>('/api/services?pageSize=1', { jar: jars.admin }))[0]!.id;
  stamm.employeeId = data(await get<{ data: { id: string }[] }>('/api/employees', { jar: jars.admin }))[0]!.id;
});

after(async () => {
  await testDbSchliessen();
});

// ===========================================================================
//  Offerten
// ===========================================================================

async function offertenAufraeumen(): Promise<void> {
  if (!db) return;
  const offerten = await db.quote.findMany({ where: { title: { startsWith: MARKE_OFFERTE } }, select: { id: true, deletedAt: true } });
  for (const offerte of offerten) {
    if (!offerte.deletedAt) await del(`/api/quotes/${offerte.id}`, { jar: jars.admin }).catch(() => undefined);
  }
  const ids = offerten.map((o) => o.id);
  if (ids.length === 0) return;
  await db.publicAccessToken.deleteMany({ where: { resourceId: { in: ids } } });
  // Hart löschen wie `besichtigung.test.ts`; hängt doch noch etwas daran,
  // bleibt die Offerte im Papierkorb — das ist ein Rest, kein Fehlschlag.
  await db.quote.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
}

describe('Offerten: anlegen, senden, duplizieren', { concurrency: 1, skip: ohneDb }, () => {
  const s = { quoteId: '', nummer: '' };

  before(offertenAufraeumen);
  after(offertenAufraeumen);

  it('Offerte anlegen: CREATE an der Offerte, mit Verwaltung und Organisation', async () => {
    const antwort = await post<{ data: { id: string; number: string } }>(
      '/api/quotes',
      {
        customerId: stamm.kundeId,
        title: `${MARKE_OFFERTE} ${RUN}`,
        validUntil: tagIn(30),
        items: [{ name: 'Unterhaltsreinigung', quantity: 2, unit: 'Std.', unitPrice: 55, discount: 0, vatRate: 8.1, optional: false }],
        discountValue: 0,
      },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 201, antwort.text);
    s.quoteId = data(antwort).id;
    s.nummer = data(antwort).number;

    const eintraege = await eintraegeZu('Quote', s.quoteId);
    erwarteEintrag(eintraege, { entity: 'Quote', entityId: s.quoteId, action: 'CREATE', userId: stamm.nutzer.admin }, 'Offerte anlegen');
    keineGeheimnisse(eintraege, 'Offerte anlegen');
  });

  it('Offerte senden: UPDATE „versendet" — ohne Link, rohen Token oder Tokenhash', async () => {
    assert.ok(s.quoteId, 'die Offerte aus dem vorigen Schritt fehlt');
    const { ergebnis, neu } = await beobachten({ entity: 'Quote', entityId: s.quoteId }, () =>
      post(`/api/quotes/${s.quoteId}/send`, { attachPdf: false }, { jar: jars.admin }),
    );
    assert.equal(ergebnis.status, 200, ergebnis.text);

    erwarteEintrag(
      neu,
      { entity: 'Quote', entityId: s.quoteId, action: 'UPDATE', userId: stamm.nutzer.admin, summary: /versendet/ },
      'Offerte senden',
    );
    const geheimnisse = await zugangsgeheimnisse(s.quoteId);
    assert.ok(geheimnisse.length > 0, 'Vorbedingung: der Versand hat einen Zugangstoken ausgestellt');
    keineGeheimnisse(neu, 'Offerte senden', { geheimnisse });
  });

  it('Offerte duplizieren: CREATE an der Kopie, mit Verweis auf die Vorlage', async () => {
    assert.ok(s.quoteId);
    const antwort = await post<{ data: { id: string; number: string } }>(`/api/quotes/${s.quoteId}/duplicate`, undefined, {
      jar: jars.admin,
    });
    assert.equal(antwort.status, 201, antwort.text);
    const kopie = data(antwort);

    const eintraege = await eintraegeZu('Quote', kopie.id);
    const eintrag = erwarteEintrag(
      eintraege,
      { entity: 'Quote', entityId: kopie.id, action: 'CREATE', userId: stamm.nutzer.admin },
      'Offerte duplizieren',
    );
    assert.ok(eintrag.summary?.includes(s.nummer), `die Vorlage ${s.nummer} fehlt in der Zusammenfassung: ${eintrag.summary}`);
    keineGeheimnisse(eintraege, 'Offerte duplizieren');
  });
});

// ===========================================================================
//  Verträge
// ===========================================================================

function vertragsentwurf(titel: string) {
  return {
    contract: { customerId: stamm.kundeId, propertyId: stamm.objektId, title: titel, startDate: tagIn(1) },
    version: {
      effectiveFrom: tagIn(1),
      reason: 'Erstfassung der Prüfreihe Protokollpflicht',
      billingCycle: 'MONTHLY',
      paymentTermDays: 30,
      pricingModel: 'FIXED_PERIOD',
      baseAmount: 1200,
      vatRate: 8.1,
      noticePeriodDays: 90,
      renewalType: 'NONE',
    },
    services: [
      { serviceId: stamm.leistungId, label: 'Unterhaltsreinigung Büro', estimatedMinutes: 120, requiredCrewSize: 1, materialsBy: 'PROVIDER' },
    ],
  };
}

/**
 * Wie `vertraege.test.ts`: löschen, wo es ein Entwurf ist; beenden, wo er in
 * Kraft war. Ein gelaufener Vertrag ist ein Beleg — auch in der Prüfreihe.
 */
async function vertraegeAufraeumen(): Promise<void> {
  if (!db) return;
  const vertraege = await db.contract.findMany({
    where: { title: { startsWith: MARKE_VERTRAG }, status: { notIn: ['ENDED', 'CANCELLED'] }, deletedAt: null },
    select: { id: true },
  });
  for (const v of vertraege) {
    const geloescht = await del(`/api/contracts/${v.id}`, { jar: jars.admin }).catch(() => null);
    if (geloescht?.status === 204) continue;
    await post(`/api/contracts/${v.id}/end`, { reason: 'Aufräumen der Prüfreihe Protokollpflicht' }, { jar: jars.admin }).catch(
      () => undefined,
    );
  }
}

async function aktiverVertrag(zusatz: string): Promise<string> {
  const antwort = await post<{ data: { id: string } }>('/api/contracts', vertragsentwurf(`${MARKE_VERTRAG} ${zusatz} ${RUN}`), {
    jar: jars.admin,
  });
  assert.equal(antwort.status, 201, antwort.text);
  const id = data(antwort).id;
  const aktiv = await post(`/api/contracts/${id}/activate`, {}, { jar: jars.admin });
  assert.equal(aktiv.status, 200, aktiv.text);
  return id;
}

describe('Verträge: Zustandswechsel, neue Fassung, Preisanpassung', { concurrency: 1, skip: ohneDb }, () => {
  const s = { vertragId: '' };

  before(vertraegeAufraeumen);
  after(vertraegeAufraeumen);

  it('Vertrag aktivieren: UPDATE am Vertrag mit Zustandswechsel DRAFT → ACTIVE', async () => {
    const antwort = await post<{ data: { id: string } }>('/api/contracts', vertragsentwurf(`${MARKE_VERTRAG} Zustand ${RUN}`), {
      jar: jars.admin,
    });
    assert.equal(antwort.status, 201, antwort.text);
    s.vertragId = data(antwort).id;
    erwarteEintrag(
      await eintraegeZu('Contract', s.vertragId),
      { entity: 'Contract', entityId: s.vertragId, action: 'CREATE', userId: stamm.nutzer.admin },
      'Vertragsentwurf anlegen',
    );

    const { ergebnis, neu } = await beobachten({ entity: 'Contract', entityId: s.vertragId }, () =>
      post(`/api/contracts/${s.vertragId}/activate`, {}, { jar: jars.admin }),
    );
    assert.equal(ergebnis.status, 200, ergebnis.text);
    const eintrag = erwarteEintrag(
      neu,
      { entity: 'Contract', entityId: s.vertragId, action: 'UPDATE', userId: stamm.nutzer.admin, summary: /in Kraft gesetzt/ },
      'Vertrag aktivieren',
    );
    const changes = eintrag.changes as { status?: { from?: string; to?: string } } | null;
    assert.equal(changes?.status?.to, 'ACTIVE', `der Zustandswechsel fehlt in den Änderungen: ${JSON.stringify(eintrag.changes)}`);
    keineGeheimnisse(neu, 'Vertrag aktivieren');
  });

  it('Vertrag pausieren: UPDATE am Vertrag mit Zeitraum und Begründung', async () => {
    assert.ok(s.vertragId);
    const grund = 'Umbau im Objekt, Prüfreihe Protokollpflicht';
    const { ergebnis, neu } = await beobachten({ entity: 'Contract', entityId: s.vertragId }, () =>
      post(`/api/contracts/${s.vertragId}/pause`, { pausedFrom: tagIn(5), pausedUntil: tagIn(20), reason: grund }, { jar: jars.admin }),
    );
    assert.equal(ergebnis.status, 200, ergebnis.text);
    const eintrag = erwarteEintrag(
      neu,
      { entity: 'Contract', entityId: s.vertragId, action: 'UPDATE', userId: stamm.nutzer.admin, summary: /pausiert/ },
      'Vertrag pausieren',
    );
    assert.ok(eintrag.summary?.includes(grund), `die Begründung fehlt: ${eintrag.summary}`);
    keineGeheimnisse(neu, 'Vertrag pausieren');
  });

  it('neue Fassung: CREATE an der Fassung, danach UPDATE am Vertrag beim Inkraftsetzen', async () => {
    const id = await aktiverVertrag('Fassung');
    const fassung = await post<{ data: { id: string; versionNumber: number } }>(
      `/api/contracts/${id}/versions`,
      {
        version: {
          effectiveFrom: tagIn(30),
          reason: 'Neue Fassung der Prüfreihe Protokollpflicht',
          billingCycle: 'MONTHLY',
          paymentTermDays: 30,
          pricingModel: 'FIXED_PERIOD',
          baseAmount: 1350,
          vatRate: 8.1,
          noticePeriodDays: 90,
          renewalType: 'NONE',
        },
      },
      { jar: jars.admin },
    );
    assert.equal(fassung.status, 201, fassung.text);
    const versionId = data(fassung).id;
    const angelegt = await eintraegeZu('ContractVersion', versionId);
    erwarteEintrag(
      angelegt,
      { entity: 'ContractVersion', entityId: versionId, action: 'CREATE', userId: stamm.nutzer.admin },
      'neue Fassung anlegen',
    );
    keineGeheimnisse(angelegt, 'neue Fassung anlegen');

    const { ergebnis, neu } = await beobachten({ entity: 'Contract', entityId: id }, () =>
      post(`/api/contracts/${id}/versions/${versionId}/activate`, {}, { jar: jars.admin }),
    );
    assert.equal(ergebnis.status, 200, ergebnis.text);
    const eintrag = erwarteEintrag(
      neu,
      { entity: 'Contract', entityId: id, action: 'UPDATE', userId: stamm.nutzer.admin, summary: /Fassung 2/ },
      'neue Fassung in Kraft setzen',
    );
    const changes = eintrag.changes as { geltendeFassung?: { from?: number; to?: number } } | null;
    assert.equal(changes?.geltendeFassung?.to, 2, `der Fassungswechsel fehlt in den Änderungen: ${JSON.stringify(eintrag.changes)}`);
    keineGeheimnisse(neu, 'neue Fassung in Kraft setzen');
  });

  it('Preisanpassung: Vorschlag der Betriebsleitung, Freigabe und Übernahme durch die Verwaltung — je mit der eigenen Person', async () => {
    const id = await aktiverVertrag('Preis');
    const vorschlag = await post<{ data: { id: string } }>(
      `/api/contracts/${id}/price-adjustments`,
      { effectiveFrom: tagIn(60), newAmount: 1320, reason: 'Indexanpassung der Prüfreihe Protokollpflicht' },
      { jar: jars.manager },
    );
    assert.equal(vorschlag.status, 201, vorschlag.text);
    const anpassungId = data(vorschlag).id;
    const vorgeschlagen = await eintraegeZu('ContractPriceAdjustment', anpassungId);
    erwarteEintrag(
      vorgeschlagen,
      { entity: 'ContractPriceAdjustment', entityId: anpassungId, action: 'CREATE', userId: stamm.nutzer.manager },
      'Preisanpassung vorschlagen',
    );

    const freigabe = await beobachten({ entity: 'ContractPriceAdjustment', entityId: anpassungId }, () =>
      post(`/api/contracts/${id}/price-adjustments/${anpassungId}/decision`, { entscheidung: 'APPROVE' }, { jar: jars.admin }),
    );
    assert.equal(freigabe.ergebnis.status, 200, freigabe.ergebnis.text);
    erwarteEintrag(
      freigabe.neu,
      { entity: 'ContractPriceAdjustment', entityId: anpassungId, action: 'UPDATE', userId: stamm.nutzer.admin, summary: /freigegeben/ },
      'Preisanpassung freigeben',
    );

    const uebernahme = await beobachten({ entity: 'ContractPriceAdjustment', entityId: anpassungId }, () =>
      post<{ data: { version: { id: string; versionNumber: number } } }>(
        `/api/contracts/${id}/price-adjustments/${anpassungId}/apply`,
        {},
        { jar: jars.admin },
      ),
    );
    assert.equal(uebernahme.ergebnis.status, 201, uebernahme.ergebnis.text);
    erwarteEintrag(
      uebernahme.neu,
      { entity: 'ContractPriceAdjustment', entityId: anpassungId, action: 'UPDATE', userId: stamm.nutzer.admin, summary: /übernommen/ },
      'Preisanpassung übernehmen',
    );
    const versionId = data(uebernahme.ergebnis).version.id;
    const fassung = await eintraegeZu('ContractVersion', versionId);
    erwarteEintrag(
      fassung,
      { entity: 'ContractVersion', entityId: versionId, action: 'CREATE', userId: stamm.nutzer.admin, summary: /Preisanpassung/ },
      'Fassung aus der Preisanpassung',
    );
    keineGeheimnisse([...vorgeschlagen, ...freigabe.neu, ...uebernahme.neu, ...fassung], 'Preisanpassung');
  });
});

// ===========================================================================
//  Zeiterfassung
// ===========================================================================

/**
 * Ein Zeitfenster weit in der Vergangenheit und nachts (UTC) — ausserhalb der
 * Fenster von `zeiterfassung.test.ts` (40 Tage, 06:00 UTC) und der Demodaten.
 * 43 Tage zurück liegt im selben Lohnmonat wie dort; ist er veröffentlicht,
 * scheitern beide Dateien an derselben Stelle und nicht diese allein.
 */
function zeitfenster() {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - 43);
  start.setUTCHours(2, 0, 0, 0);
  return { startedAt: start.toISOString(), endedAt: new Date(start.getTime() + 3_600_000).toISOString() };
}

async function zeitenAufraeumen(): Promise<void> {
  if (!db) return;
  const eintraege = await db.timeEntry.findMany({ where: { note: { startsWith: MARKE_ZEIT } }, select: { id: true, approved: true } });
  for (const e of eintraege) {
    // Freigegebene zuerst öffnen — wie `zeiterfassung.test.ts`; der Weg über
    // die Anwendung hält die Lohnkosten des Einsatzes richtig.
    if (e.approved) await post(`/api/time/${e.id}/reopen`, undefined, { jar: jars.admin }).catch(() => undefined);
    await del(`/api/time/${e.id}`, { jar: jars.admin }).catch(() => undefined);
  }
  await db.timeEntry.deleteMany({ where: { note: { startsWith: MARKE_ZEIT } } });
}

describe('Zeiterfassung: anlegen, ändern, freigeben', { concurrency: 1, skip: ohneDb }, () => {
  const s = { eintragId: '' };

  before(zeitenAufraeumen);
  after(zeitenAufraeumen);

  it('Zeit von Hand erfassen: CREATE an der Erfassung', async () => {
    const antwort = await post<{ data: { id: string } }>(
      '/api/time',
      { employeeId: stamm.employeeId, ...zeitfenster(), breakMin: 0, note: `${MARKE_ZEIT} ${RUN}` },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 201, antwort.text);
    s.eintragId = data(antwort).id;

    const eintraege = await eintraegeZu('TimeEntry', s.eintragId);
    erwarteEintrag(eintraege, { entity: 'TimeEntry', entityId: s.eintragId, action: 'CREATE', userId: stamm.nutzer.admin }, 'Zeit erfassen');
    keineGeheimnisse(eintraege, 'Zeit erfassen');
  });

  it('Zeit korrigieren: UPDATE an der Erfassung mit alter und neuer Pause', async () => {
    assert.ok(s.eintragId);
    const { ergebnis, neu } = await beobachten({ entity: 'TimeEntry', entityId: s.eintragId }, () =>
      patch(`/api/time/${s.eintragId}`, { breakMin: 10 }, { jar: jars.admin }),
    );
    assert.equal(ergebnis.status, 200, ergebnis.text);
    const eintrag = erwarteEintrag(
      neu,
      { entity: 'TimeEntry', entityId: s.eintragId, action: 'UPDATE', userId: stamm.nutzer.admin, summary: /korrigiert/ },
      'Zeit korrigieren',
    );
    const changes = eintrag.changes as { breakMin?: { from?: number; to?: number } } | null;
    assert.equal(changes?.breakMin?.to, 10, `die Änderung fehlt: ${JSON.stringify(eintrag.changes)}`);
    keineGeheimnisse(neu, 'Zeit korrigieren');
  });

  /**
   * Die Freigabe ist die Lohnentscheidung. Wer später fragt „wer hat diese
   * Stunde freigegeben?", sucht im Protokoll nach der Erfassung — und findet
   * sie nur, wenn die Zeile ihre Kennung trägt. Ein Sammeleintrag, der die
   * Kennungen allein in `changes.entryIds` führt, ist für diese Suche
   * unsichtbar; deshalb verlangt die Prüfung die Zeile an der Erfassung.
   */
  it('Zeit freigeben: UPDATE an genau dieser Erfassung, auffindbar über ihre Kennung', async () => {
    assert.ok(s.eintragId);
    const sammelVorher = new Set((await eintraegeZu('TimeEntry')).map((e) => e.id));
    const { ergebnis, neu } = await beobachten({ entity: 'TimeEntry', entityId: s.eintragId }, () =>
      post<{ data: { freigegeben: number } }>('/api/time/approve', { entryIds: [s.eintragId] }, { jar: jars.admin }),
    );
    assert.equal(ergebnis.status, 200, ergebnis.text);
    assert.equal(data(ergebnis).freigegeben, 1, 'Vorbedingung: die Erfassung wurde freigegeben');

    // Nur zur Auskunft im Fehlschlag: Steht die Freigabe als Sammeleintrag da?
    const sammel = (await eintraegeZu('TimeEntry')).filter(
      (e) => !sammelVorher.has(e.id) && e.entityId === null && JSON.stringify(e.changes ?? {}).includes(s.eintragId),
    );
    assert.ok(
      neu.length > 0,
      `Zeit freigeben: keine Protokollzeile an der Erfassung ${s.eintragId}` +
        (sammel.length > 0 ? ` — nur ein Sammeleintrag ohne Kennung: ${kurz(sammel)}` : ''),
    );
    erwarteEintrag(
      neu,
      { entity: 'TimeEntry', entityId: s.eintragId, action: 'UPDATE', userId: stamm.nutzer.admin, summary: /freigegeben/ },
      'Zeit freigeben',
    );
    keineGeheimnisse([...neu, ...sammel], 'Zeit freigeben');
  });
});

// ===========================================================================
//  Rechnungen, Zahlung, Gutschrift, Mahnung
// ===========================================================================

/**
 * Ausgestellte Rechnungen samt Zahlungen, Gutschriften, Mahnungen und PDF
 * entfernen — an den Triggern vorbei. Dieselbe Reihenfolge wie
 * `rechnungenEntfernen` in `geschaeftsablaeufe.test.ts`: Unter `replica`
 * greifen die Kaskaden nicht, und der Kundenwert, den eine verbuchte Zahlung
 * erhöht hat, wird danach zurückgesetzt.
 */
async function rechnungenAufraeumen(): Promise<void> {
  if (!db) return;
  const rechnungen = await db.invoice.findMany({ where: { notes: { contains: MARKE_RECHNUNG } }, select: { id: true } });
  const ids = rechnungen.map((r) => r.id);
  if (ids.length === 0) return;
  const zahlungen = await db.payment.findMany({
    where: { invoiceId: { in: ids }, status: 'SUCCEEDED' },
    select: { amount: true, invoice: { select: { customerId: true } } },
  });
  const assets = await db.fileAsset.findMany({ where: { invoiceId: { in: ids } }, select: { id: true, storedFileId: true } });
  await db.publicAccessToken.deleteMany({ where: { resourceId: { in: ids } } });
  await schutzfreiAufraeumen(async (tx) => {
    await tx.payment.deleteMany({ where: { invoiceId: { in: ids } } });
    await tx.creditNote.deleteMany({ where: { invoiceId: { in: ids } } });
    await tx.paymentReminder.deleteMany({ where: { invoiceId: { in: ids } } });
    await tx.invoiceItem.deleteMany({ where: { invoiceId: { in: ids } } });
    await tx.fileAsset.deleteMany({ where: { id: { in: assets.map((a) => a.id) } } });
    const abgelegt = assets.map((a) => a.storedFileId).filter((x): x is string => Boolean(x));
    if (abgelegt.length > 0) await tx.storedFile.deleteMany({ where: { id: { in: abgelegt } } });
    await tx.invoice.deleteMany({ where: { id: { in: ids } } });
  });
  const jeKunde = new Map<string, number>();
  for (const z of zahlungen) {
    const kunde = z.invoice?.customerId;
    if (kunde) jeKunde.set(kunde, (jeKunde.get(kunde) ?? 0) + Number(z.amount));
  }
  for (const [kunde, betrag] of jeKunde) {
    await db.customer.update({ where: { id: kunde }, data: { lifetimeValue: { decrement: betrag } } }).catch(() => undefined);
  }
}

async function rechnungAnlegen(felder: { ausstellen: boolean; issueDate?: string; dueDate?: string }): Promise<string> {
  const antwort = await post<{ data: { id: string } }>(
    '/api/invoices',
    {
      customerId: stamm.kundeId,
      notes: `${MARKE_RECHNUNG} ${RUN}`,
      items: [{ name: 'Unterhaltsreinigung', quantity: 2, unit: 'Std.', unitPrice: 50, vatRate: 8.1 }],
      issueImmediately: felder.ausstellen,
      ...(felder.issueDate ? { issueDate: felder.issueDate } : {}),
      ...(felder.dueDate ? { dueDate: felder.dueDate } : {}),
    },
    { jar: jars.admin },
  );
  assert.equal(antwort.status, 201, antwort.text);
  return data(antwort).id;
}

describe('Rechnungen: ausstellen, senden, Zahlung, Gutschrift, stornieren, mahnen', { concurrency: 1, skip: ohneDb }, () => {
  const s = { rechnungId: '' };

  before(rechnungenAufraeumen);
  after(rechnungenAufraeumen);

  it('Rechnung ausstellen: UPDATE „ausgestellt" an der Rechnung', async () => {
    s.rechnungId = await rechnungAnlegen({ ausstellen: false });
    erwarteEintrag(
      await eintraegeZu('Invoice', s.rechnungId),
      { entity: 'Invoice', entityId: s.rechnungId, action: 'CREATE', userId: stamm.nutzer.admin },
      'Rechnungsentwurf anlegen',
    );

    const { ergebnis, neu } = await beobachten({ entity: 'Invoice', entityId: s.rechnungId }, () =>
      post(`/api/invoices/${s.rechnungId}/issue`, undefined, { jar: jars.admin }),
    );
    assert.equal(ergebnis.status, 200, ergebnis.text);
    erwarteEintrag(
      neu,
      { entity: 'Invoice', entityId: s.rechnungId, action: 'UPDATE', userId: stamm.nutzer.admin, summary: /ausgestellt/ },
      'Rechnung ausstellen',
    );
    keineGeheimnisse(neu, 'Rechnung ausstellen');
  });

  it('Rechnung senden: UPDATE „versendet" — ohne Zahlungslink, Token oder Hash', async () => {
    assert.ok(s.rechnungId);
    const { ergebnis, neu } = await beobachten({ entity: 'Invoice', entityId: s.rechnungId }, () =>
      post(`/api/invoices/${s.rechnungId}/send`, {}, { jar: jars.admin }),
    );
    assert.equal(ergebnis.status, 200, ergebnis.text);
    erwarteEintrag(
      neu,
      { entity: 'Invoice', entityId: s.rechnungId, action: 'UPDATE', userId: stamm.nutzer.admin, summary: /versendet/ },
      'Rechnung senden',
    );
    const geheimnisse = await zugangsgeheimnisse(s.rechnungId);
    assert.ok(geheimnisse.length > 0, 'Vorbedingung: der Versand hat einen Zahlungslink ausgestellt');
    keineGeheimnisse(neu, 'Rechnung senden', { geheimnisse });
  });

  it('Zahlung erfassen: PAYMENT an der Rechnung, mit Betrag und Person', async () => {
    assert.ok(s.rechnungId);
    const { ergebnis, neu } = await beobachten({ entity: 'Invoice', entityId: s.rechnungId }, () =>
      post(`/api/invoices/${s.rechnungId}/payments`, { amount: 20, reference: `${MARKE_RECHNUNG} ${RUN}` }, { jar: jars.admin }),
    );
    assert.equal(ergebnis.status, 201, ergebnis.text);
    const eintrag = erwarteEintrag(
      neu,
      { entity: 'Invoice', entityId: s.rechnungId, action: 'PAYMENT', userId: stamm.nutzer.admin },
      'Zahlung erfassen',
    );
    assert.match(eintrag.summary ?? '', /20\.00/, 'der Betrag gehört in die Zusammenfassung');
    keineGeheimnisse(neu, 'Zahlung erfassen');
  });

  it('Gutschrift anlegen: CREATE an der Gutschrift', async () => {
    assert.ok(s.rechnungId);
    const antwort = await post<{ data: { id: string } }>(
      `/api/invoices/${s.rechnungId}/credit-note`,
      { reason: 'Einsatz verspätet, Prüfreihe Protokollpflicht', name: 'Kulanz', unitPrice: 10, vatRate: 8.1 },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 201, antwort.text);
    const gutschriftId = data(antwort).id;
    const eintraege = await eintraegeZu('CreditNote', gutschriftId);
    erwarteEintrag(
      eintraege,
      { entity: 'CreditNote', entityId: gutschriftId, action: 'CREATE', userId: stamm.nutzer.admin },
      'Gutschrift anlegen',
    );
    keineGeheimnisse(eintraege, 'Gutschrift anlegen');
  });

  it('Rechnung stornieren: UPDATE „storniert" mit Begründung', async () => {
    // Eine eigene, unbezahlte Rechnung — die teilweise bezahlte oben verweist
    // zu Recht auf die Gutschrift statt auf den Storno.
    const id = await rechnungAnlegen({ ausstellen: true });
    const grund = 'Doppelt erfasst, Prüfreihe Protokollpflicht';
    const { ergebnis, neu } = await beobachten({ entity: 'Invoice', entityId: id }, () =>
      post(`/api/invoices/${id}/cancel`, { reason: grund }, { jar: jars.admin }),
    );
    assert.equal(ergebnis.status, 200, ergebnis.text);
    const eintrag = erwarteEintrag(
      neu,
      { entity: 'Invoice', entityId: id, action: 'UPDATE', userId: stamm.nutzer.admin, summary: /storniert/ },
      'Rechnung stornieren',
    );
    assert.ok(eintrag.summary?.includes(grund), `die Begründung fehlt: ${eintrag.summary}`);
    keineGeheimnisse(neu, 'Rechnung stornieren');
  });

  /**
   * Gemahnt wird nur im Tageslauf (`processOverdueInvoices` über
   * `/api/cron/daily`) — es gibt keinen Knopf dafür. Die handelnde Stelle ist
   * deshalb das System: `userId` ist `null`, und genau das wird verlangt.
   * Eine Mahnung mit Gebühr, versendet per E-Mail und ab Stufe 2 per SMS, ist
   * ein Schritt gegenüber der Kundschaft, nach dem später gefragt wird („wann
   * wurde gemahnt, auf welcher Stufe?"). Die Zeile darf an der Rechnung oder
   * an der Mahnung hängen; fehlen darf sie nicht.
   *
   * Die Rechnung wird mit einem Fälligkeitstag vor heute ausgestellt — beim
   * direkten Ausstellen übernimmt der Dienst die Daten der Eingabe. Über den
   * Jahreswechsel (1./2. Januar) zöge die Nummer aus dem alten Kreis; das
   * betrifft nur die Testdatenbank.
   */
  it('Rechnung mahnen (Tageslauf): Protokollzeile an Rechnung oder Mahnung, als System', async () => {
    const id = await rechnungAnlegen({ ausstellen: true, issueDate: tagIn(-2), dueDate: tagIn(-1) });
    const { ergebnis, neu } = await beobachten({ entity: 'Invoice', entityId: id }, () =>
      get('/api/cron/daily', { headers: { authorization: `Bearer ${process.env.CRON_SECRET ?? 'dev-cron-secret'}` } }),
    );
    assert.equal(ergebnis.status, 200, ergebnis.text.slice(0, 300));

    const mahnung = await db!.paymentReminder.findFirst({ where: { invoiceId: id }, select: { id: true, level: true } });
    assert.ok(mahnung, 'Vorbedingung: der Tageslauf hat die überfällige Rechnung gemahnt');

    const anMahnung = await eintraegeZu('PaymentReminder', mahnung.id);
    const alle = [...neu, ...anMahnung];
    const treffer = alle.filter((e) => /mahn|erinnerung/i.test(e.summary ?? ''));
    assert.ok(
      treffer.length > 0,
      `Mahnung Stufe ${mahnung.level} zu ${id}: keine Protokollzeile an Rechnung oder Mahnung — vorhanden: ${kurz(alle)}`,
    );
    const eintrag = treffer.at(-1)!;
    assert.equal(eintrag.organizationId, stamm.org, 'Mahnung: Protokollzeile in einer fremden Organisation');
    assert.equal(eintrag.userId, null, 'Mahnung: der Tageslauf handelt als System, nicht als Person');
    keineGeheimnisse(alle, 'Rechnung mahnen', { geheimnisse: await zugangsgeheimnisse(id) });
  });
});

// ===========================================================================
//  Dateien und Führungsdokumente
// ===========================================================================

async function dateienAufraeumen(): Promise<void> {
  if (!db) return;
  const dokumente = await db.managedDocument.findMany({ where: { title: { startsWith: MARKE_DOKUMENT } }, select: { id: true } });
  const dokIds = dokumente.map((d) => d.id);
  if (dokIds.length > 0) {
    // Erst den Verweis auf die geltende Fassung lösen, dann die Fassungen,
    // dann die Akte — die Fassung zeigt auf die Datei, die Akte auf die Fassung.
    await db.managedDocument.updateMany({ where: { id: { in: dokIds } }, data: { currentVersionId: null } });
    await db.documentVersion.deleteMany({ where: { documentId: { in: dokIds } } });
    await db.managedDocument.deleteMany({ where: { id: { in: dokIds } } });
  }
  const assets = await db.fileAsset.findMany({ where: { filename: { startsWith: MARKE_DATEI } }, select: { id: true, storedFileId: true } });
  await db.fileAsset.deleteMany({ where: { id: { in: assets.map((a) => a.id) } } });
  const abgelegt = assets.map((a) => a.storedFileId).filter((x): x is string => Boolean(x));
  if (abgelegt.length > 0) await db.storedFile.deleteMany({ where: { id: { in: abgelegt } } });
}

describe('Dateien: Upload abschliessen, Führungsdokument herunterladen', { concurrency: 1, skip: ohneDb }, () => {
  const bytes = Buffer.from(`Versicherungspolice, Prüfreihe Protokollpflicht ${RUN}.\n`, 'utf8');
  const dateiname = `${MARKE_DATEI}${RUN}.txt`;
  const s = { assetId: '', checksum: '', dokumentId: '' };

  before(dateienAufraeumen);
  after(dateienAufraeumen);

  it('Upload abschliessen: CREATE am Asset — ohne Schreibadresse und ohne ihre Signatur', async () => {
    const ticket = await post<{ data: { ticketId: string; signedUrl: string } }>(
      '/api/files/upload-url',
      { profile: 'document', filename: dateiname, mimeType: 'text/plain', sizeBytes: bytes.byteLength },
      { jar: jars.admin },
    );
    assert.equal(ticket.status, 201, ticket.text);
    const signiert = new URL(data(ticket).signedUrl, BASE_URL);
    const upload = await fetch(`${BASE_URL}${signiert.pathname}${signiert.search}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: new Uint8Array(bytes),
    });
    assert.equal(upload.status, 200, 'Upload fehlgeschlagen');

    const abschluss = await post<{ data: { id: string; checksum: string } }>(
      '/api/files/finalize',
      { ticketId: data(ticket).ticketId, filename: dateiname },
      { jar: jars.admin },
    );
    assert.equal(abschluss.status, 201, abschluss.text);
    s.assetId = data(abschluss).id;
    s.checksum = data(abschluss).checksum;

    const eintraege = await eintraegeZu('FileAsset', s.assetId);
    erwarteEintrag(eintraege, { entity: 'FileAsset', entityId: s.assetId, action: 'CREATE', userId: stamm.nutzer.admin }, 'Upload abschliessen');
    // Die Signatur der Schreibadresse ist ein befristeter Schlüssel — sie
    // gehört so wenig ins Protokoll wie ein Offertlink.
    const adressGeheimnisse = [...signiert.searchParams.values()].filter((w) => w.length >= 16);
    keineGeheimnisse(eintraege, 'Upload abschliessen', { geheimnisse: adressGeheimnisse, erlaubteHex: [s.checksum] });
  });

  it('Führungsdokument herunterladen: EXPORT am Dokument, mit Person', async () => {
    assert.ok(s.assetId, 'die Datei aus dem vorigen Schritt fehlt');
    const dokument = await post<{ data: { id: string } }>(
      '/api/bi/documents',
      { title: `${MARKE_DOKUMENT} ${RUN}`, category: 'OTHER', fileId: s.assetId },
      { jar: jars.admin },
    );
    assert.equal(dokument.status, 201, dokument.text);
    s.dokumentId = data(dokument).id;
    erwarteEintrag(
      await eintraegeZu('ManagedDocument', s.dokumentId),
      { entity: 'ManagedDocument', entityId: s.dokumentId, action: 'CREATE', userId: stamm.nutzer.admin },
      'Dokument ablegen',
    );

    const { ergebnis, neu } = await beobachten({ entity: 'ManagedDocument', entityId: s.dokumentId }, async () => {
      const antwort = await fetch(`${BASE_URL}/api/bi/documents/${s.dokumentId}/download`, {
        headers: { cookie: jars.admin },
        redirect: 'manual',
      });
      await antwort.arrayBuffer();
      return antwort.status;
    });
    // 200 mit den Bytes ohne Objektspeicher, 302 auf einen befristeten Verweis mit.
    assert.ok([200, 302].includes(ergebnis), `Download: HTTP ${ergebnis}`);
    erwarteEintrag(
      neu,
      { entity: 'ManagedDocument', entityId: s.dokumentId, action: 'EXPORT', userId: stamm.nutzer.admin, summary: /heruntergeladen/ },
      'Dokument herunterladen',
    );
    keineGeheimnisse(neu, 'Dokument herunterladen', { erlaubteHex: [s.checksum] });
  });
});

// ===========================================================================
//  Nachrichten
// ===========================================================================

async function nachrichtenAufraeumen(): Promise<void> {
  if (!db) return;
  const verlaeufe = await db.messageThread.findMany({ where: { subject: { startsWith: MARKE_NACHRICHT } }, select: { id: true } });
  const ids = verlaeufe.map((v) => v.id);
  if (ids.length === 0) return;
  await db.message.deleteMany({ where: { threadId: { in: ids } } });
  await db.messageThread.deleteMany({ where: { id: { in: ids } } });
}

describe('Nachrichten: einen Verlauf eröffnen', { concurrency: 1, skip: ohneDb }, () => {
  before(nachrichtenAufraeumen);
  after(nachrichtenAufraeumen);

  /**
   * Ein Verlauf ist Korrespondenz mit der Kundschaft, oft mit Anhängen und
   * Personendaten. Wer ihn eröffnet hat — die Kundschaft selbst oder jemand
   * im Büro in ihrem Namen —, gehört ins Protokoll, nicht nur in
   * `messages.authorId`: Die Nachricht lässt sich löschen, die Protokollzeile
   * nicht.
   */
  it('Nachricht eröffnen (Kundschaft): CREATE am Verlauf, mit dem Kundenkonto als Person', async () => {
    const antwort = await post<{ data: { id: string } }>(
      '/api/messages',
      { subject: `${MARKE_NACHRICHT} ${RUN}`, body: 'Bitte den Einsatz am Freitag bestätigen.' },
      { jar: jars.customer },
    );
    assert.equal(antwort.status, 201, antwort.text);
    const verlaufId = data(antwort).id;

    const eintraege = await eintraegeZu('MessageThread', verlaufId);
    erwarteEintrag(
      eintraege,
      { entity: 'MessageThread', entityId: verlaufId, action: 'CREATE', userId: stamm.nutzer.customer },
      'Nachricht eröffnen',
    );
    keineGeheimnisse(eintraege, 'Nachricht eröffnen');
  });
});

// ===========================================================================
//  Anfragen (Leads)
// ===========================================================================

/**
 * Anfragen erst über die Anwendung in den Papierkorb, dann hart entfernen —
 * wie `mandanten.test.ts`. Die aus der Umwandlung entstandene Kundschaft
 * trägt die Prüfadresse und geht samt Adressen und Aktivitäten mit. Hängt an
 * einer Anfrage etwas, das die Anwendung angelegt hat (eine Aufgabe aus einer
 * Automatisierung), bleibt sie im Papierkorb; ein Rest, kein Fehlschlag.
 */
async function anfragenAufraeumen(): Promise<void> {
  if (!db) return;
  const anfragen = await db.lead.findMany({ where: { lastName: { startsWith: MARKE_ANFRAGE } }, select: { id: true, deletedAt: true } });
  for (const a of anfragen) {
    if (!a.deletedAt) await del(`/api/leads/${a.id}`, { jar: jars.admin }).catch(() => undefined);
  }
  const ids = anfragen.map((a) => a.id);
  if (ids.length > 0) {
    await db.activity.deleteMany({ where: { leadId: { in: ids } } }).catch(() => undefined);
    await db.lead.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
  }
  const kunden = await db.customer.findMany({ where: { email: { startsWith: ANFRAGE_EMAIL_PRAEFIX } }, select: { id: true } });
  const kundenIds = kunden.map((k) => k.id);
  if (kundenIds.length > 0) {
    await db.address.deleteMany({ where: { customerId: { in: kundenIds } } });
    await db.activity.deleteMany({ where: { customerId: { in: kundenIds } } });
    await db.customer.deleteMany({ where: { id: { in: kundenIds } } }).catch(() => undefined);
  }
}

async function anfrageAnlegen(email: string): Promise<{ id: string; nummer: string }> {
  const antwort = await post<{ data: { id: string } }>(
    '/api/leads',
    {
      firstName: 'Protokoll',
      lastName: `${MARKE_ANFRAGE}${RUN}`,
      email,
      serviceKind: 'OFFICE_CLEANING',
      message: 'Büro 80 m², Unterhaltsreinigung gewünscht.',
      source: 'PHONE',
      tagIds: [],
    },
    { jar: jars.admin },
  );
  assert.equal(antwort.status, 201, antwort.text);
  const id = data(antwort).id;
  const nummer = (await db!.lead.findUniqueOrThrow({ where: { id }, select: { number: true } })).number;
  return { id, nummer };
}

describe('Anfragen: anlegen und umwandeln', { concurrency: 1, skip: ohneDb }, () => {
  const s = { anfrageId: '', nummer: '' };

  before(anfragenAufraeumen);
  after(anfragenAufraeumen);

  it('Anfrage anlegen: CREATE an der Anfrage', async () => {
    const anfrage = await anfrageAnlegen(`${ANFRAGE_EMAIL_PRAEFIX}${RUN}@example.ch`);
    s.anfrageId = anfrage.id;
    s.nummer = anfrage.nummer;
    const eintraege = await eintraegeZu('Lead', s.anfrageId);
    erwarteEintrag(eintraege, { entity: 'Lead', entityId: s.anfrageId, action: 'CREATE', userId: stamm.nutzer.admin }, 'Anfrage anlegen');
    keineGeheimnisse(eintraege, 'Anfrage anlegen');
  });

  it('Anfrage umwandeln (neue Kundschaft): CREATE an der Kundschaft, mit Verweis auf die Anfrage', async () => {
    assert.ok(s.anfrageId);
    const antwort = await post<{ data: { id: string } }>(`/api/leads/${s.anfrageId}/convert`, undefined, { jar: jars.admin });
    assert.equal(antwort.status, 201, antwort.text);
    const kundeId = data(antwort).id;
    assert.notEqual(kundeId, stamm.kundeId, 'Vorbedingung: eine neue Kundschaft, keine bestehende');

    const eintraege = await eintraegeZu('Customer', kundeId);
    const eintrag = erwarteEintrag(
      eintraege,
      { entity: 'Customer', entityId: kundeId, action: 'CREATE', userId: stamm.nutzer.admin },
      'Anfrage umwandeln',
    );
    assert.ok(eintrag.summary?.includes(s.nummer), `die Anfrage ${s.nummer} fehlt in der Zusammenfassung: ${eintrag.summary}`);
    keineGeheimnisse(eintraege, 'Anfrage umwandeln');
  });

  /**
   * Derselbe Knopf, der andere Ausgang: Gibt es die Adresse schon als
   * Kundschaft, wird verknüpft statt angelegt. Fachlich ist das dieselbe
   * Handlung — die Anfrage gilt als gewonnen und hängt ab jetzt an einer
   * Kundenakte — und sie braucht dieselbe Zeile. Verlangt wird eine neue
   * Zeile an der Anfrage **oder** an der bestehenden Kundschaft, die die
   * Anfrage nennt.
   */
  it('Anfrage umwandeln (bestehende Kundschaft): Protokollzeile, die Anfrage und Verwaltung nennt', async () => {
    assert.ok(stamm.kundeEmail, 'Vorbedingung: die Demokundschaft hat eine E-Mail-Adresse');
    const anfrage = await anfrageAnlegen(stamm.kundeEmail);

    const anKunde = new Set((await eintraegeZu('Customer', stamm.kundeId)).map((e) => e.id));
    const { ergebnis, neu } = await beobachten({ entity: 'Lead', entityId: anfrage.id }, () =>
      post<{ data: { id: string } }>(`/api/leads/${anfrage.id}/convert`, undefined, { jar: jars.admin }),
    );
    assert.equal(ergebnis.status, 201, ergebnis.text);
    assert.equal(data(ergebnis).id, stamm.kundeId, 'Vorbedingung: verknüpft mit der bestehenden Kundschaft');

    const neuAnKunde = (await eintraegeZu('Customer', stamm.kundeId)).filter((e) => !anKunde.has(e.id));
    const alle = [...neu, ...neuAnKunde];
    const treffer = alle.filter((e) => e.entity === 'Lead' || (e.summary ?? '').includes(anfrage.nummer));
    assert.ok(
      treffer.length > 0,
      `Umwandlung von ${anfrage.nummer} in die bestehende Kundschaft: keine Protokollzeile — vorhanden: ${kurz(alle)}`,
    );
    const eintrag = treffer.at(-1)!;
    assert.equal(eintrag.organizationId, stamm.org);
    assert.equal(eintrag.userId, stamm.nutzer.admin, 'Umwandlung: falsche handelnde Person im Protokoll');
    keineGeheimnisse(alle, 'Anfrage in bestehende Kundschaft umwandeln');
  });
});

// ===========================================================================
//  Automatisierungsregeln
// ===========================================================================

async function regelnAufraeumen(): Promise<void> {
  if (!db) return;
  const regeln = await db.automation.findMany({ where: { name: { startsWith: MARKE_REGEL } }, select: { id: true } });
  for (const r of regeln) await del(`/api/automations/${r.id}`, { jar: jars.admin }).catch(() => undefined);
}

describe('Automatisierungsregeln: anlegen, ändern, löschen', { concurrency: 1, skip: ohneDb }, () => {
  const s = { regelId: '' };

  before(regelnAufraeumen);
  after(regelnAufraeumen);

  it('Regel anlegen: CREATE an der Regel', async () => {
    // Abgeschaltet und mit einem Auslöser, der nur an künftigen Terminen
    // hängt — die Regel soll während der Prüfung nie laufen.
    const antwort = await post<{ data: { id: string } }>(
      '/api/automations',
      {
        name: `${MARKE_REGEL} ${RUN}`,
        trigger: 'BOOKING_REMINDER_24H',
        delayMinutes: -60,
        active: false,
        actions: [{ type: 'SEND_EMAIL', config: { templateKey: 'booking_reminder' } }],
      },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 201, antwort.text);
    s.regelId = data(antwort).id;
    const eintraege = await eintraegeZu('Automation', s.regelId);
    erwarteEintrag(eintraege, { entity: 'Automation', entityId: s.regelId, action: 'CREATE', userId: stamm.nutzer.admin }, 'Regel anlegen');
    keineGeheimnisse(eintraege, 'Regel anlegen');
  });

  it('Regel ändern: UPDATE an der Regel mit der Änderung', async () => {
    assert.ok(s.regelId);
    const neuerName = `${MARKE_REGEL} ${RUN} geändert`;
    const { ergebnis, neu } = await beobachten({ entity: 'Automation', entityId: s.regelId }, () =>
      patch(`/api/automations/${s.regelId}`, { name: neuerName }, { jar: jars.admin }),
    );
    assert.equal(ergebnis.status, 200, ergebnis.text);
    const eintrag = erwarteEintrag(
      neu,
      { entity: 'Automation', entityId: s.regelId, action: 'UPDATE', userId: stamm.nutzer.admin },
      'Regel ändern',
    );
    assert.ok(JSON.stringify(eintrag.changes ?? {}).includes(neuerName), `die Änderung fehlt: ${JSON.stringify(eintrag.changes)}`);
    keineGeheimnisse(neu, 'Regel ändern');
  });

  it('Regel löschen: DELETE an der Regel', async () => {
    assert.ok(s.regelId);
    const { ergebnis, neu } = await beobachten({ entity: 'Automation', entityId: s.regelId }, () =>
      del(`/api/automations/${s.regelId}`, { jar: jars.admin }),
    );
    assert.equal(ergebnis.status, 204, ergebnis.text);
    erwarteEintrag(neu, { entity: 'Automation', entityId: s.regelId, action: 'DELETE', userId: stamm.nutzer.admin }, 'Regel löschen');
    keineGeheimnisse(neu, 'Regel löschen');
  });
});

// ===========================================================================
//  Website-Inhalte
// ===========================================================================

const CMS_SCHLUESSEL = 'home.hero.titleLine1';

describe('Website-Inhalte: veröffentlichen', { concurrency: 1, skip: ohneDb }, () => {
  /**
   * Zurück auf den Auslieferungstext und offene Entwürfe weg — dieselbe
   * Folge wie das `after` in `cms.test.ts`.
   */
  after(async () => {
    await patch('/api/content', { entries: [{ key: CMS_SCHLUESSEL, value: '' }] }, { jar: jars.admin });
    await post('/api/content', { action: 'publish', keys: [CMS_SCHLUESSEL] }, { jar: jars.admin });
    await post('/api/content', { action: 'discard', keys: [CMS_SCHLUESSEL] }, { jar: jars.admin });
  });

  /**
   * Veröffentlichen ändert, was jede Besucherin liest. Die Frage danach ist
   * immer „wer hat **diesen** Text freigegeben?" — eine Zeile „1 Baustein
   * veröffentlicht" an der Organisation beantwortet sie nicht. Verlangt wird
   * deshalb, dass die Zeile den Baustein nennt: über seine Kennung oder über
   * seinen Schlüssel in Zusammenfassung oder Änderungen.
   */
  it('Text veröffentlichen: UPDATE, das den veröffentlichten Baustein nennt', async () => {
    const entwurf = await patch('/api/content', { entries: [{ key: CMS_SCHLUESSEL, value: `Protokollprobe ${RUN}` }] }, { jar: jars.admin });
    assert.equal(entwurf.status, 200, entwurf.text);
    const baustein = await db!.contentBlock.findFirst({
      where: { organizationId: stamm.org, key: CMS_SCHLUESSEL, locale: 'DE' },
      select: { id: true },
    });
    assert.ok(baustein, 'Vorbedingung: der Entwurf liegt als Baustein vor');

    const { ergebnis, neu } = await beobachten({ entity: 'ContentBlock' }, () =>
      post('/api/content', { action: 'publish', keys: [CMS_SCHLUESSEL] }, { jar: jars.admin }),
    );
    assert.equal(ergebnis.status, 200, ergebnis.text);

    const veroeffentlicht = neu.filter((e) => e.action === 'UPDATE' && /veröffentlicht/.test(e.summary ?? ''));
    assert.ok(veroeffentlicht.length > 0, `Text veröffentlichen: keine Protokollzeile — vorhanden: ${kurz(neu)}`);
    const eintrag = veroeffentlicht.at(-1)!;
    assert.equal(eintrag.organizationId, stamm.org);
    assert.equal(eintrag.userId, stamm.nutzer.admin, 'Text veröffentlichen: falsche handelnde Person');
    const nenntBaustein =
      eintrag.entityId === baustein.id ||
      (eintrag.summary ?? '').includes(CMS_SCHLUESSEL) ||
      JSON.stringify(eintrag.changes ?? {}).includes(CMS_SCHLUESSEL);
    assert.ok(
      nenntBaustein,
      `Text veröffentlichen: die Zeile nennt den Baustein ${CMS_SCHLUESSEL} nicht (entityId ${eintrag.entityId}, „${eintrag.summary}")`,
    );
    keineGeheimnisse(neu, 'Text veröffentlichen');
  });
});

// ===========================================================================
//  Zwei-Faktor-Anmeldung — zuletzt, siehe Kopf
// ===========================================================================

describe('Zwei-Faktor-Anmeldung: einschalten, ausschalten, zurücksetzen', { concurrency: 1, skip: ohneDb }, () => {
  /**
   * Die Betriebsleitung als Testkonto, aus demselben Grund wie in
   * `two-factor.test.ts`: Der Faktor der Systemverantwortung liesse sich von
   * niemandem zurücksetzen. Angemeldet wird frisch, nicht über den
   * Sitzungs-Cache — die Rücksetzung beendet alle Sitzungen des Kontos.
   */
  const konto = ACCOUNTS.manager;
  const s = { jar: '', secret: '', codes: [] as string[], otpauth: '' };

  const faktorZuruecksetzen = () => del(`/api/users/${stamm.nutzer.manager}/2fa`, { jar: jars.super }).catch(() => undefined);

  before(async () => {
    await faktorZuruecksetzen();
    const anmeldung = await login(konto.email, konto.password);
    assert.equal(anmeldung.status, 200, anmeldung.text);
    s.jar = anmeldung.jar;
  });
  after(faktorZuruecksetzen);

  /** Einrichten und bestätigen — die Bestätigung ist der Schritt, der schaltet und protokolliert. */
  async function einschalten() {
    const einrichtung = await post<{ data: { secret: string; otpauthUrl: string } }>('/api/auth/2fa/setup', undefined, { jar: s.jar });
    assert.equal(einrichtung.status, 200, einrichtung.text);
    s.secret = data(einrichtung).secret;
    s.otpauth = data(einrichtung).otpauthUrl;
    return beobachten({ entity: 'User', entityId: stamm.nutzer.manager }, () =>
      post<{ data: { recoveryCodes: string[] } }>('/api/auth/2fa/confirm', { token: totp(s.secret) }, { jar: s.jar }),
    );
  }

  it('Faktor einschalten: PERMISSION_CHANGE am Konto — ohne Geheimnis und ohne Wiederherstellungscodes', async () => {
    const { ergebnis, neu } = await einschalten();
    assert.equal(ergebnis.status, 200, ergebnis.text);
    s.codes = data(ergebnis).recoveryCodes;
    erwarteEintrag(
      neu,
      { entity: 'User', entityId: stamm.nutzer.manager, action: 'PERMISSION_CHANGE', userId: stamm.nutzer.manager, summary: /eingeschaltet/ },
      'Faktor einschalten',
    );
    keineGeheimnisse(neu, 'Faktor einschalten', { geheimnisse: [s.secret, s.otpauth, ...s.codes] });
  });

  it('Faktor ausschalten: PERMISSION_CHANGE am Konto — ohne Passwort und ohne Code', async () => {
    const code = totp(s.secret);
    const { ergebnis, neu } = await beobachten({ entity: 'User', entityId: stamm.nutzer.manager }, () =>
      post('/api/auth/2fa/disable', { password: konto.password, token: code }, { jar: s.jar }),
    );
    assert.equal(ergebnis.status, 204, ergebnis.text);
    erwarteEintrag(
      neu,
      { entity: 'User', entityId: stamm.nutzer.manager, action: 'PERMISSION_CHANGE', userId: stamm.nutzer.manager, summary: /ausgeschaltet/ },
      'Faktor ausschalten',
    );
    keineGeheimnisse(neu, 'Faktor ausschalten', { geheimnisse: [s.secret, ...s.codes] });
  });

  it('Faktor zurücksetzen (Systemverantwortung): PERMISSION_CHANGE am betroffenen Konto, mit der Systemverantwortung als Person', async () => {
    const eingeschaltet = await einschalten();
    assert.equal(eingeschaltet.ergebnis.status, 200, eingeschaltet.ergebnis.text);
    const codes = data(eingeschaltet.ergebnis).recoveryCodes;

    const { ergebnis, neu } = await beobachten({ entity: 'User', entityId: stamm.nutzer.manager }, () =>
      del(`/api/users/${stamm.nutzer.manager}/2fa`, { jar: jars.super }),
    );
    assert.equal(ergebnis.status, 204, ergebnis.text);
    erwarteEintrag(
      neu,
      { entity: 'User', entityId: stamm.nutzer.manager, action: 'PERMISSION_CHANGE', userId: stamm.nutzer.super, summary: /zurückgesetzt/ },
      'Faktor zurücksetzen',
    );
    keineGeheimnisse(neu, 'Faktor zurücksetzen', { geheimnisse: [s.secret, s.otpauth, ...codes] });
  });
});
