import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { del, get, nextSecond, patch, post, requireServer, sleep } from '../helpers/client';
import { ACCOUNTS, login, loginAs } from '../helpers/accounts';
import { resetRateLimits } from '../helpers/rate-limit';
import { totp } from '../helpers/totp';
import { eigeneOrganisationId, schutzfreiAufraeumen, testDb, testDbGrund, testDbSchliessen } from '../helpers/testdb';

/**
 * Zwei-Faktor-Anmeldung, von aussen über HTTP.
 *
 * Die Prüfungen bauen aufeinander auf — einrichten, anmelden, ausschalten —
 * und laufen deshalb der Reihe nach in einer Datei. `node:test` führt `it`
 * innerhalb eines `describe` in Reihenfolge aus; das ist hier Absicht und kein
 * Versehen: Ein „Ausschalten"-Test ohne vorheriges Einschalten prüfte nichts.
 *
 * Als Testkonto dient die Betriebsleitung. Die Systemverantwortung eignet sich
 * nicht: Ihr Faktor liesse sich am Ende von niemandem zurücksetzen.
 */

const SUBJECT = ACCOUNTS.manager;

let superJar = '';
let subjectId = '';
let secret = '';
let recoveryCodes: string[] = [];
let jar = '';

describe('Zwei-Faktor-Anmeldung', { concurrency: 1 }, () => {
  before(async () => {
    await requireServer();
    superJar = await loginAs('super');

    // `perPage` gab es nie (ignoriert); seit die Liste seitenweise ist, wird gezielt gesucht.
    const list = await get<{ data: { id: string; email: string }[] }>(`/api/users?q=${encodeURIComponent(SUBJECT.email)}`, {
      jar: superJar,
    });
    const found = list.payload?.data?.find((user) => user.email === SUBJECT.email);
    assert.ok(found, `Testkonto ${SUBJECT.email} nicht gefunden — Datenbank befüllt?`);
    subjectId = found.id;

    // Ein früherer Lauf könnte den Faktor stehen gelassen haben.
    await del(`/api/users/${subjectId}/2fa`, { jar: superJar });
  });

  after(async () => {
    /**
     * Der Ausgangszustand muss stehen, auch wenn der Lauf mittendrin abbrach.
     *
     * Diese Datei fasst ein Konto an, das alle anderen Prüfungen ebenfalls
     * benutzen: Sie schaltet einen zweiten Faktor ein, sperrt zwischendurch
     * und setzt die Rolle herab. Bliebe davon etwas stehen, meldeten die
     * nächsten Dateien Fehler in der Rechtematrix, die es nicht gibt — und
     * man suchte sie dort statt hier.
     */
    await del(`/api/users/${subjectId}/2fa`, { jar: superJar });
    await patch(`/api/users/${subjectId}`, { status: 'ACTIVE' }, { jar: superJar });
    await patch(`/api/users/${subjectId}/role`, { role: 'MANAGER' }, { jar: superJar });
  });

  // -------------------------------------------------------------------------
  describe('Einrichtung', () => {
    it('meldet sich ohne eingeschalteten Faktor einstufig an', async () => {
      const result = await login(SUBJECT.email, SUBJECT.password);
      assert.equal(result.status, 200);
      assert.notEqual(result.payload?.data?.twoFactorRequired, true);
      jar = result.jar;
    });

    it('meldet den Zustand „aus"', async () => {
      const status = await get<{ data: { enabled: boolean } }>('/api/auth/2fa', { jar });
      assert.equal(status.payload.data.enabled, false);
    });

    it('liefert Geheimnis, QR-Code und otpauth-URL', async () => {
      const setup = await post<{
        data: { secret: string; qrCode: string; otpauthUrl: string };
      }>('/api/auth/2fa/setup', undefined, { jar });

      assert.equal(setup.status, 200);
      secret = setup.payload.data.secret;

      assert.match(secret, /^[A-Z2-7]{32}$/, 'Geheimnis muss base32 sein — 160 Bit, RFC 4226');
      assert.ok(setup.payload.data.qrCode.startsWith('data:image/png;base64,'));
      assert.ok(setup.payload.data.otpauthUrl.includes('issuer=Clenaris'));
      assert.ok(setup.payload.data.otpauthUrl.includes(encodeURIComponent(SUBJECT.email)));
    });

    it('stellt den Schutz noch nicht scharf', async () => {
      // Sonst sperrt sich aus, wer den QR-Code scannt und dann das Telefon
      // zurücksetzt — und merkt es erst bei der nächsten Anmeldung.
      const status = await get<{ data: { enabled: boolean } }>('/api/auth/2fa', { jar });
      assert.equal(status.payload.data.enabled, false);
    });

    it('weist einen falschen Code ab', async () => {
      const wrong = await post('/api/auth/2fa/confirm', { token: '000000' }, { jar });
      assert.ok([400, 401].includes(wrong.status), `unerwartet HTTP ${wrong.status}`);
    });

    it('schaltet mit dem richtigen Code ein und gibt zehn Ersatzcodes aus', async () => {
      const confirm = await post<{ data: { recoveryCodes: string[] } }>(
        '/api/auth/2fa/confirm',
        { token: totp(secret) },
        { jar },
      );

      assert.equal(confirm.status, 200);
      recoveryCodes = confirm.payload.data.recoveryCodes;

      assert.equal(recoveryCodes.length, 10);
      assert.equal(new Set(recoveryCodes).size, 10, 'Codes müssen verschieden sein');
      for (const code of recoveryCodes) {
        // Ohne 0/O/1/I/L — sie werden abgeschrieben, oft in Eile.
        assert.match(code, /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
      }
    });

    it('gibt weder Geheimnis noch Codes im Zustand preis', async () => {
      const status = await get<{
        data: { enabled: boolean; remainingRecoveryCodes: number };
      }>('/api/auth/2fa', { jar });

      assert.equal(status.payload.data.enabled, true);
      assert.equal(status.payload.data.remainingRecoveryCodes, 10);
      assert.ok(!status.text.includes(secret));
      assert.ok(!status.text.includes(recoveryCodes[0]));
    });

    it('überschreibt einen scharfen Faktor nicht', async () => {
      // Sonst genügte ein Aufruf, um den Schutz einer übernommenen Sitzung
      // unbrauchbar zu machen.
      const again = await post('/api/auth/2fa/setup', undefined, { jar });
      assert.equal(again.status, 422);
    });
  });

  // -------------------------------------------------------------------------
  describe('Anmeldung in zwei Schritten', () => {
    let pendingJar = '';
    let setCookies: string[] = [];

    it('verlangt nach dem Passwort einen zweiten Schritt', async () => {
      // Eine Anmeldung, zwei Prüfungen: Der Vorgang liegt hinter demselben
      // strengen Limit wie jede andere Anmeldung, und dieser Test fährt ihn
      // ohnehin oft genug an.
      const step1 = await login(SUBJECT.email, SUBJECT.password);
      assert.equal(step1.status, 200);
      assert.equal(step1.payload.data.twoFactorRequired, true);
      assert.equal(step1.payload.data.redirectTo, '/auth/bestaetigen');

      pendingJar = step1.jar;
      setCookies = step1.headers.getSetCookie?.() ?? [];

      // Solange der zweite Faktor fehlt, darf die Antwort nichts über die
      // Person verraten — auch nicht die Rolle.
      assert.equal(step1.payload.data.role, undefined);
      assert.equal(step1.payload.data.id, undefined);
      assert.ok(!step1.text.toLowerCase().includes(SUBJECT.email));
    });

    it('setzt einen kurzlebigen Zwischenschein statt eines Zugangstokens', () => {
      const mfa = setCookies.find((cookie) => cookie.startsWith('clenaris_mfa='));

      assert.ok(mfa, 'kein Zwischenschein gesetzt');
      assert.match(mfa, /httponly/i);
      assert.match(mfa, /max-age=300/i, 'der Zwischenschein muss nach fünf Minuten verfallen');
      assert.ok(
        !setCookies.some((cookie) => cookie.startsWith('clenaris_at=')),
        'zwischen Passwort und Code darf keine Sitzung entstehen',
      );
    });

    it('öffnet mit dem Zwischenschein keine geschützten Endpunkte', async () => {
      const misuse = await get('/api/auth/2fa', { jar: pendingJar });
      assert.equal(misuse.status, 401);
    });

    it('weist einen falschen Code ab', async () => {
      const bad = await post('/api/auth/2fa/verify', { token: '111111' }, { jar: pendingJar });
      assert.equal(bad.status, 401);
    });

    it('meldet mit dem richtigen Code an', async () => {
      const verify = await post<{ data: { usedRecoveryCode: boolean } }>(
        '/api/auth/2fa/verify',
        { token: totp(secret) },
        { jar: pendingJar },
      );

      assert.equal(verify.status, 200);
      assert.equal(verify.payload.data.usedRecoveryCode, false);
      assert.match(verify.cookies, /clenaris_at=/, 'erst jetzt darf das Zugangstoken kommen');

      jar = verify.cookies;
      const check = await get('/api/auth/2fa', { jar });
      assert.equal(check.status, 200, 'die neue Sitzung muss Rechte tragen');
    });
  });

  // -------------------------------------------------------------------------
  describe('Wiederherstellungscodes', () => {
    it('meldet mit einem Ersatzcode an und zählt ihn ab', async () => {
      const step1 = await login(SUBJECT.email, SUBJECT.password);
      const used = await post<{
        data: { usedRecoveryCode: boolean; remainingRecoveryCodes: number };
      }>('/api/auth/2fa/verify', { token: recoveryCodes[0] }, { jar: step1.jar });

      assert.equal(used.status, 200);
      assert.equal(used.payload.data.usedRecoveryCode, true);
      assert.equal(used.payload.data.remainingRecoveryCodes, 9);
    });

    it('nimmt denselben Code kein zweites Mal', async () => {
      const step1 = await login(SUBJECT.email, SUBJECT.password);
      const reuse = await post(
        '/api/auth/2fa/verify',
        { token: recoveryCodes[0] },
        { jar: step1.jar },
      );
      assert.equal(reuse.status, 401);
    });

    it('akzeptiert Kleinschreibung', async () => {
      // Abgeschrieben wird selten in Grossbuchstaben.
      const step1 = await login(SUBJECT.email, SUBJECT.password);
      const lower = await post(
        '/api/auth/2fa/verify',
        { token: recoveryCodes[1].toLowerCase() },
        { jar: step1.jar },
      );
      assert.equal(lower.status, 200);
      jar = lower.cookies;
    });
  });

  // -------------------------------------------------------------------------
  describe('Ausschalten', () => {
    it('verlangt das richtige Passwort', async () => {
      const attempt = await post(
        '/api/auth/2fa/disable',
        { password: 'Falsch#2026Clenaris', token: totp(secret) },
        { jar },
      );
      assert.equal(attempt.status, 401);
    });

    it('verlangt einen gültigen Code', async () => {
      const attempt = await post(
        '/api/auth/2fa/disable',
        { password: SUBJECT.password, token: '000000' },
        { jar },
      );
      assert.equal(attempt.status, 401);
    });

    it('lässt den Faktor nach Fehlversuchen unverändert', async () => {
      const status = await get<{ data: { enabled: boolean } }>('/api/auth/2fa', { jar });
      assert.equal(status.payload.data.enabled, true);
    });

    it('schaltet mit Passwort und Code zusammen aus', async () => {
      const disable = await post(
        '/api/auth/2fa/disable',
        { password: SUBJECT.password, token: totp(secret) },
        { jar },
      );
      assert.equal(disable.status, 204);

      const after = await login(SUBJECT.email, SUBJECT.password);
      assert.equal(after.status, 200);
      assert.notEqual(after.payload.data.twoFactorRequired, true);
      jar = after.jar;
    });
  });

  // -------------------------------------------------------------------------
  describe('Zurücksetzen durch die Systemverantwortung', () => {
    it('schaltet für die Prüfung wieder ein', async () => {
      const setup = await post<{ data: { secret: string } }>('/api/auth/2fa/setup', undefined, {
        jar,
      });
      secret = setup.payload.data.secret;
      await post('/api/auth/2fa/confirm', { token: totp(secret) }, { jar });

      const status = await get<{ data: { enabled: boolean } }>('/api/auth/2fa', { jar });
      assert.equal(status.payload.data.enabled, true);
    });

    it('verwehrt es der Administration', async () => {
      // Es ist die einzige Handlung, die einen Schutz von aussen entfernt.
      const adminJar = await loginAs('admin');
      const attempt = await del(`/api/users/${subjectId}/2fa`, { jar: adminJar });
      assert.equal(attempt.status, 403);
    });

    it('erlaubt es der Systemverantwortung und beendet dabei alle Sitzungen', async () => {
      await nextSecond();
      const reset = await del(`/api/users/${subjectId}/2fa`, { jar: superJar });
      assert.equal(reset.status, 204);

      const orphaned = await get('/api/auth/2fa', { jar });
      assert.equal(
        orphaned.status,
        401,
        'ist das Konto übernommen worden, muss der Zugriff hier enden',
      );
    });

    it('meldet beim zweiten Mal, dass es nichts zurückzusetzen gibt', async () => {
      const twice = await del(`/api/users/${subjectId}/2fa`, { jar: superJar });
      assert.equal(twice.status, 422);
    });
  });

  // -------------------------------------------------------------------------
  describe('Widerruf wirkt sofort', () => {
    /**
     * Das Zugangstoken ist ein signiertes JWT und lässt sich nicht löschen.
     * Ohne den Widerrufszeitpunkt auf dem Konto liefe eine gesperrte,
     * herabgestufte oder zurückgesetzte Sitzung noch bis zu fünfzehn Minuten
     * weiter — genau in der Zeit, in der die Sperre wirken soll.
     */

    it('beendet die Sitzung bei einer Sperrung', async () => {
      const victim = await login(SUBJECT.email, SUBJECT.password);
      assert.equal((await get('/api/auth/2fa', { jar: victim.jar })).status, 200);

      await nextSecond();
      const suspend = await patch(
        `/api/users/${subjectId}`,
        { status: 'SUSPENDED' },
        { jar: superJar },
      );
      assert.equal(suspend.status, 200);

      const blocked = await get('/api/auth/2fa', { jar: victim.jar });
      assert.equal(blocked.status, 401);

      await patch(`/api/users/${subjectId}`, { status: 'ACTIVE' }, { jar: superJar });
    });

    it('beendet die Sitzung bei einem Rollenwechsel', async () => {
      const victim = await login(SUBJECT.email, SUBJECT.password);
      await nextSecond();
      await patch(`/api/users/${subjectId}/role`, { role: 'EMPLOYEE' }, { jar: superJar });

      const blocked = await get('/api/auth/2fa', { jar: victim.jar });
      assert.equal(blocked.status, 401, 'sonst behielte die Person ihre alten Rechte');

      await patch(`/api/users/${subjectId}/role`, { role: 'MANAGER' }, { jar: superJar });
    });

    it('sperrt den eigenen Passwortwechsel nicht selbst aus', async () => {
      // Hier wird zuerst widerrufen und unmittelbar danach neu ausgestellt.
      const session = await login(SUBJECT.email, SUBJECT.password);
      const changed = await patch(
        '/api/auth/password',
        {
          currentPassword: SUBJECT.password,
          password: 'Zwischen#2026Clenaris',
          confirmPassword: 'Zwischen#2026Clenaris',
        },
        { jar: session.jar },
      );
      assert.ok([200, 204].includes(changed.status), `unerwartet HTTP ${changed.status}`);

      const newJar = changed.cookies || session.jar;
      const survives = await get('/api/auth/2fa', { jar: newJar });
      assert.equal(survives.status, 200, 'wer sein Passwort ändert, soll nicht hinausfliegen');

      // Zurückdrehen, damit der Lauf wiederholbar bleibt.
      await patch(
        '/api/auth/password',
        {
          currentPassword: 'Zwischen#2026Clenaris',
          password: SUBJECT.password,
          confirmPassword: SUBJECT.password,
        },
        { jar: newJar },
      );
      const restored = await login(SUBJECT.email, SUBJECT.password);
      assert.equal(restored.status, 200, 'das ursprüngliche Passwort muss wieder gelten');
    });

    it('verwirft ein Token, das älter ist als der Widerruf', async () => {
      const session = await login(SUBJECT.email, SUBJECT.password);
      await sleep(1500);
      await patch(`/api/users/${subjectId}/role`, { role: 'EMPLOYEE' }, { jar: superJar });

      const gone = await get('/api/auth/2fa', { jar: session.jar });
      assert.equal(gone.status, 401);

      await patch(`/api/users/${subjectId}/role`, { role: 'MANAGER' }, { jar: superJar });
    });
  });
});

// ===========================================================================
//  Nebenläufigkeit: derselbe Ersatzcode, fünfmal gleichzeitig
// ===========================================================================

/**
 * Ein Wiederherstellungscode öffnet genau **eine** Sitzung — auch dann, wenn
 * er fünfmal im selben Augenblick vorgelegt wird.
 *
 * Nacheinander war das belegt („nimmt denselben Code kein zweites Mal"),
 * gleichzeitig nicht. Gerade dort lag der Fehler: `completeMfaLogin` las den
 * Vorrat, prüfte zehn Argon2-Hashes und schrieb danach die Liste ohne den
 * Code zurück. Alle fünf Anfragen lasen denselben Vorrat, bevor die erste
 * schrieb, und bekamen alle eine Sitzung. Wer einen abgeschriebenen Code in
 * die Hände bekommt, hätte ihn so parallel zur Besitzerin mitbenutzen können.
 *
 * **Wegwerfkonto statt Demokonto.** Die Betriebsleitung oben teilen alle
 * Dateien über den Sitzungs-Cache; ein nach einem Abbruch stehen gebliebener
 * Faktor legte die ganze folgende Reihe lahm. Das Konto dieser Domain räumt
 * `ersatzcodeAufraeumen()` vor und nach dem Lauf weg, samt Protokollzeilen.
 *
 * Alle fünf Anfragen tragen **denselben** Zwischenschein. Das ist nicht
 * geschönt: Der Schein ist zustandslos und bis zu seinem Ablauf beliebig oft
 * vorlegbar — die Einmaligkeit hängt allein am Code. Fünf eigene Anmeldungen
 * verbrauchten zudem das Anmeldelimit (acht je fünf Minuten und Adresse), auf
 * dem auch `/api/auth/2fa/verify` liegt.
 */
const ERSATZ_DOMAIN = '@zweifaktor-nebenlaeufig-pruef.example.ch';
const ERSATZ_PASSWORT = 'Ersatz#2026Gleichzeitig';

async function ersatzcodeAufraeumen(): Promise<void> {
  const db = testDb();
  if (!db) return;
  const konten = await db.user.findMany({ where: { email: { endsWith: ERSATZ_DOMAIN } }, select: { id: true } });
  const ids = konten.map((konto) => konto.id);
  if (ids.length === 0) return;
  await db.securityEvent.deleteMany({ where: { userId: { in: ids } } });
  // Das Prüfprotokoll lässt sich nur fortschreiben (seit 2026-09-30): die
  // Zeilen über `schutzfreiAufraeumen`, das Konto danach ausserhalb davon,
  // damit `ON DELETE SET NULL` greift.
  await schutzfreiAufraeumen((tx) => tx.auditLog.deleteMany({ where: { OR: [{ userId: { in: ids } }, { entityId: { in: ids } }] } }));
  await db.refreshToken.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
}

describe('Zwei-Faktor-Anmeldung: Nebenläufigkeit der Ersatzcodes', { concurrency: 1 }, () => {
  const email = `gleichzeitig.${Date.now()}${ERSATZ_DOMAIN}`;
  let userId = '';
  let codes: string[] = [];

  before(async () => {
    await requireServer();
    const db = testDb();
    assert.ok(db, `kein Zugang zur Testdatenbank: ${testDbGrund()}`);
    await ersatzcodeAufraeumen();

    const org = await eigeneOrganisationId();
    assert.ok(org, 'eigene Organisation nicht gefunden');
    const { hashPassword } = await import('../../src/lib/auth/password');
    const user = await db.user.create({
      data: {
        organizationId: org,
        email,
        passwordHash: await hashPassword(ERSATZ_PASSWORT),
        firstName: 'Ersatz',
        lastName: 'Gleichzeitig',
        role: 'CUSTOMER',
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    userId = user.id;

    // Volles Kontingent: eine Anmeldung zum Einrichten, eine für den
    // Zwischenschein, fünf Einlösungen — sieben von acht.
    resetRateLimits();
    const anmeldung = await login(email, ERSATZ_PASSWORT);
    assert.equal(anmeldung.status, 200, anmeldung.text);
    const setup = await post<{ data: { secret: string } }>('/api/auth/2fa/setup', undefined, { jar: anmeldung.jar });
    assert.equal(setup.status, 200, setup.text);
    const confirm = await post<{ data: { recoveryCodes: string[] } }>(
      '/api/auth/2fa/confirm',
      { token: totp(setup.payload.data.secret) },
      { jar: anmeldung.jar },
    );
    assert.equal(confirm.status, 200, confirm.text);
    codes = confirm.payload.data.recoveryCodes;
    assert.equal(codes.length, 10);
  });

  after(async () => {
    await ersatzcodeAufraeumen();
    await testDbSchliessen();
  });

  it('derselbe Ersatzcode fünfmal gleichzeitig eingelöst: genau eine Sitzung, vier 401, ein Code weniger im Vorrat', async () => {
    const db = testDb()!;
    const schritt1 = await login(email, ERSATZ_PASSWORT);
    assert.equal(schritt1.status, 200, schritt1.text);
    assert.equal(schritt1.payload.data.twoFactorRequired, true);

    const sitzungenVorher = await db.refreshToken.count({ where: { userId } });

    const antworten = await Promise.all(
      Array.from({ length: 5 }, () =>
        post<{ data: { usedRecoveryCode: boolean; remainingRecoveryCodes: number } }>(
          '/api/auth/2fa/verify',
          { token: codes[0] },
          { jar: schritt1.jar },
        ),
      ),
    );
    const status = antworten.map((antwort) => antwort.status).sort();

    assert.deepEqual(status, [200, 401, 401, 401, 401], `Statuscodes: ${status.join(', ')}`);

    const gewinner = antworten.find((antwort) => antwort.status === 200)!;
    assert.equal(gewinner.payload.data.usedRecoveryCode, true);
    assert.equal(gewinner.payload.data.remainingRecoveryCodes, 9, 'der Gewinner meldet einen falschen Restvorrat');

    // Die Verlierer dürfen kein Zugangstoken erhalten haben — ein 401 mit
    // gesetztem Cookie wäre eine geöffnete Sitzung mit falschem Statuscode.
    const mitToken = antworten.filter((antwort) => /clenaris_at=[^;\s]/.test(antwort.cookies));
    assert.equal(mitToken.length, 1, `${mitToken.length} Zugangstoken ausgestellt`);

    // Und der Bestand: eine neue Sitzung, genau ein Code verbraucht, genau
    // eine Anmeldung per Ersatzcode in den Sicherheitsereignissen.
    assert.equal(await db.refreshToken.count({ where: { userId } }), sitzungenVorher + 1, 'mehr als eine Sitzung entstanden');
    const vorrat = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { twoFactorRecoveryCodes: true } });
    assert.equal(vorrat.twoFactorRecoveryCodes.length, 9);
    assert.equal(
      await db.securityEvent.count({
        where: { userId, kind: 'LOGIN_SUCCEEDED', summary: { contains: 'Wiederherstellungscode' } },
      }),
      1,
      'mehr als eine Anmeldung per Ersatzcode protokolliert',
    );
  });
});
