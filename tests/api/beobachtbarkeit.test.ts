import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { eigeneOrganisationId, testDb, testDbGrund, testDbSchliessen } from '../helpers/testdb';

import { routenVorlage } from '../../src/lib/observability/context';
import {
  DAUER_KLASSEN,
  beobachteAnfrage,
  kennzahlen,
  kennzahlenZuruecksetzen,
  quantil,
  type RouteZahlen,
} from '../../src/lib/observability/metrics';
import { get, post, data, requireServer } from '../helpers/client';
import { loginAll, type AccountName } from '../helpers/accounts';

/**
 * Wave 5 — Beobachtbarkeit.
 *
 * ---------------------------------------------------------------------------
 *  Zwei Hälften, und sie prüfen Verschiedenes
 * ---------------------------------------------------------------------------
 *
 * Die **Registrierung** ist reine Rechnung: Klassen, Quantile, die Grenze
 * gegen unbegrenztes Wachstum. Sie wird direkt importiert — über HTTP käme man
 * an die Kantenfälle nur, indem man zehntausend Anfragen stellt, und die
 * Grenze von 500 Reihen liesse sich gar nicht erreichen, ohne die Zahlen des
 * Servers zu zerstören, gegen den die übrige Prüfreihe läuft.
 *
 * Die **Verdrahtung** läuft über HTTP: Trägt jede Antwort eine Kennung? Ist
 * sie je Anfrage verschieden? Wird eine mitgeschickte Kennung übernommen (sie
 * darf nicht)? Und zählt der Kennzahlenendpunkt tatsächlich mit?
 *
 * Der Grund für die Trennung ist derselbe wie überall in dieser Reihe: Ein
 * Rechenkern, der stimmt, sagt nichts darüber, ob ihn jemand aufruft.
 */

// ===========================================================================
//  Die Vorlage — der Unterschied zwischen brauchbaren und unbrauchbaren Zahlen
// ===========================================================================

describe('Routenvorlagen', () => {
  it('ersetzt den Parameterwert durch seinen Namen', () => {
    assert.equal(
      routenVorlage('/api/jobs/clx1234567890/team', { id: 'clx1234567890' }),
      '/api/jobs/:id/team',
    );
  });

  it('ersetzt mehrere Parameter, unabhängig von ihrer Reihenfolge', () => {
    assert.equal(
      routenVorlage('/api/customers/cabc123456/addresses/dxyz789012', {
        addressId: 'dxyz789012',
        id: 'cabc123456',
      }),
      '/api/customers/:id/addresses/:addressId',
    );
  });

  it('lässt einen Pfad ohne Parameter unverändert', () => {
    assert.equal(routenVorlage('/api/jobs', {}), '/api/jobs');
  });

  /**
   * Sehr kurze Werte werden nicht ersetzt. Ein einzeichiger Parameter käme
   * sonst in jedem zweiten Pfadsegment vor und machte aus `/api/leads` ein
   * `/api/:x` — die Vorlage wäre unbrauchbar und die Zahlen wertlos.
   */
  it('ersetzt keine sehr kurzen Werte', () => {
    assert.equal(routenVorlage('/api/a/b/c', { x: 'a' }), '/api/a/b/c');
  });

  it('ignoriert Parameter, die keine Zeichenketten sind', () => {
    assert.equal(
      routenVorlage('/api/jobs/clx1234567890', { id: 'clx1234567890', seite: 3 as never }),
      '/api/jobs/:id',
    );
  });

  /**
   * Der Fall, um den es wirklich geht: Ohne Vorlage entstünde je Datensatz
   * eine Reihe. Bei zehntausend Einsätzen wären das zehntausend Reihen, von
   * denen keine genug Beobachtungen für eine Aussage hätte — und die
   * Registrierung wüchse mit den Daten.
   */
  it('führt zu einer Reihe je Route, nicht je Datensatz', () => {
    kennzahlenZuruecksetzen();

    for (let i = 0; i < 50; i++) {
      const id = `clx${String(i).padStart(10, '0')}`;
      beobachteAnfrage({
        route: routenVorlage(`/api/jobs/${id}`, { id }),
        method: 'GET',
        status: 200,
        dauerMs: 10,
      });
    }

    const zahlen = kennzahlen();
    assert.equal(zahlen.reihen.length, 1, '50 Datensätze, eine Reihe');
    assert.equal(zahlen.reihen[0].route, '/api/jobs/:id');
    assert.equal(zahlen.reihen[0].anfragen, 50);
  });
});

// ===========================================================================
//  Die Registrierung
// ===========================================================================

describe('Kennzahlenregistrierung', () => {
  it('zählt Anfragen, Statusklassen und Dauer', () => {
    kennzahlenZuruecksetzen();

    beobachteAnfrage({ route: '/api/x', method: 'GET', status: 200, dauerMs: 10 });
    beobachteAnfrage({ route: '/api/x', method: 'GET', status: 201, dauerMs: 30 });
    beobachteAnfrage({ route: '/api/x', method: 'GET', status: 404, dauerMs: 5 });
    beobachteAnfrage({ route: '/api/x', method: 'GET', status: 500, dauerMs: 900 });
    beobachteAnfrage({ route: '/api/x', method: 'GET', status: 307, dauerMs: 2 });

    const zeile = kennzahlen().reihen[0];
    assert.equal(zeile.anfragen, 5);
    assert.equal(zeile.status['2xx'], 2);
    assert.equal(zeile.status['3xx'], 1);
    assert.equal(zeile.status['4xx'], 1);
    assert.equal(zeile.status['5xx'], 1);
    assert.equal(zeile.dauerMaxMs, 900);
    assert.equal(zeile.dauerSummeMs, 947);
    assert.equal(zeile.dauerMittelMs, 189.4);
  });

  it('trennt Methoden derselben Route', () => {
    kennzahlenZuruecksetzen();
    beobachteAnfrage({ route: '/api/x', method: 'GET', status: 200, dauerMs: 1 });
    beobachteAnfrage({ route: '/api/x', method: 'POST', status: 201, dauerMs: 1 });

    assert.equal(kennzahlen().reihen.length, 2);
  });

  /**
   * Das Quantil wird als **Obergrenze der Klasse** zurückgegeben — also ein
   * Wert, der die Wahrheit nie unterschätzt. Das ist die richtige Richtung für
   * eine Zahl, nach der jemand entscheidet: „p95 unter 250 ms" darf nicht in
   * Wahrheit 400 ms heissen.
   */
  it('das Quantil unterschätzt nie', () => {
    kennzahlenZuruecksetzen();

    // 99 schnelle, eine langsame.
    for (let i = 0; i < 99; i++) {
      beobachteAnfrage({ route: '/api/x', method: 'GET', status: 200, dauerMs: 3 });
    }
    beobachteAnfrage({ route: '/api/x', method: 'GET', status: 200, dauerMs: 900 });

    const zeile = kennzahlen().reihen[0];
    assert.equal(zeile.p50Ms, 5, 'die Hälfte liegt in der ersten Klasse');
    assert.equal(zeile.p95Ms, 5, 'auch 95 % — die eine langsame verschiebt das nicht');

    const p999 = quantil(zeile as RouteZahlen, 0.999);
    assert.ok(p999 !== null && p999 >= 900, 'das oberste Quantil erreicht die langsame Anfrage');
  });

  /**
   * Liegt das Quantil in der offenen Klasse, kommt `null`. Dort gibt es keine
   * Obergrenze, und eine erfundene wäre schlimmer als die Auskunft „darüber".
   */
  it('über der letzten Klasse gibt es keine Obergrenze', () => {
    kennzahlenZuruecksetzen();
    const grenze = DAUER_KLASSEN[DAUER_KLASSEN.length - 1];
    beobachteAnfrage({ route: '/api/x', method: 'GET', status: 200, dauerMs: grenze * 10 });

    assert.equal(kennzahlen().reihen[0].p95Ms, null);
  });

  /**
   * Die Grenze gegen unbegrenztes Wachstum. Ohne sie wäre eine fehlerhafte
   * Vorlagenbildung ein Speicherleck, das mit den Daten wächst — und zwar
   * eines, das erst im Betrieb auffällt.
   */
  it('nimmt oberhalb der Grenze nichts mehr auf und sagt es', () => {
    kennzahlenZuruecksetzen();

    for (let i = 0; i < 600; i++) {
      beobachteAnfrage({ route: `/api/erfunden-${i}`, method: 'GET', status: 200, dauerMs: 1 });
    }

    const zahlen = kennzahlen();
    assert.equal(zahlen.reihen.length, 500, 'die Registrierung bleibt gedeckelt');
    assert.ok(zahlen.ueberlauf > 0, 'und die Ausgabe sagt, dass sie unvollständig ist');
  });

  it('sortiert nach Anfragen, nicht alphabetisch', () => {
    kennzahlenZuruecksetzen();
    beobachteAnfrage({ route: '/api/a', method: 'GET', status: 200, dauerMs: 1 });
    for (let i = 0; i < 5; i++) {
      beobachteAnfrage({ route: '/api/z', method: 'GET', status: 200, dauerMs: 1 });
    }

    assert.equal(kennzahlen().reihen[0].route, '/api/z');
  });

  /**
   * Eine Kennzahlenerhebung, die eine Anfrage scheitern lassen kann, ist
   * selbst ein Ausfallgrund. Dieselbe Regel wie beim Prüfprotokoll.
   */
  it('wirft nie, auch nicht bei Unsinn', () => {
    kennzahlenZuruecksetzen();
    assert.doesNotThrow(() => {
      beobachteAnfrage({
        route: null as never,
        method: undefined as never,
        status: NaN,
        dauerMs: -1,
      });
    });
  });
});

// ===========================================================================
//  Über HTTP: die Verdrahtung
// ===========================================================================

describe('Jede Antwort trägt eine Anfragekennung', () => {
  // Diese Fälle kommen bewusst ohne Anmeldung aus: Die Kennung darf nicht an
  // einer Sitzung hängen, sondern muss an jeder Antwort stehen.
  before(async () => {
    await requireServer();
  });

  it('auch ohne Anmeldung und auch bei einem Fehler', async () => {
    const offen = await get('/api/health');
    assert.match(
      offen.headers.get('x-request-id') ?? '',
      /^[0-9a-f-]{36}$/,
      'ein öffentlicher Endpunkt trägt die Kennung ebenso',
    );

    const abgewiesen = await get('/api/metrics');
    assert.equal(abgewiesen.status, 401);
    assert.match(
      abgewiesen.headers.get('x-request-id') ?? '',
      /^[0-9a-f-]{36}$/,
      'gerade die abgewiesene Antwort braucht sie',
    );
  });

  it('jede Anfrage bekommt eine eigene', async () => {
    const eins = await get('/api/health');
    const zwei = await get('/api/health');

    assert.notEqual(
      eins.headers.get('x-request-id'),
      zwei.headers.get('x-request-id'),
      'zwei Anfragen, zwei Kennungen — sonst taugt sie nicht zum Zuordnen',
    );
  });

  /**
   * Der Punkt, an dem sich eine bequeme Umsetzung von einer richtigen
   * unterscheidet. Viele Proxys setzen `X-Request-Id`, und es ist verlockend,
   * eine mitgeschickte zu übernehmen. Sie ist aber eine **Behauptung** — genau
   * wie `X-Forwarded-For`. Wer sie übernähme, liesse jemanden beliebig viele
   * Protokollzeilen unter einer Kennung seiner Wahl ablegen.
   */
  it('eine mitgeschickte Kennung wird nicht übernommen', async () => {
    const gefaelscht = '00000000-0000-4000-8000-000000000000';
    const antwort = await get('/api/health', { headers: { 'X-Request-Id': gefaelscht } });

    assert.notEqual(
      antwort.headers.get('x-request-id'),
      gefaelscht,
      'was von aussen kommt, ist eine Behauptung',
    );
    assert.match(antwort.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/);
  });

  it('die Antwort sagt auch, wie lange sie gedauert hat', async () => {
    const antwort = await get('/api/health');
    assert.match(
      antwort.headers.get('server-timing') ?? '',
      /^app;dur=\d+$/,
      'Server-Timing ist das genormte Feld dafür und im Browser sichtbar',
    );
  });
});

describe('Der Kennzahlenendpunkt', () => {
  let jars: Record<AccountName, string>;

  before(async () => {
    await requireServer();
    jars = await loginAll();
  });

  it('öffnet sich nur der Systemverantwortung', async () => {
    for (const rolle of ['admin', 'manager', 'employee', 'customer'] as AccountName[]) {
      const antwort = await get('/api/metrics', { jar: jars[rolle] });
      assert.ok(
        antwort.status === 403 || antwort.status === 401,
        `${rolle} darf die Betriebszahlen nicht sehen (kam ${antwort.status})`,
      );
    }

    const erlaubt = await get('/api/metrics', { jar: jars.super });
    assert.equal(erlaubt.status, 200);
  });

  it('zählt tatsächlich mit', async () => {
    const vorher = await get<{ data: { reihen: { route: string; anfragen: number }[] } }>(
      '/api/metrics',
      { jar: jars.super },
    );
    const vorZahl =
      data(vorher).reihen.find((r) => r.route === '/api/health')?.anfragen ?? 0;

    await get('/api/health');
    await get('/api/health');
    await get('/api/health');

    const nachher = await get<{ data: { reihen: { route: string; anfragen: number }[] } }>(
      '/api/metrics',
      { jar: jars.super },
    );
    const nachZahl =
      data(nachher).reihen.find((r) => r.route === '/api/health')?.anfragen ?? 0;

    assert.ok(
      nachZahl >= vorZahl + 3,
      `drei Aufrufe müssen ankommen (vorher ${vorZahl}, nachher ${nachZahl})`,
    );
  });

  /**
   * Die Kernfrage an die Vorlagenbildung im laufenden Betrieb: Steht in den
   * Reihen eine Datensatzkennung? Wenn ja, wächst die Registrierung mit den
   * Daten — und die Zahlen sind wertlos, weil keine Reihe genug
   * Beobachtungen hat.
   */
  it('keine Reihe trägt eine Datensatzkennung', async () => {
    const antwort = await get<{ data: { reihen: { route: string }[] } }>('/api/metrics', {
      jar: jars.super,
    });

    for (const reihe of data(antwort).reihen) {
      assert.ok(
        !/\/c[a-z0-9]{20,}/.test(reihe.route),
        `die Reihe „${reihe.route}" trägt eine cuid statt eines Platzhalters`,
      );
      assert.ok(
        !/[0-9a-f]{32}/.test(reihe.route),
        `die Reihe „${reihe.route}" trägt einen Hexwert statt eines Platzhalters`,
      );
    }
  });

  it('die Antwort sagt, aus welchem Prozess sie stammt', async () => {
    const antwort = await get<{
      data: { prozessId: number; prozessStartzeit: string; laufzeitSekunden: number };
    }>('/api/metrics', { jar: jars.super });

    const zahlen = data(antwort);
    assert.ok(Number.isInteger(zahlen.prozessId));
    assert.match(zahlen.prozessStartzeit, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(zahlen.laufzeitSekunden >= 0);
  });

  /**
   * Eine Kennzahl beantwortet „wie oft und wie lange", nie „von wem". Die
   * Antwort wird als Ganzes durchsucht, nicht Feld für Feld — ein neues Feld
   * entginge einer Prüfung, die nur die bekannten ansieht.
   */
  it('enthält keine Personenangaben', async () => {
    const antwort = await get('/api/metrics', { jar: jars.super });
    const text = JSON.stringify(antwort.payload);

    assert.ok(!/@/.test(text), 'keine E-Mail-Adresse');
    assert.ok(!/\b\d{1,3}(\.\d{1,3}){3}\b/.test(text), 'keine IP-Adresse');
    assert.ok(!/[0-9a-f]{64}/.test(text), 'kein Token und kein Hash');
  });

  /**
   * Eine 500er-Antwort nennt die Kennung im Rumpf, damit sie in der Meldung
   * der betroffenen Person landet. Ein *abgewiesener* Zugriff soll das nicht —
   * er braucht keine Nachforschung, und eine Kennung an jeder Absage lädt
   * dazu ein, sie zu sammeln.
   */
  it('eine abgewiesene Anfrage nennt die Kennung nicht im Rumpf', async () => {
    const antwort = await post('/api/security/events/xyz/acknowledge', {}, { jar: jars.employee });
    assert.ok(antwort.status === 403 || antwort.status === 401);

    const text = JSON.stringify(antwort.payload);
    assert.ok(!text.includes('requestId'), 'kein Kennungsfeld in einer Absage');
    assert.ok(!text.includes('Kennung:'), 'und kein Kennungstext');

    // In der Kopfzeile steht sie trotzdem — dort gehört sie immer hin.
    assert.match(antwort.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/);
  });
});

// ===========================================================================
//  RB-014 — geplante Läufe: Protokoll, Zustand, Alarm
// ===========================================================================

describe('RB-014 — Überwachung der geplanten Läufe', () => {
  const secret = process.env.CRON_SECRET ?? 'dev-cron-secret';
  const mitGeheimnis = { headers: { authorization: `Bearer ${secret}` } };
  const db = testDb();

  after(async () => {
    await testDbSchliessen();
  });

  it('jeder Lauf hinterlässt ein Protokoll — mit Dauer, Teilaufgaben und ehrlichem Statuscode', async (t) => {
    if (!db) return t.skip(`kein Zugang zur Testdatenbank: ${testDbGrund()}`);
    const vorher = new Date();
    const antwort = await get<{ ok: boolean; runId: string; status: string }>('/api/cron/hourly', mitGeheimnis);
    assert.ok([200, 500].includes(antwort.status), `HTTP ${antwort.status}`);
    const rumpf = antwort.payload!;
    // Der Statuscode sagt dasselbe wie der Rumpf — bis 2026-09-23 war er
    // immer 200.
    assert.equal(antwort.status === 200, rumpf.ok, 'Statuscode und Ergebnis stimmen überein');

    const lauf = await db.cronRun.findUniqueOrThrow({ where: { id: rumpf.runId } });
    assert.equal(lauf.job, 'hourly');
    assert.ok(lauf.startedAt >= new Date(vorher.getTime() - 1000));
    assert.ok(lauf.finishedAt, 'Der Lauf ist abgeschlossen');
    assert.ok((lauf.durationMs ?? -1) >= 0);
    // Vier Teilaufgaben seit 2026-09-30: Zu den Erinnerungen an Kundschaft
    // und Team und den Automatisierungen kam der Abschluss verwaister
    // Release-Ausführungen (`releaseAusfuehrungen`,
    // `verwaisteAusfuehrungenAbschliessen` in `release-ausfuehrung.service.ts`).
    // Die Zahl steht hier genau und nicht als „mindestens", weil eine
    // Teilaufgabe, die still aus `mitUeberwachung` herausfällt, sonst nie
    // auffiele — weder im Protokoll noch im Alarm.
    assert.equal(lauf.processed + lauf.failed, 4, 'Vier Teilaufgaben');
    assert.notEqual(lauf.status, 'RUNNING');
  });

  it('der Statusendpunkt verlangt das Geheimnis und nennt keine Inhalte', async () => {
    assert.equal((await get('/api/cron/status')).status, 401);
    const antwort = await get<{ gesund: boolean; auftraege: { job: string; letzterLauf: string | null }[] }>(
      '/api/cron/status',
      mitGeheimnis,
    );
    assert.ok([200, 503].includes(antwort.status));
    assert.deepEqual(antwort.payload!.auftraege.map((a) => a.job).sort(), ['daily', 'hourly']);
    assert.doesNotMatch(antwort.text, /@|IBAN|password/i, 'Nur Zeitpunkte und Zahlen');
  });

  /**
   * Ein ausgebliebener Nachtlauf: Die Läufe werden in der Zeit zurückgesetzt,
   * als wäre der letzte vor 30 Stunden gewesen. Danach muss der Statuscode
   * 503 sein, ein Alarm im Sicherheitsprotokoll stehen — und ein zweiter
   * Aufruf darf keinen zweiten Alarm erzeugen.
   */
  it('ein ausgebliebener Lauf ergibt 503 und genau einen Alarm', async (t) => {
    if (!db) return t.skip(`kein Zugang zur Testdatenbank: ${testDbGrund()}`);
    // Über den Slug: Seit Wave 9 kennt die Testdatenbank eine fremde Organisation.
    const org = { id: (await eigeneOrganisationId())! };
    const neu = await db.cronRun.create({
      data: { organizationId: org.id, job: 'daily', status: 'SUCCESS', startedAt: new Date(), finishedAt: new Date(), durationMs: 1 },
    });
    const alle = await db.cronRun.findMany({ where: { job: 'daily' }, select: { id: true, startedAt: true } });
    const verschiebung = 30 * 3_600_000;
    try {
      for (const r of alle) {
        await db.cronRun.update({ where: { id: r.id }, data: { startedAt: new Date(r.startedAt.getTime() - verschiebung) } });
      }
      const seit = new Date();
      const erste = await get('/api/cron/status', mitGeheimnis);
      assert.equal(erste.status, 503, 'Ein überfälliger Auftrag macht den Zustand ungesund');
      const zweite = await get('/api/cron/status', mitGeheimnis);
      assert.equal(zweite.status, 503);
      const alarme = await db.securityEvent.count({ where: { kind: 'CRON_MISSED', occurredAt: { gte: seit } } });
      assert.equal(alarme, 1, 'Ein Alarm je Überfälligkeit, nicht je Abfrage');
    } finally {
      for (const r of alle) {
        await db.cronRun.update({ where: { id: r.id }, data: { startedAt: r.startedAt } }).catch(() => undefined);
      }
      await db.cronRun.delete({ where: { id: neu.id } }).catch(() => undefined);
      await db.securityEvent.deleteMany({ where: { kind: 'CRON_MISSED', context: { path: ['job'], equals: 'daily' } } });
    }
  });
});
