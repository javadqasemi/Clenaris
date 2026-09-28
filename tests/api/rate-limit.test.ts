import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { get, post } from '../helpers/client.js';
import { loginAll } from '../helpers/accounts.js';
import { rateLimitResetAvailable, resetRateLimits } from '../helpers/rate-limit.js';

/**
 * Die Rate-Limits — dass sie greifen, wo sie greifen sollen, und nur dort.
 *
 * **Warum diese Datei erst jetzt existiert.** Bis Gate 4B.1 gab es keinen
 * Weg, einen vollgelaufenen Zähler wieder zu leeren; ein Test, der das
 * Anmeldelimit absichtlich erreicht, hätte fünf Minuten lang jede weitere
 * Anmeldung blockiert. Mit dem dateibasierten Zähler des Testservers
 * (`CLENARIS_TEST_CACHE_DIR`) räumt `resetRateLimits()` hinterher auf — aus
 * dem Testprozess, nicht über HTTP.
 *
 * Geprüft wird gegen die **unveränderten** Produktionswerte aus
 * `src/lib/rate-limit.ts`. Kein Limit wurde für die Reihe gesenkt.
 *
 * Ohne den dateibasierten Zähler (Server ohne die Variable) wird die Datei
 * übersprungen statt zu scheitern: Sie könnte sonst nicht aufräumen.
 */

type Zugaenge = Awaited<ReturnType<typeof loginAll>>;
let jars: Zugaenge;

const ohneReset = { skip: rateLimitResetAvailable() ? false : 'Testserver ohne CLENARIS_TEST_CACHE_DIR — Zähler nicht rücksetzbar' };

/** `retries: 0`: Ein 429 soll hier sichtbar werden, nicht ausgesessen. */
const roh = { retries: 0 };

before(async () => {
  jars = await loginAll();
});

after(() => {
  resetRateLimits();
});

describe('Rate-Limits — Semantik gegen die echten Werte', () => {
  it('Anmeldung: acht Versuche je Adresse, der neunte bekommt 429 mit Retry-After im Fenster', ohneReset, async () => {
    resetRateLimits();
    // Ein Konto, das es nicht gibt: zählt am Adresslimit, sperrt aber kein echtes Konto.
    const email = `niemand-${randomBytes(4).toString('hex')}@example.ch`;
    for (let i = 1; i <= 8; i++) {
      const antwort = await post('/api/auth/login', { email, password: 'Falsch#2026Clenaris' }, roh);
      assert.equal(antwort.status, 401, `Versuch ${i}: ${antwort.status}`);
      assert.equal(antwort.headers.get('retry-after'), null, 'kein Retry-After, solange das Kontingent reicht');
    }
    const neunter = await post('/api/auth/login', { email, password: 'Falsch#2026Clenaris' }, roh);
    assert.equal(neunter.status, 429, neunter.text);
    const retryAfter = Number(neunter.headers.get('retry-after'));
    assert.ok(retryAfter >= 1 && retryAfter <= 300, `Retry-After ${retryAfter} liegt im Fünf-Minuten-Fenster`);
    // Der zehnte ebenfalls — das Fenster schliesst nicht durch Warten von Sekunden.
    assert.equal((await post('/api/auth/login', { email, password: 'Falsch#2026Clenaris' }, roh)).status, 429);

    // Nach dem kontrollierten Zurücksetzen (Äquivalent des Fensterablaufs) beginnt das Kontingent neu.
    assert.ok(resetRateLimits() >= 1, 'mindestens der Anmeldezähler wurde entfernt');
    const danach = await post('/api/auth/login', { email, password: 'Falsch#2026Clenaris' }, roh);
    assert.equal(danach.status, 401);
    assert.equal(danach.headers.get('retry-after'), null);
  });

  it('Schreibkontingent zählt je Benutzer: die Verwaltung erschöpft ihres, die Betriebsleitung nicht', ohneReset, async () => {
    resetRateLimits();
    // Ein leerer Körper wird abgewiesen (422) — der Aufruf zählt trotzdem, weil
    // das Kontingent vor der Validierung greift. Nichts wird angelegt.
    let status = 0;
    for (let i = 1; i <= 90; i++) {
      const antwort = await post('/api/faq', {}, { jar: jars.admin, ...roh });
      status = antwort.status;
      assert.notEqual(status, 429, `Aufruf ${i} liegt noch im Kontingent von 90`);
    }
    assert.equal(status, 422, 'die Validierung antwortet, solange das Kontingent reicht');
    const einundneunzig = await post('/api/faq', {}, { jar: jars.admin, ...roh });
    assert.equal(einundneunzig.status, 429, einundneunzig.text);
    assert.ok(Number(einundneunzig.headers.get('retry-after')) <= 60, 'Fenster von einer Minute');

    // Derselbe Endpunkt, anderes Konto: eigener Zähler.
    const manager = await post('/api/faq', {}, { jar: jars.manager, ...roh });
    assert.notEqual(manager.status, 429, `Betriebsleitung: ${manager.status}`);
    // Lesen hängt an einem anderen Kontingent (apiRead) und geht weiter.
    assert.equal((await get('/api/faq', { jar: jars.admin, ...roh })).status, 200);

    resetRateLimits();
    assert.equal((await post('/api/faq', {}, { jar: jars.admin, ...roh })).status, 422, 'nach dem Zurücksetzen wieder frei');
  });

  it('Signaturtausch: zwanzig Versuche je Adresse, dann 429 — geraten wird gegen 256 Bit, das Limit bremst nur', ohneReset, async () => {
    resetRateLimits();
    for (let i = 1; i <= 20; i++) {
      const antwort = await post('/api/public/signatures/exchange', { token: randomBytes(32).toString('hex') }, roh);
      assert.equal(antwort.status, 404, `Versuch ${i}: ${antwort.status}`);
    }
    const einundzwanzig = await post('/api/public/signatures/exchange', { token: randomBytes(32).toString('hex') }, roh);
    assert.equal(einundzwanzig.status, 429, einundzwanzig.text);
    assert.ok(Number(einundzwanzig.headers.get('retry-after')) <= 600);
    resetRateLimits();
    assert.equal((await post('/api/public/signatures/exchange', { token: randomBytes(32).toString('hex') }, roh)).status, 404);
  });

  it('das Zurücksetzen trifft nur Zähler — Sitzungen und Daten bleiben', ohneReset, async () => {
    resetRateLimits();
    assert.equal((await get('/api/auth/session', { jar: jars.admin })).status, 200);
    assert.equal((await get('/api/faq', { jar: jars.admin })).status, 200);
  });
});
