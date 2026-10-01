import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { BASE_URL, get, post, requireServer, type ApiResponse } from '../helpers/client';
import { ACCOUNTS } from '../helpers/accounts';
import { resetRateLimits } from '../helpers/rate-limit';
import { LEERLAUF_DAUERHAFT_S, LEERLAUF_S, tokenHash } from '../helpers/sitzung';
import { testDb, testDbGrund, testDbSchliessen } from '../helpers/testdb';

/**
 * Das Leerlauffenster der Sitzung — auf dem Server bewiesen (2026-10-01).
 *
 * ---------------------------------------------------------------------------
 *  Was bis hierher fehlte
 * ---------------------------------------------------------------------------
 *
 * `session-refresh.test.ts` prüft Rotation, Rücksprung und Gleichzeitigkeit,
 * sagte zum Leerlauf aber ausdrücklich: „lässt sich über HTTP nicht warten".
 * Damit war die Regel, die eine vergessene Sitzung auf einem geteilten Gerät
 * beendet, nur durch Lesen des Dienstes belegt — und der Aktivitätswächter im
 * Browser, der dieselbe Grenze zeigt, hatte kein Gegenstück, an dem man hätte
 * sehen können, ob beide dasselbe meinen. Eine Grenze, die niemand je
 * überschreitet, ist keine geprüfte Grenze.
 *
 * ---------------------------------------------------------------------------
 *  Warum der Token altert und nicht die Uhr
 * ---------------------------------------------------------------------------
 *
 * `refreshSession` misst den Leerlauf am Ausstellungszeitpunkt des
 * vorgelegten Erneuerungstokens (`RefreshToken.createdAt`): Jede Erneuerung
 * stellt einen neuen aus, also ist `createdAt` die letzte Erneuerung. Eine
 * Prüfuhr im Server gibt es bewusst nicht — ein Schalter, der die Zeit der
 * Anwendung verstellt, wäre ein Schalter, den es auch in der Produktion gäbe.
 * Fünfzehn Minuten zu warten kommt ebenso wenig in Frage (die Reihe läuft
 * seriell, und sieben Tage für „Angemeldet bleiben" schon gar nicht).
 *
 * Also wird der Token älter gemacht: `createdAt` in der Testdatenbank
 * zurückdatieren (`testDb()`, Vorbild `beobachtbarkeit.test.ts`), dann über
 * echtes HTTP erneuern. Geprüft wird damit genau der Vergleich, der in der
 * Produktion entscheidet — nur dass die Vergangenheit hergestellt statt
 * abgewartet wird. `expiresAt` bleibt dabei unverändert; eine Ablehnung ist
 * also nie die absolute Obergrenze (`JWT_REFRESH_TTL`), sondern der Leerlauf.
 * Die Meldung „…Inaktivität…" belegt das in jedem Fall zusätzlich.
 *
 * Die Gegenseite im Browser — Warnung, Abmeldung, mehrere Tabs, die vom
 * Server beendete Sitzung — prüft `tests/e2e/sitzung-leerlauf.spec.ts`.
 *
 * ---------------------------------------------------------------------------
 *  Eigener Prüfbestand, kenntlich gemacht
 * ---------------------------------------------------------------------------
 *
 * Jede Anfrage dieser Datei trägt einen eigenen `User-Agent`. Der Server legt
 * ihn an jedem Erneuerungstoken ab (`createSession`), und daran findet das
 * Aufräumen genau die Familien dieser Datei — vor dem Lauf die eines
 * abgebrochenen früheren Laufs, danach die eigenen. Ohne diese Kennung bliebe
 * nur „alle Tokens der Betriebsleitung", und das träfe die zwischengespeicherte
 * Sitzung der übrigen Reihe (`tests/helpers/session-cache.ts`).
 */

const PRUEF_KENNUNG = 'clenaris-pruefreihe/sitzung-leerlauf';
const KOPF = { 'user-agent': PRUEF_KENNUNG };

/**
 * Wie weit neben der Grenze gemessen wird. Eine Minute ist weit genug, dass
 * die Laufzeit zwischen Zurückdatieren und Erneuern (Millisekunden) nie über
 * die Grenze trägt, und eng genug, dass „knapp im Fenster" und „knapp
 * darüber" wirklich die beiden Seiten derselben Grenze sind.
 */
const RAND_S = 60;

/** Der Zugang — oder ein Fehlschlag. Nie ein Überspringen: Die Reihe kennt kein stilles „nicht geprüft". */
function datenbank(): NonNullable<ReturnType<typeof testDb>> {
  const db = testDb();
  if (!db) throw new Error(`Diese Prüfung braucht die Testdatenbank (${testDbGrund()}).`);
  return db;
}

/** Der rohe Erneuerungstoken aus einem Cookie-Kopf — oder `''`. */
function erneuerungstoken(jar: string): string {
  return /(?:^|;\s*)clenaris_rt=([^;]*)/.exec(jar)?.[1] ?? '';
}

/** Nur das Erneuerungscookie — wie ein Browser, dessen Zugangstoken abgelaufen ist. */
function nurErneuerung(jar: string): string {
  const token = erneuerungstoken(jar);
  return token ? `clenaris_rt=${token}` : '';
}

/** Löscht die Antwort dieses Cookie? (Leerer Wert, `Max-Age=0` oder Ablauf 1970.) */
function geloescht(headers: Headers, name: string): boolean {
  return headers
    .getSetCookie()
    .some((c) => c.startsWith(`${name}=`) && (c.startsWith(`${name}=;`) || /max-age=0|expires=thu, 01 jan 1970/i.test(c)));
}

/** Die gesetzten Cookies ohne Werte — für Fehlermeldungen, die keinen Token ausgeben. */
const cookieNamen = (headers: Headers) => headers.getSetCookie().map((c) => c.replace(/=[^;]*/, '=…')).join(' | ');

type Fehlerkoerper = { error?: { code?: string; message?: string } };
const fehler = (antwort: ApiResponse<unknown>) => (antwort.payload as Fehlerkoerper | null)?.error ?? {};

interface Sitzung {
  jar: string;
  userId: string;
  familie: string;
  tokenId: string;
}

/**
 * Frisch anmelden — ohne den Sitzungszwischenspeicher der Reihe.
 *
 * Eine zwischengespeicherte Sitzung zu altern hiesse, sie der nächsten Datei
 * kaputt zu übergeben. Jeder Fall bekommt deshalb seine eigene Familie.
 * `retries: 0`: Die Zähler werden unmittelbar davor geleert; ein 429 hier wäre
 * ein Befund über das Limit, kein Grund zu warten.
 */
async function anmelden(angemeldetBleiben = false): Promise<Sitzung> {
  resetRateLimits();
  const antwort = await post<{ data: { id: string } }>(
    '/api/auth/login',
    { email: ACCOUNTS.manager.email, password: ACCOUNTS.manager.password, rememberMe: angemeldetBleiben },
    { retries: 0, headers: KOPF },
  );
  assert.equal(antwort.status, 200, `Anmeldung fehlgeschlagen: ${antwort.text}`);
  const roh = erneuerungstoken(antwort.cookies);
  assert.ok(roh, 'kein Erneuerungscookie nach der Anmeldung');
  const zeile = await datenbank().refreshToken.findUnique({ where: { tokenHash: tokenHash(roh) } });
  assert.ok(zeile, 'der Erneuerungstoken der Anmeldung steht nicht in der Datenbank');
  return { jar: antwort.cookies, userId: antwort.payload.data.id, familie: zeile.family, tokenId: zeile.id };
}

/** Den Token so alt machen, als wäre die letzte Erneuerung `sekunden` her. */
async function zurueckdatieren(tokenId: string, sekunden: number): Promise<void> {
  await datenbank().refreshToken.update({
    where: { id: tokenId },
    data: { createdAt: new Date(Date.now() - sekunden * 1000) },
  });
}

const erneuern = (jar: string) => post('/api/auth/refresh', undefined, { jar: nurErneuerung(jar), retries: 0, headers: KOPF });

/** Wiederverwendungsalarme dieser Familie. */
function alarme(familie: string) {
  return datenbank().securityEvent.findMany({
    where: { kind: 'REFRESH_REUSE_DETECTED', context: { path: ['family'], equals: familie } },
    select: { id: true, userId: true, severity: true, context: true },
  });
}

/**
 * Den Bestand dieser Datei entfernen: Wiederverwendungsalarme ihrer Familien,
 * dann die Tokens selbst.
 *
 * Der Alarm ist `CRITICAL` und verlangt in der Sicherheitszentrale eine
 * Quittung. Bliebe er stehen, zeigte jeder spätere Lauf dort einen offenen
 * kritischen Vorfall, den niemand ausgelöst hat. Die Tokens sind ohnehin
 * widerrufen; entfernt werden sie, damit eine zurückdatierte Zeile nicht als
 * „Sitzung von vor sieben Tagen" in der Sitzungsübersicht des Kontos
 * auftaucht. `security_events` und `refresh_tokens` tragen keine
 * Unveränderlichkeitstrigger — anders als `audit_logs`, das diese Datei
 * deshalb auch nicht anfasst (die Anmeldungen bleiben dort verzeichnet, wie
 * jede andere Anmeldung der Reihe).
 */
async function aufraeumen(): Promise<void> {
  const db = testDb();
  if (!db) return;
  const familien = await db.refreshToken.findMany({
    where: { userAgent: PRUEF_KENNUNG },
    select: { family: true },
    distinct: ['family'],
  });
  for (const { family } of familien) {
    await db.securityEvent.deleteMany({
      where: { kind: 'REFRESH_REUSE_DETECTED', context: { path: ['family'], equals: family } },
    });
  }
  await db.refreshToken.deleteMany({ where: { userAgent: PRUEF_KENNUNG } });
}

describe('Leerlauffenster der Sitzung (Server)', { concurrency: 1 }, async () => {
  await requireServer();
  // Ohne Datenbank scheitert die Datei laut, statt als „grün, nichts geprüft"
  // durchzugehen — die Fälle hier bestehen aus nichts anderem als dem Bestand.
  datenbank();

  before(aufraeumen);
  after(async () => {
    await aufraeumen();
    await testDbSchliessen();
  });

  it('Leerlauf überschritten: Erneuerung 401 „Inaktivität", Token widerrufen, Cookies gelöscht', async () => {
    const sitzung = await anmelden();
    await zurueckdatieren(sitzung.tokenId, LEERLAUF_S + RAND_S);

    const antwort = await erneuern(sitzung.jar);
    assert.equal(antwort.status, 401, `Fenster ${LEERLAUF_S} s überschritten, trotzdem erneuert: ${antwort.text}`);
    assert.equal(fehler(antwort).code, 'UNAUTHORIZED', 'ein Leerlauf ist kein verlorener Wettlauf (SESSION_ROTATED)');
    assert.match(fehler(antwort).message ?? '', /Inaktivität/, 'die Ablehnung nennt nicht den Leerlauf als Grund');

    // Beide Cookies weg: Ein Browser, der sie behielte, fragte bei jedem
    // Seitenaufruf erneut über die Middleware an — mit einem toten Token.
    for (const name of ['clenaris_at', 'clenaris_rt']) {
      assert.ok(geloescht(antwort.headers, name), `${name} wird nicht gelöscht: ${cookieNamen(antwort.headers)}`);
    }
    assert.equal(erneuerungstoken(antwort.cookies), '', 'es wurde ein neuer Erneuerungstoken gesetzt');

    // Widerrufen — nicht nur abgewiesen, und zwar als Leerlauf, nicht als
    // Rotation: `rotatedAt` bleibt leer, sonst hielte die Kulanz für
    // verlorene Wettläufe einen zweiten Versuch für harmlos.
    const zeile = await datenbank().refreshToken.findUniqueOrThrow({ where: { id: sitzung.tokenId } });
    assert.ok(zeile.revokedAt, 'der eingeschlafene Token ist nicht widerrufen');
    assert.equal(zeile.rotatedAt, null, 'der Leerlauf wurde als Rotation verbucht');
    assert.ok(zeile.expiresAt > new Date(), 'Prüfung ungültig: der Token war ohnehin abgelaufen');
    assert.equal(
      await datenbank().refreshToken.count({ where: { family: sitzung.familie } }),
      1,
      'trotz Ablehnung wurde ein neuer Token ausgestellt',
    );

    // Der erste Versuch ist ein gewöhnliches Ende, kein Angriff.
    assert.deepEqual(await alarme(sitzung.familie), [], 'ein gewöhnlicher Leerlauf löste einen Sicherheitsalarm aus');
  });

  it('knapp im Fenster: Erneuerung gelingt, der neue Token beginnt das Fenster von vorn', async () => {
    const sitzung = await anmelden();
    await zurueckdatieren(sitzung.tokenId, LEERLAUF_S - RAND_S);
    const alt = await datenbank().refreshToken.findUniqueOrThrow({ where: { id: sitzung.tokenId } });

    const vorher = Date.now();
    const antwort = await erneuern(sitzung.jar);
    const nachher = Date.now();
    assert.equal(antwort.status, 200, `eine Minute vor Ablauf des Fensters abgewiesen: ${antwort.text}`);
    const neu = erneuerungstoken(antwort.cookies);
    assert.ok(neu, 'kein neuer Erneuerungstoken');

    // Der alte ist durch Rotation verbraucht — nicht durch Leerlauf.
    const verbraucht = await datenbank().refreshToken.findUniqueOrThrow({ where: { id: sitzung.tokenId } });
    assert.ok(verbraucht.revokedAt && verbraucht.rotatedAt, 'der vorgelegte Token wurde nicht als rotiert verbucht');

    /*
      Das Fenster beginnt von vorn: Der neue Token trägt den Zeitpunkt dieser
      Erneuerung, nicht den der Anmeldung. Würde der Dienst das Alter der
      Familie messen (ältester Token) statt des vorgelegten, stünde hier eine
      Anmeldung von vor vierzehn Minuten — und die nächste Erneuerung eine
      Minute später wiese eine Person ab, die gerade gearbeitet hat. Die
      Toleranz von zwei Sekunden deckt nur die Uhren von Prüfprozess und
      Server auf derselben Maschine.
    */
    const frisch = await datenbank().refreshToken.findUnique({ where: { tokenHash: tokenHash(neu) } });
    assert.ok(frisch, 'der neue Token steht nicht in der Datenbank');
    assert.equal(frisch.family, sitzung.familie, 'die Erneuerung hat eine neue Familie begonnen');
    assert.ok(
      frisch.createdAt.getTime() >= vorher - 2000 && frisch.createdAt.getTime() <= nachher + 2000,
      `der neue Token trägt ${frisch.createdAt.toISOString()} statt des Erneuerungszeitpunkts`,
    );
    assert.ok(
      frisch.createdAt.getTime() - alt.createdAt.getTime() >= (LEERLAUF_S - RAND_S - 5) * 1000,
      'das Fenster ist nicht mit der Erneuerung nach vorn gewandert',
    );

    // Und er trägt selbst: Die nächste Erneuerung mit ihm gelingt.
    const weiter = await erneuern(antwort.cookies);
    assert.equal(weiter.status, 200, `der neue Token lässt sich nicht erneuern: ${weiter.text}`);
  });

  it('Angemeldet bleiben: nach 16 Minuten noch gültig, nach sieben Tagen nicht', async () => {
    const sitzung = await anmelden(true);

    // Sechzehn Minuten: jenseits des kurzen Fensters, weit innerhalb des langen.
    await zurueckdatieren(sitzung.tokenId, LEERLAUF_S + RAND_S);
    const erste = await erneuern(sitzung.jar);
    assert.equal(erste.status, 200, `„Angemeldet bleiben" endete schon nach dem kurzen Fenster: ${erste.text}`);
    const zweiterToken = erneuerungstoken(erste.cookies);
    assert.ok(zweiterToken, 'kein neuer Erneuerungstoken');
    const zweiteZeile = await datenbank().refreshToken.findUniqueOrThrow({ where: { tokenHash: tokenHash(zweiterToken) } });

    // Sieben Tage und eine Minute seit der letzten Erneuerung: vorbei — und
    // zwar wegen des Leerlaufs, nicht wegen der absoluten Obergrenze.
    await zurueckdatieren(zweiteZeile.id, LEERLAUF_DAUERHAFT_S + RAND_S);
    assert.ok(zweiteZeile.expiresAt > new Date(), 'Prüfung ungültig: der Token wäre ohnehin abgelaufen');
    const zweite = await erneuern(erste.cookies);
    assert.equal(zweite.status, 401, `Fenster ${LEERLAUF_DAUERHAFT_S} s überschritten, trotzdem erneuert: ${zweite.text}`);
    assert.match(fehler(zweite).message ?? '', /Inaktivität/, 'die Ablehnung nennt nicht den Leerlauf als Grund');
    assert.ok(geloescht(zweite.headers, 'clenaris_rt'), `das dauerhafte Erneuerungscookie wird nicht gelöscht: ${cookieNamen(zweite.headers)}`);

    const ende = await datenbank().refreshToken.findUniqueOrThrow({ where: { id: zweiteZeile.id } });
    assert.ok(ende.revokedAt, 'der eingeschlafene dauerhafte Token ist nicht widerrufen');
    assert.equal(ende.rotatedAt, null, 'der Leerlauf wurde als Rotation verbucht');
    assert.equal(
      await datenbank().refreshToken.count({ where: { family: sitzung.familie, revokedAt: null } }),
      0,
      'die Familie hat noch einen lebenden Token',
    );
  });

  /**
   * Der zweite Versuch mit einem eingeschlafenen Token.
   *
   * Der Leerlauf widerruft (`revokedAt`) ohne `rotatedAt`. Kommt derselbe
   * Token noch einmal, greift deshalb nicht die Kulanz für verlorene
   * Wettläufe zweier Tabs, sondern die Wiederverwendungserkennung: Familie
   * gesperrt, `REFRESH_REUSE_DETECTED` (CRITICAL) im Sicherheitsprotokoll. So
   * steht es im Dienst ausdrücklich — ein Token, den nicht die Rotation
   * verbraucht hat (Abmelden, Leerlauf), bleibt bei der
   * Wiederverwendungserkennung —, und diese Datei hält es fest, damit es eine
   * Entscheidung bleibt und nicht zufällig kippt.
   *
   * Ein ehrlicher Browser legt den Token kein zweites Mal vor: Die erste
   * Antwort hat seine Cookies gelöscht. Wer ihn trotzdem vorlegt, hat eine
   * Kopie. Die Kehrseite steht als offener Punkt im Register
   * (`docs/PENDENZEN.md`, Abschnitt Sitzung): Stellt ein Browser nach langer
   * Pause mehrere Tabs gleichzeitig wieder her, schicken sie denselben Token
   * fast zugleich über die Middleware; der erste schläft ein, die übrigen
   * können den Alarm auslösen, obwohl niemand etwas kopiert hat.
   */
  it('ein wegen Leerlaufs widerrufener Token bleibt widerrufen — auch beim zweiten Versuch', async () => {
    const sitzung = await anmelden();
    await zurueckdatieren(sitzung.tokenId, LEERLAUF_S + RAND_S);
    try {
      const erste = await erneuern(sitzung.jar);
      assert.equal(erste.status, 401, erste.text);
      assert.match(fehler(erste).message ?? '', /Inaktivität/);

      const zweite = await erneuern(sitzung.jar);
      assert.equal(zweite.status, 401, `ein eingeschlafener Token wurde beim zweiten Versuch wieder angenommen: ${zweite.text}`);
      assert.equal(fehler(zweite).code, 'UNAUTHORIZED', 'der zweite Versuch lief in die Kulanz für verlorene Wettläufe');
      assert.match(fehler(zweite).message ?? '', /Sicherheitsgründen/, 'der zweite Versuch lief nicht in die Wiederverwendungserkennung');
      assert.equal(erneuerungstoken(zweite.cookies), '', 'der zweite Versuch hat einen neuen Token ausgestellt');

      assert.equal(
        await datenbank().refreshToken.count({ where: { family: sitzung.familie, revokedAt: null } }),
        0,
        'die Familie lebt weiter',
      );
      assert.equal(await datenbank().refreshToken.count({ where: { family: sitzung.familie } }), 1, 'es wurde ein Token nachgeschoben');

      const gemeldet = await alarme(sitzung.familie);
      assert.equal(gemeldet.length, 1, `genau ein Alarm erwartet, gefunden: ${gemeldet.length}`);
      assert.equal(gemeldet[0]!.userId, sitzung.userId, 'der Alarm nennt ein anderes Konto');
      assert.equal(gemeldet[0]!.severity, 'CRITICAL');
      assert.ok(
        !JSON.stringify(gemeldet[0]!.context).includes(tokenHash(erneuerungstoken(sitzung.jar))),
        'der Tokenhash steht im Alarm',
      );
    } finally {
      await datenbank().securityEvent.deleteMany({
        where: { kind: 'REFRESH_REUSE_DETECTED', context: { path: ['family'], equals: sitzung.familie } },
      });
    }
  });

  it('die Middleware schickt eine eingeschlafene Sitzung zur Anmeldung', async () => {
    const sitzung = await anmelden();
    await zurueckdatieren(sitzung.tokenId, LEERLAUF_S + RAND_S);
    const ziel = '/admin/kunden?seite=2';

    // Seitenaufruf mit abgelaufenem Zugangstoken (nur noch das
    // Erneuerungscookie, wie im Browser nach einer Viertelstunde): Die
    // Middleware kann auf der Edge nicht selbst erneuern und schickt zur
    // Erneuerungsroute. Deren Adresse wird ohne Ursprung übernommen — welchen
    // Host die Middleware nennt, prüft `session-refresh.test.ts`.
    const seite = await get(ziel, { jar: nurErneuerung(sitzung.jar), headers: KOPF, retries: 0 });
    assert.equal(seite.status, 307, `erwartet Umweg über die Erneuerung, erhalten ${seite.status}`);
    const umweg = new URL(seite.headers.get('location') ?? '', BASE_URL);
    assert.equal(umweg.pathname, '/api/auth/refresh');
    assert.equal(umweg.searchParams.get('weiter'), ziel);

    // Die Erneuerung scheitert am Leerlauf und leitet zur Anmeldung — mit
    // Rücksprungziel und Grund, nicht zurück ans Ziel (das wäre ein Kreis
    // zwischen Middleware und Erneuerung).
    const erneuerung = await get(`${umweg.pathname}${umweg.search}`, {
      jar: nurErneuerung(sitzung.jar),
      headers: KOPF,
      retries: 0,
    });
    assert.equal(erneuerung.status, 303, erneuerung.text);
    const anmeldung = new URL(erneuerung.headers.get('location') ?? '', BASE_URL);
    assert.equal(anmeldung.origin, new URL(BASE_URL).origin, 'die Anmeldung liegt auf einem anderen Ursprung');
    assert.equal(anmeldung.pathname, '/auth/anmelden', `Weiterleitung nach ${anmeldung.pathname}`);
    assert.equal(anmeldung.searchParams.get('grund'), 'abgelaufen');
    assert.equal(anmeldung.searchParams.get('weiter'), ziel, 'das Rücksprungziel ging verloren');
    for (const name of ['clenaris_at', 'clenaris_rt']) {
      assert.ok(geloescht(erneuerung.headers, name), `${name} wird nicht gelöscht: ${cookieNamen(erneuerung.headers)}`);
    }

    const zeile = await datenbank().refreshToken.findUniqueOrThrow({ where: { id: sitzung.tokenId } });
    assert.ok(zeile.revokedAt, 'der Seitenweg hat den eingeschlafenen Token nur abgewiesen, nicht widerrufen');
    assert.equal(zeile.rotatedAt, null, 'der Leerlauf wurde als Rotation verbucht');

    // Und der Weg ist zu Ende: Ohne die gelöschten Cookies landet derselbe
    // Seitenaufruf direkt bei der Anmeldung, nicht noch einmal bei der
    // Erneuerung.
    const danach = await get(ziel, { headers: KOPF, retries: 0 });
    assert.equal(danach.status, 307);
    assert.equal(new URL(danach.headers.get('location') ?? '', BASE_URL).pathname, '/auth/anmelden');
  });
});
