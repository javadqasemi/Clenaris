import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

import { get, post, del, data, requireServer } from '../helpers/client';
import { loginAll, login, ACCOUNTS, type AccountName } from '../helpers/accounts';
import { resetRateLimits } from '../helpers/rate-limit';
import {
  SECURITY_EVENTS,
  artenDerKategorie,
  verlangtBestaetigung,
  type SecurityEventKind,
} from '../../src/lib/security/events';

/**
 * Wave 3 — das Sicherheitszentrum.
 *
 * ---------------------------------------------------------------------------
 *  Was hier geprüft wird und was ausdrücklich nicht
 * ---------------------------------------------------------------------------
 *
 * Der Katalog ist eine reine Tabelle und wird direkt importiert — dieselbe
 * Begründung wie bei `dateisicherheit`: Über HTTP käme man an die Zuordnung
 * Art → Kategorie → Schwere nur über Ereignisse, die man erst auslösen müsste,
 * und manche davon (Tokenwiederverwendung, fehlender Prüfer) lassen sich von
 * aussen gar nicht herbeiführen, ohne den Server zu beschädigen.
 *
 * Alles andere läuft über HTTP: Rechte, Sichtbarkeit, Handlungen und — der
 * eigentliche Punkt dieser Wave — **dass die Ereignisse tatsächlich
 * entstehen**. Ein Katalog, den niemand füllt, ist eine Tabelle.
 *
 * ---------------------------------------------------------------------------
 *  Der wichtigste Fall zuerst
 * ---------------------------------------------------------------------------
 *
 * Ein Sicherheitsprotokoll ist genau die Datei, die jemand mitnimmt, der schon
 * drin ist. Deshalb prüft diese Reihe an mehreren Stellen, dass **nichts**
 * darin steht, was den Zugang erleichtert: kein Passwort, kein roher Token,
 * kein Hash.
 */

let jars: Record<AccountName, string>;

/** Ereignisse holen — immer als Systemverantwortung. */
async function ereignisse(query = '') {
  const antwort = await get<{
    data: {
      eintraege: {
        id: string;
        kind: string;
        severity: string;
        category: string;
        summary: string;
        context: unknown;
        ip: string | null;
        acknowledgedAt: string | null;
        user: { id: string; email: string } | null;
      }[];
      gesamt: number;
    };
  }>(`/api/security/events${query}`, { jar: jars.super });
  assert.equal(antwort.status, 200, 'die Systemverantwortung muss den Strom lesen dürfen');
  return data(antwort);
}

/**
 * Ein Wegwerfkonto für die Fälle, die ein Konto beschädigen.
 *
 * **Niemals eines der fünf gemeinsamen Demokonten.** Eine Sperre auf
 * `employee` oder ein Sitzungswiderruf auf `admin` nähme der halben Prüfreihe
 * die Anmeldung — dieselbe Falle wie bei der Gerätesperre in
 * `vor-ort-abnahme.test.ts`, nur schlechter sichtbar, weil der Schaden erst in
 * einer anderen Datei auffällt.
 *
 * Eingeladene Konten stehen auf `PENDING` und tragen ein zufälliges Kennwort,
 * das niemand kennt. Für eine Reihe von Fehlversuchen ist das genau richtig.
 *
 * **Die Rolle ist `EMPLOYEE`, und das ist keine Beliebigkeit.** Eine Einladung
 * als `CUSTOMER` legt über `ensureCustomerProfile` eine **Kundenakte** an, und
 * die bleibt stehen, wenn das Konto danach weich gelöscht wird. Mit `CUSTOMER`
 * scheiterte deshalb `addresses.test.ts`: Dort wird „irgendeine fremde Akte"
 * aus der Kundenliste genommen, und das war dann eine ohne Adressen. Der
 * Fehlschlag stand in einer anderen Datei als seine Ursache — genau die Sorte
 * Verschmutzung, die `tests/README.md` mit „jede Prüfung räumt vor und nach
 * sich auf" meint. Eine Einladung als `EMPLOYEE` legt keine Akte an; die
 * Personalakte entsteht über `createEmployee`, das hier niemand aufruft.
 */
async function wegwerfKonto(
  email: string,
  vorname: string,
): Promise<{ id: string } | null> {
  const antwort = await post<{ data: { id: string } }>(
    '/api/users',
    { email, firstName: vorname, lastName: 'Probe', role: 'EMPLOYEE', locale: 'DE' },
    { jar: jars.super },
  );

  // `null` statt einer Ausnahme: Der aufrufende Fall entscheidet, ob er sich
  // überspringt — das ist eine Aussage des Prüfberichts und keine Zeile auf
  // der Konsole, die im Rauschen untergeht.
  return antwort.status === 201 ? data(antwort) : null;
}

// ===========================================================================
//  Der Katalog — reine Tabelle, direkt geprüft
// ===========================================================================

describe('Ereigniskatalog', () => {
  it('jede Art trägt Kategorie, Schwere und eine deutsche Bezeichnung', () => {
    const arten = Object.keys(SECURITY_EVENTS) as SecurityEventKind[];
    assert.ok(arten.length >= 20, 'der Katalog soll die tatsächlich gemeldeten Fälle abdecken');

    for (const art of arten) {
      const eintrag = SECURITY_EVENTS[art];
      assert.ok(
        ['AUTHENTICATION', 'SESSION', 'ACCESS', 'PUBLIC_LINK', 'FILE', 'SYSTEM'].includes(
          eintrag.category,
        ),
        `${art}: unbekannte Kategorie`,
      );
      assert.ok(
        ['INFO', 'WARNING', 'CRITICAL'].includes(eintrag.severity),
        `${art}: unbekannte Schwere`,
      );
      assert.ok(eintrag.label.length > 3, `${art}: keine brauchbare Bezeichnung`);
      /**
       * Die Bezeichnung erscheint in der Oberfläche. Ein technischer Bezeichner
       * dort ist derselbe Fehler wie ein englischer Kommentar in einer
       * deutschen Datei — er verrät, dass niemand daran gedacht hat, wer es
       * liest.
       */
      assert.ok(
        !/^[A-Z_]+$/.test(eintrag.label),
        `${art}: die Bezeichnung ist der technische Name, kein Satz`,
      );
    }
  });

  it('die Arten sind auf die Kategorien verteilt, nicht alle in einer', () => {
    const belegt = (['AUTHENTICATION', 'SESSION', 'ACCESS', 'PUBLIC_LINK', 'FILE', 'SYSTEM'] as const)
      .map((k) => artenDerKategorie(k).length)
      .filter((n) => n > 0);

    assert.equal(belegt.length, 6, 'jede Kategorie soll mindestens eine Art haben');
  });

  /**
   * Die Regel, welche Stufe eine Bestätigung verlangt, steht an genau einer
   * Stelle. Diese Prüfung hält sie fest: Verschöbe jemand sie in die Oberfläche
   * oder in den Dienst, entstünden zwei Antworten auf dieselbe Frage.
   */
  it('genau die kritischen Arten verlangen eine Bestätigung', () => {
    for (const art of Object.keys(SECURITY_EVENTS) as SecurityEventKind[]) {
      assert.equal(
        verlangtBestaetigung(art),
        SECURITY_EVENTS[art].severity === 'CRITICAL',
        `${art}: Bestätigungspflicht und Schwere laufen auseinander`,
      );
    }
  });

  /**
   * Die Einstufungen, auf die es fachlich ankommt — festgenagelt, damit eine
   * spätere Umstufung eine bewusste Entscheidung bleibt und kein Nebeneffekt.
   */
  it('die tragenden Arten sind richtig eingestuft', () => {
    assert.equal(SECURITY_EVENTS.TWO_FACTOR_DISABLED.severity, 'CRITICAL');
    assert.equal(SECURITY_EVENTS.ACCOUNT_LOCKED.severity, 'CRITICAL');
    assert.equal(SECURITY_EVENTS.REFRESH_REUSE_DETECTED.severity, 'CRITICAL');
    assert.equal(SECURITY_EVENTS.ROLE_ASSIGNED.severity, 'CRITICAL');
    assert.equal(SECURITY_EVENTS.FILE_SCAN_INFECTED.severity, 'CRITICAL');
    assert.equal(SECURITY_EVENTS.SCANNER_MISSING.severity, 'CRITICAL');

    // Der Einzelfall ist auffällig, nicht entscheidungsbedürftig — die Aussage
    // steckt in der Häufung.
    assert.equal(SECURITY_EVENTS.LOGIN_FAILED.severity, 'WARNING');
    assert.equal(SECURITY_EVENTS.ACCESS_DENIED.severity, 'WARNING');

    assert.equal(SECURITY_EVENTS.LOGIN_SUCCEEDED.severity, 'INFO');
  });
});

// ===========================================================================
//  Rechte
// ===========================================================================

describe('Sicherheitszentrum — wer hineinkommt', () => {
  before(async () => {
    await requireServer();
    jars = await loginAll();
  });

  it('nur die Systemverantwortung liest den Ereignisstrom', async () => {
    for (const rolle of ['admin', 'manager', 'employee', 'customer'] as AccountName[]) {
      const antwort = await get('/api/security/events', { jar: jars[rolle] });
      assert.notEqual(antwort.status, 200, `${rolle} darf den Strom nicht lesen`);
      assert.ok(
        antwort.status === 403 || antwort.status === 401,
        `${rolle}: erwartet 403/401, kam ${antwort.status}`,
      );
    }

    const antwort = await get('/api/security/events', { jar: jars.super });
    assert.equal(antwort.status, 200);
  });

  it('ohne Anmeldung gar nichts', async () => {
    const antwort = await get('/api/security/events');
    assert.equal(antwort.status, 401);
  });

  /**
   * Der Unterschied zwischen Lesen und Handeln ist der Punkt der zweiten
   * Berechtigung. Hier ist er (noch) nicht beobachtbar, weil beide bei
   * derselben Rolle liegen — die Prüfung hält trotzdem fest, dass die
   * Handlungen eine eigene Berechtigung verlangen, damit eine spätere
   * Aufteilung nicht stillschweigend verlorengeht.
   */
  it('die Handlungen verlangen `security:manage`, nicht nur `security:read`', async () => {
    const quelle = await get('/api/security/events', { jar: jars.super });
    assert.equal(quelle.status, 200);

    for (const rolle of ['admin', 'manager'] as AccountName[]) {
      const entsperren = await post(
        `/api/security/users/${ACCOUNTS.employee.email}/unlock`,
        undefined,
        { jar: jars[rolle] },
      );
      assert.ok(
        entsperren.status === 403 || entsperren.status === 401,
        `${rolle} darf nicht entsperren (kam ${entsperren.status})`,
      );
    }
  });

  /**
   * Die Seite selbst, nicht nur der Endpunkt. `requirePagePermission`
   * antwortet 404 — für andere Rollen existiert sie nicht. Die Middleware
   * greift davor und leitet um; beides ist richtig, beides ist **nicht** 200.
   */
  it('die Seite /admin/sicherheit öffnet sich nur der Systemverantwortung', async () => {
    const offen = await get('/admin/sicherheit', { jar: jars.super });
    assert.equal(offen.status, 200, 'die Systemverantwortung muss die Seite sehen');
    assert.ok(
      typeof offen.text === 'string' && offen.text.includes('Sicherheit'),
      'die Seite soll tatsächlich gerendert sein',
    );

    for (const rolle of ['admin', 'manager'] as AccountName[]) {
      const antwort = await get('/admin/sicherheit', { jar: jars[rolle], redirect: 'manual' });
      assert.notEqual(antwort.status, 200, `${rolle} darf die Seite nicht sehen`);
      assert.ok(
        !(typeof antwort.text === 'string' && antwort.text.includes('Offene Entscheidungen')),
        `${rolle}: kein Inhalt der Seite darf durchscheinen`,
      );
    }
  });
});

// ===========================================================================
//  Entstehen die Ereignisse wirklich?
// ===========================================================================

describe('Ereignisse entstehen an den Stellen, an denen etwas geschieht', () => {
  before(async () => {
    await requireServer();
    jars = await loginAll();
  });

  it('eine fehlgeschlagene Anmeldung landet im Strom', async () => {
    const vorher = await ereignisse('?severity=WARNING&proSeite=200');
    const vorherZahl = vorher.eintraege.filter((e) => e.kind === 'LOGIN_FAILED').length;

    // Ein einzelner Fehlversuch soll nicht am Kontingent scheitern, das eine
    // vorherige Datei gefüllt hat — geprüft wird das Protokoll, nicht das Limit.
    resetRateLimits();
    const versuch = await post('/api/auth/login', {
      email: ACCOUNTS.customer.email,
      password: 'garantiert-falsch-fuer-die-pruefreihe',
    });
    assert.ok(
      versuch.status === 401 || versuch.status === 429,
      `erwartet 401 (oder 429 bei erschöpftem Kontingent), kam ${versuch.status}`,
    );

    // Bei 429 ist der Anmeldeversuch gar nicht bis zum Passwortvergleich
    // gekommen — dann gibt es auch kein Ereignis, und das ist richtig so.
    if (versuch.status === 429) return;

    const nachher = await ereignisse('?severity=WARNING&proSeite=200');
    const treffer = nachher.eintraege.filter((e) => e.kind === 'LOGIN_FAILED');
    assert.ok(
      treffer.length > vorherZahl,
      'der Fehlversuch muss als Ereignis erscheinen',
    );

    const neuestes = treffer[0];
    assert.equal(neuestes.severity, 'WARNING');
    assert.equal(neuestes.category, 'AUTHENTICATION');
    assert.ok(neuestes.user, 'das betroffene Konto gehört an den Eintrag');
    assert.equal(neuestes.user?.email, ACCOUNTS.customer.email);
  });

  it('eine geglückte Anmeldung ebenso — sonst fehlt die Antwort auf „und dann?“', async () => {
    await login(ACCOUNTS.employee.email, ACCOUNTS.employee.password);

    const strom = await ereignisse('?severity=INFO&proSeite=200');
    const treffer = strom.eintraege.filter(
      (e) => e.kind === 'LOGIN_SUCCEEDED' && e.user?.email === ACCOUNTS.employee.email,
    );
    assert.ok(treffer.length > 0, 'die geglückte Anmeldung muss im Strom stehen');
  });

  /**
   * Der Fall, für den das Zentrum vor allem gebaut ist: Eine Reihe von
   * Fehlversuchen läuft in die Sperre, und beide Ereignisse stehen
   * nebeneinander — die Reihe **und** der Moment, in dem sie abriss.
   *
   * Geprüft wird an einem eigens angelegten Konto, nicht an einem der fünf
   * gemeinsamen Demokonten: Eine Sperre auf `employee` legte die halbe
   * Prüfreihe still.
   */
  it('acht Fehlversuche sperren das Konto und melden beides', async (t) => {
    const email = `sperrprobe-${Date.now()}@clenaris.test`;
    const konto = await wegwerfKonto(email, 'Sperr');
    if (!konto) return t.skip('Konto liess sich nicht anlegen');

    try {
      /**
       * Neun Versuche, nicht acht: Der achte löst die Sperre aus, der neunte
       * belegt, dass sie hält. Das eingeladene Konto trägt ein zufälliges
       * Kennwort, das niemand kennt — jeder Versuch scheitert zwangsläufig.
       *
       * **Die Zähler werden vor jedem Versuch geleert.** Das Anmeldelimit von
       * acht Versuchen je Adresse liegt genau auf der Kontosperre von acht
       * Fehlversuchen — ohne Eingriff liefe dieser Fall unweigerlich in den
       * 429, und der Klient sässe die Fenster aus. Gemessen: Die Gesamtreihe
       * wuchs dadurch von 128 auf 422 Sekunden, für einen Fall, der gar nicht
       * das Limit prüft. Das tut `rate-limit.test.ts`, mit den echten Werten.
       *
       * Geprüft wird hier die **Kontosperre**, und die zählt am Konto und
       * nicht an der Adresse. Das Leeren nimmt der Prüfung also nichts weg —
       * es nimmt ihr nur die fremde Bremse.
       */
      let gesperrt = false;
      for (let i = 0; i < 9; i++) {
        resetRateLimits();
        const antwort = await post('/api/auth/login', {
          email,
          password: 'falsch-falsch-falsch',
        });
        if (antwort.status === 429) return t.skip('Anmeldekontingent erschöpft');
        if (JSON.stringify(antwort.payload ?? '').includes('gesperrt')) {
          gesperrt = true;
          break;
        }
      }

      assert.ok(gesperrt, 'nach acht Fehlversuchen muss die Sperre greifen');

      const strom = await ereignisse('?proSeite=200');
      const eigene = strom.eintraege.filter((e) => e.user?.id === konto.id);

      assert.ok(
        eigene.some((e) => e.kind === 'ACCOUNT_LOCKED'),
        'die Sperre muss ein eigenes Ereignis erzeugen',
      );
      assert.ok(
        eigene.some((e) => e.kind === 'LOGIN_FAILED'),
        'die Fehlversuche davor müssen ebenfalls stehen — die Reihe ist die Aussage',
      );
      assert.ok(
        eigene.some((e) => e.kind === 'LOGIN_BLOCKED'),
        'der Versuch auf das bereits gesperrte Konto ist ein eigener Fall',
      );

      /**
       * Und die Gegenprobe zur Handlung: Entsperren hebt genau das auf. Die
       * Seite zeigt das Konto danach nicht mehr unter den gesperrten.
       */
      const entsperrt = await post(`/api/security/users/${konto.id}/unlock`, undefined, {
        jar: jars.super,
      });
      assert.equal(entsperrt.status, 200);

      const danach = await ereignisse('?proSeite=200');
      assert.ok(
        danach.eintraege.some(
          (e) => e.kind === 'USER_REACTIVATED' && e.user?.id === konto.id,
        ),
        'das Aufheben der Sperre gehört ebenfalls in den Strom',
      );
    } finally {
      await del(`/api/users/${konto.id}`, { jar: jars.super }).catch(() => {});
    }
  });
});

// ===========================================================================
//  Keine Geheimnisse
// ===========================================================================

describe('Der Strom enthält keine Geheimnisse', () => {
  before(async () => {
    await requireServer();
    jars = await loginAll();
  });

  /**
   * Die Kernprüfung dieser Wave. Ein Sicherheitsprotokoll ist genau die Datei,
   * die jemand mitnimmt, der schon drin ist — sie darf ihm nichts geben, was
   * er noch nicht hat.
   *
   * Geprüft wird die **ganze** Antwort als Text, nicht Feld für Feld: Ein
   * Geheimnis, das über ein neues Feld hereinkäme, entginge einer Prüfung, die
   * nur die bekannten Felder ansieht.
   */
  it('weder rohe Tokens noch Hashes noch Passwörter erscheinen', async () => {
    const antwort = await get('/api/security/events?proSeite=200', { jar: jars.super });
    assert.equal(antwort.status, 200);

    const text = JSON.stringify(antwort.payload);

    assert.ok(
      !/[0-9a-f]{64}/.test(text),
      'kein 64-stelliger Hexwert — das wäre ein roher Zugangstoken oder ein SHA-256',
    );
    assert.ok(!/\$argon2/.test(text), 'kein Passworthash');
    assert.ok(
      !/"(password|passwordHash|tokenHash|token|twoFactorSecret|ahvNumber|alarmCode)"\s*:\s*"(?!\[redigiert\])/.test(
        text,
      ),
      'kein Geheimnisfeld mit echtem Wert',
    );

    for (const konto of Object.values(ACCOUNTS)) {
      assert.ok(
        !text.includes(konto.password),
        'kein Klartextpasswort — auch nicht als Teil einer Zusammenfassung',
      );
    }
  });

  /**
   * Ein ausgestellter Zugangslink erzeugt ein Ereignis. Dass dabei der rohe
   * Token nicht mitgeht, ist die Eigenschaft, die zählt — sie wurde in Wave 1
   * für das Prüfprotokoll hergestellt und gilt hier genauso.
   */
  it('eine Linkausstellung steht im Strom, der Link selbst nicht', async () => {
    const offerten = await get<{ data: { id: string }[] }>('/api/quotes?proSeite=1', {
      jar: jars.admin,
    });
    if (offerten.status !== 200) return;

    const liste = data(offerten);
    const erste = Array.isArray(liste) ? liste[0] : undefined;
    if (!erste) return;

    const versand = await post(`/api/quotes/${erste.id}/send`, {}, { jar: jars.admin });
    if (versand.status !== 200 && versand.status !== 201) return;

    const strom = await ereignisse('?category=PUBLIC_LINK&proSeite=50');
    const treffer = strom.eintraege.filter((e) => e.kind === 'PUBLIC_LINK_ISSUED');
    assert.ok(treffer.length > 0, 'der Versand muss eine Linkausstellung melden');

    const text = JSON.stringify(treffer);
    assert.ok(!/[0-9a-f]{64}/.test(text), 'weder roher Token noch Hash im Ereignis');
    assert.ok(
      JSON.stringify(treffer[0].context).includes('zweck'),
      'Zweck und Ressource gehören hinein — sie erkennen die Vergabe, ohne sie zu benutzen',
    );
  });
});

// ===========================================================================
//  Handlungen
// ===========================================================================

describe('Handlungen im Sicherheitszentrum', () => {
  before(async () => {
    await requireServer();
    jars = await loginAll();
  });

  it('bestätigen setzt Zeitpunkt und Person — und löscht nichts', async (t) => {
    const offen = await ereignisse('?nurOffen=true&proSeite=5');
    if (offen.eintraege.length === 0) {
      return t.skip('gerade kein unbestätigtes kritisches Ereignis vorhanden');
    }

    const ziel = offen.eintraege[0];
    const antwort = await post<{ data: { bestaetigt: boolean } }>(
      `/api/security/events/${ziel.id}/acknowledge`,
      { note: 'Geprüfte Übung der Prüfreihe.' },
      { jar: jars.super },
    );
    assert.equal(antwort.status, 200);
    assert.equal(data(antwort).bestaetigt, true);

    /** Die Zeile bleibt — bestätigen heisst nicht löschen. */
    const danach = await ereignisse('?proSeite=200');
    const wieder = danach.eintraege.find((e) => e.id === ziel.id);
    assert.ok(wieder, 'das Ereignis muss weiterhin im Strom stehen');
    assert.ok(wieder?.acknowledgedAt, 'der Bestätigungszeitpunkt muss gesetzt sein');
    assert.equal(wieder?.summary, ziel.summary, 'die Zusammenfassung bleibt unverändert');

    /** Aus den offenen Punkten ist es verschwunden — das ist der Zweck. */
    const nochOffen = await ereignisse('?nurOffen=true&proSeite=200');
    assert.ok(
      !nochOffen.eintraege.some((e) => e.id === ziel.id),
      'ein bestätigtes Ereignis steht nicht mehr unter den offenen',
    );
  });

  it('ein zweites Bestätigen ist kein Fehler, überschreibt aber nichts', async (t) => {
    const alle = await ereignisse('?severity=CRITICAL&proSeite=50');
    const bereits = alle.eintraege.find((e) => e.acknowledgedAt);
    if (!bereits) return t.skip('noch kein bestätigtes Ereignis vorhanden');

    const zeitpunktVorher = bereits.acknowledgedAt;
    const antwort = await post<{ data: { bestaetigt: boolean } }>(
      `/api/security/events/${bereits.id}/acknowledge`,
      { note: 'Zweiter Versuch — darf nichts ändern.' },
      { jar: jars.super },
    );

    assert.equal(antwort.status, 200, 'kein Fehler: die Absicht ist bereits erfüllt');
    assert.equal(data(antwort).bestaetigt, false);

    const danach = await ereignisse('?severity=CRITICAL&proSeite=50');
    const wieder = danach.eintraege.find((e) => e.id === bereits.id);
    assert.equal(
      wieder?.acknowledgedAt,
      zeitpunktVorher,
      'der ursprüngliche Bestätigungszeitpunkt bleibt stehen',
    );
  });

  it('ein unbekanntes Ereignis antwortet 404, kein 500', async () => {
    const antwort = await post(
      '/api/security/events/clzzzzzzzzzzzzzzzzzzzzzzz/acknowledge',
      {},
      { jar: jars.super },
    );
    assert.equal(antwort.status, 404);
  });

  it('Sitzungen beenden widerruft die Erneuerungstokens wirklich', async (t) => {
    const konto = await wegwerfKonto(`sitzungsprobe-${Date.now()}@clenaris.test`, 'Sitzungs');
    if (!konto) return t.skip('Konto liess sich nicht anlegen');

    try {
      const antwort = await post<{ data: { widerrufen: number } }>(
        `/api/security/users/${konto.id}/revoke-sessions`,
        undefined,
        { jar: jars.super },
      );
      assert.equal(antwort.status, 200);
      assert.ok(typeof data(antwort).widerrufen === 'number');

      const strom = await ereignisse('?category=SESSION&proSeite=50');
      assert.ok(
        strom.eintraege.some((e) => e.kind === 'SESSIONS_REVOKED' && e.user?.id === konto.id),
        'der Widerruf muss im Strom stehen',
      );
    } finally {
      await del(`/api/users/${konto.id}`, { jar: jars.super }).catch(() => {});
    }
  });

  it('ein fremdes Konto gibt es für diese Endpunkte nicht', async () => {
    const antwort = await post(
      '/api/security/users/clzzzzzzzzzzzzzzzzzzzzzzz/unlock',
      undefined,
      { jar: jars.super },
    );
    assert.equal(antwort.status, 404);
  });
});

// ===========================================================================
//  Filter
// ===========================================================================

describe('Die Filter tun, was draufsteht', () => {
  before(async () => {
    await requireServer();
    jars = await loginAll();
  });

  it('nach Kategorie gefiltert kommt nur diese Kategorie', async () => {
    const strom = await ereignisse('?category=AUTHENTICATION&proSeite=50');
    for (const e of strom.eintraege) {
      assert.equal(e.category, 'AUTHENTICATION', `${e.kind} gehört nicht in diese Kategorie`);
    }
  });

  it('nach Schwere gefiltert ebenso', async () => {
    const strom = await ereignisse('?severity=CRITICAL&proSeite=50');
    for (const e of strom.eintraege) {
      assert.equal(e.severity, 'CRITICAL');
    }
  });

  /**
   * `nurOffen` heisst `CRITICAL` **und** unbestätigt. Ohne die Stufe wären es
   * alle Zeilen, die nie jemand bestätigen wollte — also fast alle, und die
   * Ansicht wäre wertlos.
   */
  it('„nur offen“ heisst kritisch und unbestätigt', async () => {
    const strom = await ereignisse('?nurOffen=true&proSeite=50');
    for (const e of strom.eintraege) {
      assert.equal(e.severity, 'CRITICAL');
      assert.equal(e.acknowledgedAt, null);
    }
  });

  /**
   * Ein Filter, der `'false'` für wahr hält, ist der Fehler, der am längsten
   * unbemerkt bleibt — er zeigt einfach zu wenig. Das Schema lässt deshalb nur
   * die Zeichenkette `'true'` zu, und alles andere ist ein Eingabefehler.
   */
  it('`nurOffen=false` ist ein Eingabefehler und keine stille Wahrheit', async () => {
    const antwort = await get('/api/security/events?nurOffen=false', { jar: jars.super });
    assert.equal(antwort.status, 422, 'Zod-Fehler kommen als 422, nicht als 400');
  });

  it('eine unbekannte Kategorie wird abgewiesen, nicht ignoriert', async () => {
    const antwort = await get('/api/security/events?category=ERFUNDEN', { jar: jars.super });
    assert.equal(antwort.status, 422);
  });

  it('die Seitengrösse ist gedeckelt', async () => {
    const antwort = await get('/api/security/events?proSeite=100000', { jar: jars.super });
    assert.equal(antwort.status, 422, 'eine unbegrenzte Seite wäre ein Weg, den Server zu binden');
  });
});

// ===========================================================================
//  Die Seite selbst
// ===========================================================================

describe('Die Seite zeigt den Betriebszustand', () => {
  before(async () => {
    await requireServer();
    jars = await loginAll();
  });

  /**
   * In der Prüfumgebung läuft der Testprüfer. Die Seite soll das **sagen** —
   * ein Zentrum, das einen EICAR-Erkenner als Schadsoftwareprüfung ausgibt,
   * wäre genau die falsche Zusicherung, die Wave 2 vermeiden sollte.
   */
  it('weist auf den Testprüfer hin, statt ihn als Prüfung auszugeben', async () => {
    const seite = await get('/admin/sicherheit', { jar: jars.super });
    assert.equal(seite.status, 200);

    const html = typeof seite.text === 'string' ? seite.text.replace(/<!--\s*-->/g, '') : '';
    assert.ok(
      html.includes('Testprüfer') || html.includes('Kein Schadsoftwareprüfer'),
      'der Betriebszustand der Prüfeinrichtung muss auf der Seite stehen',
    );
  });

  it('die Seite verrät keine Geheimnisse im HTML', async () => {
    const seite = await get('/admin/sicherheit', { jar: jars.super });
    const html = typeof seite.text === 'string' ? seite.text : '';

    assert.ok(!/[0-9a-f]{64}/.test(html), 'kein 64-stelliger Hexwert im HTML');
    assert.ok(!/\$argon2/.test(html), 'kein Passworthash im HTML');
  });
});

/*
 * Kein Aufräumen am Ende der Datei.
 *
 * Die beiden Wegwerfkonten räumt der jeweilige Fall selbst ab. Die erzeugten
 * Ereignisse bleiben stehen — ein Protokoll, das eine Prüfreihe hinter sich
 * aufräumt, wäre keines, und die nachfolgenden Läufe müssen damit umgehen
 * können, dass Zeilen da sind. Genau deshalb prüft diese Reihe überall
 * relativ („mehr als vorher") und nie gegen eine absolute Zahl.
 */
