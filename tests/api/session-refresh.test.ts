import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { get, post, requireServer } from '../helpers/client';
import { ACCOUNTS, login } from '../helpers/accounts';

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

    // Der alte Token ist verbraucht — eine zweite Einlösung sperrt die Familie
    // und landet bei der Anmeldung, mit Grund.
    const replay = await get('/api/auth/refresh?weiter=%2Fportal', { jar: onlyRefresh });
    assert.equal(replay.status, 303);
    const location = replay.headers.get('location') ?? '';
    assert.ok(location.includes('/auth/anmelden'), `Location: ${location}`);
    assert.ok(location.includes('grund=abgelaufen'));
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
});
