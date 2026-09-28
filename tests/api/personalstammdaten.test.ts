import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

import { get, put, data, requireServer } from '../helpers/client';
import { loginAll, type AccountName } from '../helpers/accounts';

/**
 * Wave 7 — Qualifikationen und Arbeitszeiten.
 *
 * ---------------------------------------------------------------------------
 *  Der Befund
 * ---------------------------------------------------------------------------
 *
 * Beide Listen wurden gelesen — die Personalakte zeigt sie, die
 * Eignungsprüfung beim Zuteilen wertet die Arbeitszeit aus, der
 * Personalvorschlag die Qualifikationen — und **keine der beiden liess sich
 * ändern**. Die Arbeitszeit entstand beim Anlegen als Montag bis Freitag
 * 07:00–17:00 und blieb das für immer.
 *
 * Für einen Betrieb mit Teilzeit, Schichten und Samstagsdiensten ist das keine
 * Vorgabe, sondern eine Behauptung — und die Warnung beim Zuteilen entsprechend
 * falsch. Eine Angabe, die niemand pflegen kann, ist schlechter als keine: Sie
 * sieht aus wie eine Aussage.
 *
 * ---------------------------------------------------------------------------
 *  Was geprüft wird
 * ---------------------------------------------------------------------------
 *
 * Das Ersetzen als Ganzes, die Prüfungen, die den eindeutigen Index ergänzen
 * (doppelte Namen, überlappende Fenster), und die Rechtegrenze. Alles über
 * HTTP — hier gibt es keinen Rechenkern, den man einzeln prüfen müsste.
 */

let jars: Record<AccountName, string>;
let employeeId = '';

interface Akte {
  id: string;
  skills: { name: string; level: number }[];
  availability: { weekday: number; startTime: string; endTime: string }[];
}

async function akte(): Promise<Akte> {
  const antwort = await get<{ data: Akte }>(`/api/employees/${employeeId}`, { jar: jars.admin });
  assert.equal(antwort.status, 200, 'die Personalakte muss lesbar sein');
  return data(antwort);
}

describe('Qualifikationen und Arbeitszeiten', () => {
  before(async () => {
    await requireServer();
    jars = await loginAll();

    const liste = await get<{ data: { id: string }[] }>('/api/employees', { jar: jars.admin });
    assert.equal(liste.status, 200);
    employeeId = data(liste)[0]?.id ?? '';
    assert.ok(employeeId, 'für diese Prüfungen braucht es eine Personalakte im Bestand');
  });

  // -------------------------------------------------------------------------
  //  Qualifikationen
  // -------------------------------------------------------------------------

  it('setzt die Qualifikationen und ersetzt dabei die bisherigen', async () => {
    const erste = await put(
      `/api/employees/${employeeId}/skills`,
      {
        skills: [
          { name: 'Fensterreinigung', level: 3 },
          { name: 'Hochdruckreiniger', level: 2 },
        ],
      },
      { jar: jars.admin },
    );
    assert.equal(erste.status, 200);

    const nachher = await akte();
    const namen = nachher.skills.map((s) => s.name).sort();
    assert.deepEqual(namen, ['Fensterreinigung', 'Hochdruckreiniger']);

    /**
     * Der Kern von „ersetzen": Die zweite Liste enthält nur noch einen
     * Eintrag, und die beiden anderen sind weg — nicht zusätzlich vorhanden.
     */
    const zweite = await put(
      `/api/employees/${employeeId}/skills`,
      { skills: [{ name: 'Stapler', level: 5 }] },
      { jar: jars.admin },
    );
    assert.equal(zweite.status, 200);

    const danach = await akte();
    assert.deepEqual(danach.skills.map((s) => s.name), ['Stapler']);
    assert.equal(danach.skills[0].level, 5);
  });

  it('eine leere Liste löscht alle', async () => {
    const antwort = await put(`/api/employees/${employeeId}/skills`, { skills: [] }, {
      jar: jars.admin,
    });
    assert.equal(antwort.status, 200);
    assert.equal((await akte()).skills.length, 0);
  });

  /**
   * Der eindeutige Index auf `(employeeId, name)` fängt das ohnehin — als 409
   * mit einer Meldung über eine Datenbankeinschränkung. Die Prüfung im Schema
   * sagt stattdessen, **welcher** Name doppelt ist.
   */
  it('weist doppelte Namen ab und nennt den Namen', async () => {
    const antwort = await put(
      `/api/employees/${employeeId}/skills`,
      {
        skills: [
          { name: 'Fensterreinigung', level: 1 },
          { name: 'fensterreinigung', level: 2 },
        ],
      },
      { jar: jars.admin },
    );

    assert.equal(antwort.status, 422, 'Zod-Fehler kommen als 422');
    assert.ok(
      JSON.stringify(antwort.payload).toLowerCase().includes('zweimal'),
      'die Meldung soll sagen, was das Problem ist',
    );
  });

  it('weist eine unbrauchbare Stufe ab', async () => {
    const antwort = await put(
      `/api/employees/${employeeId}/skills`,
      { skills: [{ name: 'Irgendwas', level: 9 }] },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 422);
  });

  // -------------------------------------------------------------------------
  //  Arbeitszeiten
  // -------------------------------------------------------------------------

  it('setzt die Arbeitszeiten und ersetzt dabei die bisherigen', async () => {
    const antwort = await put(
      `/api/employees/${employeeId}/availability`,
      {
        availability: [
          { weekday: 1, startTime: '06:00', endTime: '12:00' },
          { weekday: 1, startTime: '17:00', endTime: '21:00' },
          { weekday: 6, startTime: '08:00', endTime: '14:00' },
        ],
      },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 200);

    const nachher = await akte();
    assert.equal(nachher.availability.length, 3, 'die Vorgabe Mo–Fr ist ersetzt, nicht ergänzt');

    /**
     * Der geteilte Dienst — zwei Fenster am selben Tag. Häufig in diesem
     * Gewerbe (morgens Treppenhaus, abends Büroreinigung) und der Grund,
     * warum die Maske eine freie Liste ist und keine sieben festen Zeilen.
     */
    const montag = nachher.availability.filter((a) => a.weekday === 1);
    assert.equal(montag.length, 2, 'zwei Fenster am Montag müssen beide bleiben');
  });

  /**
   * Der eindeutige Index deckt nur `(employee, weekday, startTime)` ab — zwei
   * Fenster 07:00–12:00 und 09:00–17:00 gingen glatt durch. Sie ergäben keine
   * falsche Antwort, aber eine Verfügbarkeit, die sich nicht mehr lesen lässt:
   * Wer soll sagen, wann diese Person arbeitet?
   */
  it('weist sich überschneidende Fenster am selben Tag ab', async () => {
    const antwort = await put(
      `/api/employees/${employeeId}/availability`,
      {
        availability: [
          { weekday: 2, startTime: '07:00', endTime: '12:00' },
          { weekday: 2, startTime: '09:00', endTime: '17:00' },
        ],
      },
      { jar: jars.admin },
    );

    assert.equal(antwort.status, 422);
    assert.ok(
      JSON.stringify(antwort.payload).includes('berschneidet'),
      'die Meldung soll die Überschneidung benennen',
    );
  });

  it('dieselbe Zeit an verschiedenen Tagen ist in Ordnung', async () => {
    const antwort = await put(
      `/api/employees/${employeeId}/availability`,
      {
        availability: [
          { weekday: 2, startTime: '07:00', endTime: '12:00' },
          { weekday: 3, startTime: '07:00', endTime: '12:00' },
        ],
      },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 200);
  });

  it('weist ein Ende vor dem Beginn ab', async () => {
    const antwort = await put(
      `/api/employees/${employeeId}/availability`,
      { availability: [{ weekday: 1, startTime: '17:00', endTime: '07:00' }] },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 422);
  });

  it('weist eine unbrauchbare Uhrzeit ab', async () => {
    const antwort = await put(
      `/api/employees/${employeeId}/availability`,
      { availability: [{ weekday: 1, startTime: '25:00', endTime: '26:00' }] },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 422);
  });

  it('eine leere Liste löscht alle Fenster', async () => {
    const antwort = await put(
      `/api/employees/${employeeId}/availability`,
      { availability: [] },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 200);
    assert.equal((await akte()).availability.length, 0);
  });

  // -------------------------------------------------------------------------
  //  Grenzen
  // -------------------------------------------------------------------------

  it('Mitarbeitende und Kundschaft dürfen nichts setzen', async () => {
    for (const rolle of ['employee', 'customer'] as AccountName[]) {
      const skills = await put(
        `/api/employees/${employeeId}/skills`,
        { skills: [{ name: 'Selbstbeförderung', level: 5 }] },
        { jar: jars[rolle] },
      );
      assert.ok(
        skills.status === 403 || skills.status === 401,
        `${rolle} darf keine Qualifikationen setzen (kam ${skills.status})`,
      );

      const zeiten = await put(
        `/api/employees/${employeeId}/availability`,
        { availability: [] },
        { jar: jars[rolle] },
      );
      assert.ok(
        zeiten.status === 403 || zeiten.status === 401,
        `${rolle} darf keine Arbeitszeiten setzen (kam ${zeiten.status})`,
      );
    }
  });

  it('eine unbekannte Personalakte gibt es nicht', async () => {
    const antwort = await put(
      '/api/employees/clzzzzzzzzzzzzzzzzzzzzzzz/skills',
      { skills: [] },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 404);
  });

  /**
   * Zum Schluss ein brauchbarer Zustand, damit die folgenden Prüfdateien nicht
   * auf eine Person ohne Arbeitszeiten treffen. `tests/README.md` verlangt,
   * dass jede Prüfung vor und nach sich aufräumt — hier heisst „aufräumen",
   * die Vorgabe wiederherzustellen.
   */
  it('stellt die Ausgangslage wieder her', async () => {
    const antwort = await put(
      `/api/employees/${employeeId}/availability`,
      {
        availability: [1, 2, 3, 4, 5].map((weekday) => ({
          weekday,
          startTime: '07:00',
          endTime: '17:00',
        })),
      },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 200);
    assert.equal((await akte()).availability.length, 5);
  });
});
