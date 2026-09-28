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
 * Das Leerlauffenster selbst (15 Minuten) lässt sich über HTTP nicht warten;
 * die Ablehnung eines alten Tokens ist Sache des Dienstes und dort mit einem
 * Zeitvergleich abgesichert.
 */

/** Nur das Refresh-Cookie aus einem Cookie-Kopf — wie ein Browser nach Ablauf des Zugangstokens. */
function refreshOnly(jar: string): string {
  return jar
    .split('; ')
    .filter((cookie) => cookie.startsWith('clenaris_rt='))
    .join('; ');
}

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
   * Die Invariante: genau **eine** Erneuerung gelingt, alle anderen scheitern
   * ungefährlich (401, ohne Cookies zu löschen), und die Familie lebt weiter —
   * mit genau einem gültigen Token.
   */
  it('fünfzig gleichzeitige Erneuerungen: genau eine gelingt, die Familie bleibt heil', async () => {
    resetRateLimits();
    const frisch = await login(ACCOUNTS.manager.email, ACCOUNTS.manager.password);
    assert.equal(frisch.status, 200);
    const nurRefresh = refreshOnly(frisch.jar);

    const antworten = await Promise.all(
      Array.from({ length: 50 }, () => fetch(`${BASE_URL}/api/auth/refresh`, { method: 'POST', headers: { cookie: nurRefresh } })),
    );
    const status = antworten.map((a) => a.status);
    assert.equal(status.filter((s) => s === 200).length, 1, `Erfolge: ${JSON.stringify(status)}`);
    assert.ok(status.every((s) => s === 200 || s === 401), `nur 200 oder 401 erwartet: ${JSON.stringify(status)}`);

    // Keine abgewiesene Antwort löscht Cookies — sie käme im Browser womöglich
    // nach der erfolgreichen an und nähme ihr die neue Sitzung wieder weg.
    for (const a of antworten.filter((x) => x.status === 401)) {
      const geloescht = (a.headers.getSetCookie?.() ?? []).some((c) => /clenaris_(at|rt)=;/.test(c) || /Max-Age=0/i.test(c));
      assert.ok(!geloescht, 'eine verlorene Erneuerung löscht die Cookies');
    }

    const gewinner = antworten.find((a) => a.status === 200)!;
    const neueCookies = (gewinner.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    const pruefung = await get<{ data: { authenticated: boolean } }>('/api/auth/session', { jar: neueCookies });
    assert.equal(pruefung.payload.data.authenticated, true, 'die neue Sitzung trägt — die Familie wurde nicht gesperrt');
    const weiter = await post('/api/auth/refresh', undefined, { jar: refreshOnly(neueCookies) });
    assert.equal(weiter.status, 200, 'der neue Token lässt sich seinerseits erneuern');
  });
});
