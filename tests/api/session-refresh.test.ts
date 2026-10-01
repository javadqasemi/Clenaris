import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { BASE_URL, get, post, requireServer } from '../helpers/client';
import { ACCOUNTS, login } from '../helpers/accounts';
import { resetRateLimits } from '../helpers/rate-limit';

/**
 * Stille Sitzungserneuerung.
 *
 * Der Fehler, den diese Datei festhält: Der Zugangstoken lief nach fünfzehn
 * Minuten ab, und nichts erneuerte ihn — mitten in der Arbeit stand die
 * Anmeldemaske, obwohl ein gültiger Refresh-Token im Browser lag. Geprüft
 * wird der Weg ohne Zugangstoken, aber mit Refresh-Token: Die Middleware muss
 * zur Erneuerung schicken, die Erneuerung muss neue Cookies setzen und
 * zurückleiten, und ein verbrauchter Token muss abgewiesen werden.
 *
 * Das Leerlauffenster selbst (15 Minuten, mit „Angemeldet bleiben" sieben
 * Tage) prüft diese Datei nicht — aber nicht mehr, weil es sich nicht prüfen
 * liesse. Bis 2026-10-01 stand hier, es lasse sich über HTTP nicht warten, und
 * die Ablehnung eines alten Tokens war nur durch Lesen des Dienstes belegt.
 * Gewartet wird auch heute nicht: `sitzung-leerlauf.test.ts` **stellt** das
 * Alter her, indem es den Erneuerungstoken in der Testdatenbank zurückdatiert,
 * und prüft dann über echtes HTTP Ablehnung, Widerruf, gelöschte Cookies,
 * „Angemeldet bleiben", den zweiten Versuch und den Weg über die Middleware.
 * Die Gegenseite im Browser — Warnung, Abmeldung, mehrere Tabs — prüft
 * `tests/e2e/sitzung-leerlauf.spec.ts`.
 *
 * Getrennt bleibt das aus einem Grund: Diese Datei braucht keinen
 * Datenbankzugang und läuft damit auch gegen einen Server, dessen Datenbank
 * die Reihe nicht erreicht. Die Leerlaufprüfung kann das nicht und scheitert
 * dann laut; hier mitgeführt, risse sie die übrigen Fälle mit.
 */

/** Nur das Refresh-Cookie aus einem Cookie-Kopf — wie ein Browser nach Ablauf des Zugangstokens. */
function refreshOnly(jar: string): string {
  return jar
    .split('; ')
    .filter((cookie) => cookie.startsWith('clenaris_rt='))
    .join('; ');
}

/**
 * Die Laufzeit der Sitzungscookies (2026-09-28).
 *
 * Bis dahin setzte jede Anmeldung einen Erneuerungscookie mit dreissig Tagen
 * `Max-Age` — auch ohne „Angemeldet bleiben". Das Kästchen stand in der Maske,
 * `rememberMe` wurde geprüft und danach verworfen: eine Scheinfunktion. Gegen
 * den alten Stand scheitert der erste Fall (`Max-Age=2592000` ohne Wahl).
 */
function sitzungscookies(headers: Headers): Record<string, string> {
  const alle = headers.getSetCookie();
  const je = (name: string) => alle.find((c) => c.startsWith(`${name}=`)) ?? '';
  return { at: je('clenaris_at'), rt: je('clenaris_rt') };
}

const laufzeit = (setCookie: string) => /max-age=(\d+)/i.exec(setCookie)?.[1];
const ablauf = (setCookie: string) => /expires=/i.test(setCookie);

describe('Sitzungscookies: an den Browser gebunden, ausser „Angemeldet bleiben"', { concurrency: 1 }, async () => {
  await requireServer();

  it('ohne Wahl: Zugangs- und Erneuerungscookie ohne Max-Age und ohne Expires — auch nach der Erneuerung', async () => {
    resetRateLimits();
    const anmeldung = await post('/api/auth/login', { email: ACCOUNTS.manager.email, password: ACCOUNTS.manager.password });
    assert.equal(anmeldung.status, 200, anmeldung.text);
    const { at, rt } = sitzungscookies(anmeldung.headers);
    assert.ok(at && rt, 'Sitzungscookies fehlen');
    for (const [name, c] of [['Zugang', at], ['Erneuerung', rt]] as const) {
      assert.equal(laufzeit(c), undefined, `${name}: Max-Age gesetzt — ${c.replace(/=[^;]+/, '=…')}`);
      assert.equal(ablauf(c), false, `${name}: Expires gesetzt`);
      assert.match(c, /httponly/i, `${name}: nicht HttpOnly`);
    }

    const erneuert = await post('/api/auth/refresh', undefined, { jar: refreshOnly(anmeldung.cookies) });
    assert.equal(erneuert.status, 200, erneuert.text);
    const nachher = sitzungscookies(erneuert.headers);
    assert.equal(laufzeit(nachher.rt), undefined, 'die Erneuerung machte aus der Browsersitzung eine dauerhafte');
  });

  it('mit „Angemeldet bleiben": Erneuerungscookie mit Laufzeit — und die Wahl überlebt die Rotation', async () => {
    resetRateLimits();
    const anmeldung = await post('/api/auth/login', { email: ACCOUNTS.manager.email, password: ACCOUNTS.manager.password, rememberMe: true });
    assert.equal(anmeldung.status, 200, anmeldung.text);
    const vorher = Number(laufzeit(sitzungscookies(anmeldung.headers).rt));
    assert.ok(vorher >= 86_400, `Erneuerungscookie ohne mehrtägige Laufzeit: ${vorher}`);

    const erneuert = await post('/api/auth/refresh', undefined, { jar: refreshOnly(anmeldung.cookies) });
    assert.equal(erneuert.status, 200, erneuert.text);
    assert.equal(Number(laufzeit(sitzungscookies(erneuert.headers).rt)), vorher, '„Angemeldet bleiben" ging bei der Erneuerung verloren');
  });

  it('die Abmeldung löscht beide Cookies und widerruft den Erneuerungstoken', async () => {
    resetRateLimits();
    const anmeldung = await post('/api/auth/login', { email: ACCOUNTS.manager.email, password: ACCOUNTS.manager.password, rememberMe: true });
    const abmeldung = await post('/api/auth/logout', undefined, { jar: anmeldung.cookies });
    assert.ok(abmeldung.status < 300, abmeldung.text);
    const nachher = sitzungscookies(abmeldung.headers);
    for (const c of [nachher.at, nachher.rt]) assert.ok(/max-age=0|expires=thu, 01 jan 1970/i.test(c), `Cookie nicht gelöscht: ${c.replace(/=[^;]+/, '=…')}`);
    const wieder = await post('/api/auth/refresh', undefined, { jar: refreshOnly(anmeldung.cookies) });
    assert.equal(wieder.status, 401, 'der Erneuerungstoken taugt nach der Abmeldung noch');
  });
});

describe('Sitzungserneuerung', { concurrency: 1 }, async () => {
  await requireServer();
  const session = await login(ACCOUNTS.manager.email, ACCOUNTS.manager.password);
  assert.equal(session.status, 200);
  const onlyRefresh = refreshOnly(session.jar);
  assert.ok(onlyRefresh.length > 0, 'kein Refresh-Cookie nach der Anmeldung');

  it('schickt einen Seitenaufruf ohne Zugangstoken zur Erneuerung statt zur Anmeldung', async () => {
    const response = await get('/portal/einsaetze?seite=2', { jar: onlyRefresh });
    assert.equal(response.status, 307);
    const location = response.headers.get('location') ?? '';
    assert.ok(location.includes('/api/auth/refresh'), `Location: ${location}`);
    assert.ok(location.includes('weiter=%2Fportal%2Feinsaetze%3Fseite%3D2'), `Rücksprungziel fehlt: ${location}`);
  });

  it('erneuert über GET, setzt neue Cookies und leitet an das Ziel zurück', async () => {
    const response = await get('/api/auth/refresh?weiter=%2Fportal%2Feinsaetze', { jar: onlyRefresh });
    assert.equal(response.status, 303);
    assert.ok((response.headers.get('location') ?? '').endsWith('/portal/einsaetze'));
    assert.ok(response.cookies.includes('clenaris_at='), 'kein neuer Zugangstoken');
    assert.ok(response.cookies.includes('clenaris_rt='), 'kein neuer Refresh-Token');

    // Die neue Sitzung trägt.
    const check = await get<{ data: { authenticated: boolean; role?: string } }>('/api/auth/session', { jar: response.cookies });
    assert.equal(check.payload.data.authenticated, true);
    assert.equal(check.payload.data.role, 'MANAGER');

    // Der alte Token ist verbraucht — eine zweite Einlösung wird abgewiesen
    // und landet bei der Anmeldung, mit Grund. (Ob sie zugleich die Familie
    // sperrt, hängt seit 2026-09-27 vom Abstand ab: Innerhalb weniger
    // Sekunden ist sie ein verlorener Wettlauf zweier Tabs, danach eine
    // Wiederverwendung — siehe den Gleichzeitigkeitsfall unten.)
    const replay = await get('/api/auth/refresh?weiter=%2Fportal', { jar: onlyRefresh });
    assert.equal(replay.status, 303);
    const location = replay.headers.get('location') ?? '';
    assert.ok(location.includes('/auth/anmelden'), `Location: ${location}`);
    assert.ok(location.includes('grund=abgelaufen'));
  });

  /**
   * **Der Befund aus Gate 4D.1.** Die Erneuerung antwortete mit
   * `Location: http://localhost:3001/portal` — auch dann, wenn die Anfrage an
   * `http://127.0.0.1:3001` ging. `request.nextUrl.origin` nennt nämlich den
   * Ursprung, unter dem der Server lauscht, nicht den aus dem `Host`-Kopf.
   *
   * Cookies sind hostgebunden. Ein Hostwechsel *innerhalb* der Erneuerung
   * lässt die soeben gesetzten Zugangs- und Refresh-Cookies zurück: Auf dem
   * neuen Host kommt die Person unangemeldet an und sieht die Anmeldemaske,
   * obwohl die Erneuerung gerade gelungen ist. Hinter einem Reverse Proxy
   * trifft das jede stille Erneuerung, denn dort ist der Ursprung des Servers
   * nie der der Adresszeile.
   *
   * Über HTTP war der 303 bis dahin ein Erfolg, weil ihm niemand folgte —
   * gefunden hat es erst ein Browser (`tests/e2e/gate4d-sperre.spec.ts`).
   */
  it('wechselt dabei nicht den Host — sonst reisen die neuen Cookies nicht mit', async () => {
    const fresh = await login(ACCOUNTS.manager.email, ACCOUNTS.manager.password);
    const response = await get('/api/auth/refresh?weiter=%2Fportal', { jar: refreshOnly(fresh.jar) });
    assert.equal(response.status, 303);

    const location = response.headers.get('location') ?? '';
    assert.ok(location.length > 0, 'keine Weiterleitung');
    assert.equal(
      new URL(location, BASE_URL).origin,
      new URL(BASE_URL).origin,
      `Die Erneuerung leitet auf einen anderen Ursprung: „${location}"`,
    );
  });

  it('lässt kein fremdes Ziel zu', async () => {
    const fresh = await login(ACCOUNTS.manager.email, ACCOUNTS.manager.password);
    const response = await get('/api/auth/refresh?weiter=//example.com/x', { jar: refreshOnly(fresh.jar) });
    assert.equal(response.status, 303);
    const location = new URL(response.headers.get('location') ?? '', 'http://localhost');
    assert.equal(location.pathname, '/');
  });

  it('antwortet auf POST ohne Cookie mit 401', async () => {
    assert.equal((await post('/api/auth/refresh')).status, 401);
  });

  /**
   * Fünfzig gleichzeitige Erneuerungen mit demselben Token (2026-09-27).
   *
   * Bis dahin lief die Rotation als Lesen → Widerrufen → Anlegen, ohne
   * Bedingung. Zwei gleichzeitige Aufrufe — Middleware, API-Klient und
   * Aktivitätswächter rufen alle hier an, in jedem offenen Tab — lasen beide
   * einen gültigen Token und stellten beide einen neuen aus: Die Familie
   * gabelte sich in zwei lebende Tokens. Oder der spätere sah den soeben
   * widerrufenen, hielt ihn für gestohlen und beendete die Sitzung der Person,
   * mit Sicherheitsmeldung, mitten in der Arbeit.
   *
   * Die Invariante: genau **eine** Erneuerung rotiert (setzt neue Cookies),
   * alle anderen enden ungefährlich — ohne Cookies zu setzen oder zu löschen
   * —, und die Familie lebt weiter, mit genau einem gültigen Token.
   *
   * Seit 2026-09-28 antworten die Verlierer mit 200 `{ erneuert: false }`
   * statt 401: Der 401 war im Browser bei zwei offenen Tabs ein roter
   * Konsolenfehler im gewöhnlichen Betrieb (Begründung an der Route). Die
   * Zusage hängt deshalb an den Cookies, nicht am Statuscode.
   */
  it('fünfzig gleichzeitige Erneuerungen: genau eine rotiert, die Familie bleibt heil', async () => {
    resetRateLimits();
    const frisch = await login(ACCOUNTS.manager.email, ACCOUNTS.manager.password);
    assert.equal(frisch.status, 200);
    const nurRefresh = refreshOnly(frisch.jar);

    const antworten = await Promise.all(
      Array.from({ length: 50 }, () => fetch(`${BASE_URL}/api/auth/refresh`, { method: 'POST', headers: { cookie: nurRefresh } })),
    );
    const status = antworten.map((a) => a.status);
    assert.ok(status.every((s) => s === 200), `nur 200 erwartet (Rotation oder verlorener Wettlauf): ${JSON.stringify(status)}`);
    const setzt = (a: Response) => (a.headers.getSetCookie?.() ?? []).some((c) => c.startsWith('clenaris_rt='));
    assert.equal(antworten.filter(setzt).length, 1, 'genau eine Antwort trägt einen neuen Erneuerungstoken');

    // Keine verlorene Antwort setzt oder löscht Cookies — sie käme im Browser
    // womöglich nach der erfolgreichen an und nähme ihr die neue Sitzung weg.
    const verlierer = antworten.filter((a) => !setzt(a));
    for (const a of verlierer) {
      assert.deepEqual(a.headers.getSetCookie?.() ?? [], [], 'eine verlorene Erneuerung setzt Cookies');
      const koerper = (await a.json()) as { data: { erneuert?: boolean; id?: string; email?: string } };
      assert.equal(koerper.data.erneuert, false);
      assert.equal(koerper.data.id ?? koerper.data.email, undefined, 'eine verlorene Erneuerung verrät Kontodaten');
    }

    const gewinner = antworten.find(setzt)!;
    const neueCookies = (gewinner.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    const pruefung = await get<{ data: { authenticated: boolean } }>('/api/auth/session', { jar: neueCookies });
    assert.equal(pruefung.payload.data.authenticated, true, 'die neue Sitzung trägt — die Familie wurde nicht gesperrt');
    const weiter = await post('/api/auth/refresh', undefined, { jar: refreshOnly(neueCookies) });
    assert.equal(weiter.status, 200, 'der neue Token lässt sich seinerseits erneuern');
  });
});
