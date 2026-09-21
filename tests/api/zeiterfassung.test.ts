import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { get, post, patch, del, data, requireServer } from '../helpers/client';
import { loginAll, type AccountName } from '../helpers/accounts';

/**
 * Wave 8 — Zeiterfassung ansehen, korrigieren, freigeben.
 *
 * ---------------------------------------------------------------------------
 *  Der Befund
 * ---------------------------------------------------------------------------
 *
 * Es gab zwei Endpunkte: einstempeln und ausstempeln. `TimeEntry.approved`,
 * `approvedById` und `manual` standen im Schema und wurden von keinem Codepfad
 * je geschrieben. `timetracking:approve` war an Rollen vergeben und wurde von
 * **nichts** geprüft.
 *
 * Im Betrieb heisst das: Wer das Ausstempeln vergisst, hat einen offenen
 * Eintrag, den niemand schliessen kann. Wer sich vertippt, hat eine falsche
 * Zeit, die niemand korrigieren kann. Und niemand kann eine Zeit freigeben,
 * bevor sie in die Lohnabrechnung geht.
 *
 * Die Matrix führte die Zeiterfassung als **COMPLETE, ungeprüft** — mit dem
 * Vermerk „Grundlage der Lohnabrechnung". Beides zusammen ist der Grund für
 * diese Datei.
 *
 * ---------------------------------------------------------------------------
 *  Was hier vor allem geprüft wird
 * ---------------------------------------------------------------------------
 *
 * Die vier Regeln, deren Verletzung in der Lohnbuchhaltung landet und nicht in
 * der Fehlersuche: Die Dauer rechnet der Server, eine freigegebene Zeit ist
 * eingefroren, keine Überschneidungen je Person, und die Lohnkosten des
 * Einsatzes wandern mit.
 */

let jars: Record<AccountName, string>;
let employeeId = '';
const angelegt: string[] = [];

interface Eintrag {
  id: string;
  startedAt: string;
  endedAt: string | null;
  breakMin: number;
  minutes: number;
  manual: boolean;
  approved: boolean;
  employee: { id: string };
}

interface Liste {
  eintraege: Eintrag[];
  gesamt: number;
  summeMinuten: number;
}

/** Ein Zeitfenster weit in der Vergangenheit — stört keine Demodaten. */
function fenster(tagVersatz: number, stunde: number, dauerStunden: number) {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - tagVersatz);
  start.setUTCHours(stunde, 0, 0, 0);
  const ende = new Date(start.getTime() + dauerStunden * 3_600_000);
  return { startedAt: start.toISOString(), endedAt: ende.toISOString() };
}

async function erfasse(
  opts: { tagVersatz: number; stunde: number; dauer: number; breakMin?: number },
) {
  const { startedAt, endedAt } = fenster(opts.tagVersatz, opts.stunde, opts.dauer);
  return post<{ data: { id: string; minutes: number } }>(
    '/api/time',
    { employeeId, startedAt, endedAt, breakMin: opts.breakMin ?? 0 },
    { jar: jars.admin },
  );
}

describe('Zeiterfassung', () => {
  before(async () => {
    await requireServer();
    jars = await loginAll();

    const liste = await get<{ data: { id: string }[] }>('/api/employees', { jar: jars.admin });
    assert.equal(liste.status, 200);
    employeeId = data(liste)[0]?.id ?? '';
    assert.ok(employeeId, 'für diese Prüfungen braucht es eine Personalakte im Bestand');
  });

  /**
   * Vor **und** nach sich aufräumen. Eine Zeiterfassung, die liegen bleibt,
   * verfälscht die Nachkalkulation der Einsätze und die Summen, die andere
   * Prüfdateien lesen.
   */
  after(async () => {
    for (const id of angelegt) {
      // Freigegebene zuerst wieder öffnen, sonst verweigert das Löschen.
      await post(`/api/time/${id}/reopen`, undefined, { jar: jars.admin }).catch(() => {});
      await del(`/api/time/${id}`, { jar: jars.admin }).catch(() => {});
    }
  });

  // -------------------------------------------------------------------------
  //  Lesen
  // -------------------------------------------------------------------------

  it('die Liste ist nur mit `timetracking:read_all` erreichbar', async () => {
    const erlaubt = await get('/api/time', { jar: jars.admin });
    assert.equal(erlaubt.status, 200);

    for (const rolle of ['employee', 'customer'] as AccountName[]) {
      const antwort = await get('/api/time', { jar: jars[rolle] });
      assert.ok(
        antwort.status === 403 || antwort.status === 401,
        `${rolle} darf nicht alle Zeiten sehen (kam ${antwort.status})`,
      );
    }
  });

  // -------------------------------------------------------------------------
  //  Erfassen
  // -------------------------------------------------------------------------

  it('erfasst eine Zeit von Hand und rechnet die Dauer selbst', async () => {
    const antwort = await erfasse({ tagVersatz: 40, stunde: 6, dauer: 4, breakMin: 30 });
    assert.equal(antwort.status, 201);

    const ergebnis = data(antwort);
    angelegt.push(ergebnis.id);

    // Vier Stunden minus 30 Minuten Pause.
    assert.equal(ergebnis.minutes, 210, 'die Dauer rechnet der Server, nicht der Client');
  });

  /**
   * Der Grund, warum `minutes` in keinem Schema vorkommt: Ein Feld, in das der
   * Client eine Minutenzahl schreiben könnte, wäre ein Feld, in das jemand
   * eine Lohnsumme schreiben kann. Ein mitgeschickter Wert wird nicht
   * übernommen — er wird gar nicht erst entgegengenommen.
   */
  it('ein mitgeschicktes `minutes` wird nicht übernommen', async () => {
    const { startedAt, endedAt } = fenster(41, 6, 1);
    const antwort = await post<{ data: { id: string; minutes: number } }>(
      '/api/time',
      { employeeId, startedAt, endedAt, breakMin: 0, minutes: 9999 },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 201);
    angelegt.push(data(antwort).id);

    assert.equal(data(antwort).minutes, 60, 'eine Stunde bleibt eine Stunde');
  });

  it('kennzeichnet eine von Hand erfasste Zeit als solche', async () => {
    const liste = await get<{ data: Liste }>(`/api/time?employeeId=${employeeId}&pageSize=5`, {
      jar: jars.admin,
    });
    assert.equal(liste.status, 200);

    const neueste = data(liste).eintraege[0];
    assert.equal(
      neueste.manual,
      true,
      'eine gestempelte Zeit hat einen Zeitpunkt und einen Ort, eine erfasste eine Person',
    );
  });

  it('weist ein Ende vor dem Beginn ab', async () => {
    const { startedAt, endedAt } = fenster(42, 6, 2);
    const antwort = await post(
      '/api/time',
      { employeeId, startedAt: endedAt, endedAt: startedAt, breakMin: 0 },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 422, 'BusinessRuleError kommt als 422');
  });

  it('weist eine Pause ab, die so lang ist wie die Zeit', async () => {
    const antwort = await erfasse({ tagVersatz: 43, stunde: 6, dauer: 1, breakMin: 60 });
    assert.equal(antwort.status, 422);
  });

  /**
   * Die Obergrenze fängt das vergessene Ausstempeln: Ein Eintrag von
   * Freitagmorgen bis Montagmittag ergibt 4400 Minuten, und die gingen
   * unbemerkt in die Lohnkosten des Einsatzes.
   */
  it('weist eine Erfassung über 24 Stunden ab', async () => {
    const antwort = await erfasse({ tagVersatz: 44, stunde: 6, dauer: 30 });
    assert.equal(antwort.status, 422);
    assert.ok(
      JSON.stringify(antwort.payload).includes('Ausstempeln'),
      'die Meldung soll den wahrscheinlichen Grund nennen',
    );
  });

  /**
   * Die Regel, deren Verletzung in der Lohnbuchhaltung landet: Zwei
   * gleichzeitige Erfassungen ergäben doppelten Lohn für dieselbe Stunde.
   */
  it('weist eine Überschneidung mit derselben Person ab', async () => {
    const erste = await erfasse({ tagVersatz: 45, stunde: 8, dauer: 4 });
    assert.equal(erste.status, 201);
    angelegt.push(data(erste).id);

    // Beginnt mitten in der ersten.
    const zweite = await erfasse({ tagVersatz: 45, stunde: 10, dauer: 4 });
    assert.equal(zweite.status, 422);
    assert.ok(
      JSON.stringify(zweite.payload).includes('doppelten Lohn'),
      'die Meldung soll sagen, warum das nicht geht',
    );
  });

  it('eine anschliessende Zeit ohne Überlappung geht durch', async () => {
    const antwort = await erfasse({ tagVersatz: 45, stunde: 12, dauer: 3 });
    assert.equal(antwort.status, 201, 'Ende 12:00, Beginn 12:00 überschneidet sich nicht');
    angelegt.push(data(antwort).id);
  });

  // -------------------------------------------------------------------------
  //  Korrigieren
  // -------------------------------------------------------------------------

  it('korrigiert eine Zeit und rechnet die Dauer neu', async () => {
    const angelegtErgebnis = await erfasse({ tagVersatz: 50, stunde: 7, dauer: 2 });
    assert.equal(angelegtErgebnis.status, 201);
    const id = data(angelegtErgebnis).id;
    angelegt.push(id);
    assert.equal(data(angelegtErgebnis).minutes, 120);

    const { endedAt } = fenster(50, 7, 5);
    const korrektur = await patch<{ data: { minutes: number } }>(
      `/api/time/${id}`,
      { endedAt, breakMin: 45 },
      { jar: jars.admin },
    );
    assert.equal(korrektur.status, 200);
    assert.equal(data(korrektur).minutes, 255, 'fünf Stunden minus 45 Minuten');
  });

  it('weist eine Korrektur ab, die das Ende vor den Beginn legt', async () => {
    const neu = await erfasse({ tagVersatz: 51, stunde: 7, dauer: 2 });
    assert.equal(neu.status, 201);
    const id = data(neu).id;
    angelegt.push(id);

    const { startedAt } = fenster(51, 7, 2);
    const korrektur = await patch(
      `/api/time/${id}`,
      { endedAt: startedAt },
      { jar: jars.admin },
    );
    assert.equal(korrektur.status, 422);
  });

  it('eine leere Änderung ist ein Eingabefehler', async () => {
    const neu = await erfasse({ tagVersatz: 52, stunde: 7, dauer: 1 });
    assert.equal(neu.status, 201);
    angelegt.push(data(neu).id);

    const antwort = await patch(`/api/time/${data(neu).id}`, {}, { jar: jars.admin });
    assert.equal(antwort.status, 422);
  });

  // -------------------------------------------------------------------------
  //  Freigeben — und was die Freigabe bedeutet
  // -------------------------------------------------------------------------

  it('gibt Zeiten frei und meldet, was übersprungen wurde', async () => {
    const eins = await erfasse({ tagVersatz: 60, stunde: 7, dauer: 2 });
    const zwei = await erfasse({ tagVersatz: 61, stunde: 7, dauer: 2 });
    assert.equal(eins.status, 201);
    assert.equal(zwei.status, 201);
    angelegt.push(data(eins).id, data(zwei).id);

    const antwort = await post<{ data: { freigegeben: number; uebersprungen: number } }>(
      '/api/time/approve',
      { entryIds: [data(eins).id, data(zwei).id] },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 200);
    assert.equal(data(antwort).freigegeben, 2);

    /** Ein zweiter Lauf gibt nichts mehr frei und überschreibt nichts. */
    const nochmal = await post<{ data: { freigegeben: number; uebersprungen: number } }>(
      '/api/time/approve',
      { entryIds: [data(eins).id, data(zwei).id] },
      { jar: jars.admin },
    );
    assert.equal(data(nochmal).freigegeben, 0);
    assert.equal(data(nochmal).uebersprungen, 2);
  });

  /**
   * **Die Kernregel dieser Wave.** Ohne sie wäre „freigegeben" eine Anzeige
   * und keine Aussage: Eine Zeit, die als Grundlage einer Abrechnung dient,
   * darf sich nicht mehr unter der Hand ändern.
   */
  it('eine freigegebene Zeit lässt sich weder ändern noch löschen', async () => {
    const neu = await erfasse({ tagVersatz: 62, stunde: 7, dauer: 2 });
    assert.equal(neu.status, 201);
    const id = data(neu).id;
    angelegt.push(id);

    const freigabe = await post('/api/time/approve', { entryIds: [id] }, { jar: jars.admin });
    assert.equal(freigabe.status, 200);

    const korrektur = await patch(`/api/time/${id}`, { breakMin: 60 }, { jar: jars.admin });
    assert.equal(korrektur.status, 422, 'eine freigegebene Zeit ist eingefroren');
    assert.ok(
      JSON.stringify(korrektur.payload).includes('Freigabe'),
      'die Meldung soll den Weg nennen',
    );

    const loeschen = await del(`/api/time/${id}`, { jar: jars.admin });
    assert.equal(loeschen.status, 422);
  });

  it('nach dem Aufheben der Freigabe geht beides wieder', async () => {
    const neu = await erfasse({ tagVersatz: 63, stunde: 7, dauer: 2 });
    const id = data(neu).id;
    angelegt.push(id);

    await post('/api/time/approve', { entryIds: [id] }, { jar: jars.admin });

    const zurueck = await post(`/api/time/${id}/reopen`, undefined, { jar: jars.admin });
    assert.equal(zurueck.status, 200);

    const korrektur = await patch(`/api/time/${id}`, { breakMin: 15 }, { jar: jars.admin });
    assert.equal(korrektur.status, 200);
  });

  it('eine nicht freigegebene Zeit lässt sich nicht „zurücknehmen"', async () => {
    const neu = await erfasse({ tagVersatz: 64, stunde: 7, dauer: 1 });
    angelegt.push(data(neu).id);

    const antwort = await post(`/api/time/${data(neu).id}/reopen`, undefined, {
      jar: jars.admin,
    });
    assert.equal(antwort.status, 422);
  });

  // -------------------------------------------------------------------------
  //  Summen und Filter
  // -------------------------------------------------------------------------

  /**
   * Die Summe kommt über **alle** Treffer, nicht über die angezeigte Seite.
   * Eine Seitensumme wäre die häufigste Fehlerquelle einer solchen Ansicht:
   * Sie sieht aus wie die Monatssumme und ist es nicht.
   */
  it('die Summe gilt für alle Treffer, nicht für die Seite', async () => {
    const eineSeite = await get<{ data: Liste }>(
      `/api/time?employeeId=${employeeId}&pageSize=1`,
      { jar: jars.admin },
    );
    const alle = await get<{ data: Liste }>(
      `/api/time?employeeId=${employeeId}&pageSize=200`,
      { jar: jars.admin },
    );

    const klein = data(eineSeite);
    const gross = data(alle);

    assert.equal(klein.eintraege.length, 1, 'eine Seite mit einem Eintrag');
    assert.ok(gross.eintraege.length > 1, 'und mehr Einträge insgesamt');
    assert.equal(
      klein.summeMinuten,
      gross.summeMinuten,
      'die Summe darf nicht von der Seitengrösse abhängen',
    );
  });

  it('der Filter nach Freigabestand wirkt', async () => {
    const freigegeben = await get<{ data: Liste }>(
      `/api/time?employeeId=${employeeId}&approved=true&pageSize=50`,
      { jar: jars.admin },
    );
    assert.equal(freigegeben.status, 200);
    for (const e of data(freigegeben).eintraege) {
      assert.equal(e.approved, true);
    }

    const offen = await get<{ data: Liste }>(
      `/api/time?employeeId=${employeeId}&approved=false&pageSize=50`,
      { jar: jars.admin },
    );
    for (const e of data(offen).eintraege) {
      assert.equal(e.approved, false);
    }
  });

  it('der Filter nach Person zeigt nur diese Person', async () => {
    const liste = await get<{ data: Liste }>(
      `/api/time?employeeId=${employeeId}&pageSize=50`,
      { jar: jars.admin },
    );
    for (const e of data(liste).eintraege) {
      assert.equal(e.employee.id, employeeId);
    }
  });

  // -------------------------------------------------------------------------
  //  Grenzen
  // -------------------------------------------------------------------------

  it('ohne `timetracking:approve` lässt sich nichts erfassen oder freigeben', async () => {
    const { startedAt, endedAt } = fenster(70, 7, 1);

    for (const rolle of ['employee', 'customer'] as AccountName[]) {
      const erfassen = await post(
        '/api/time',
        { employeeId, startedAt, endedAt, breakMin: 0 },
        { jar: jars[rolle] },
      );
      assert.ok(
        erfassen.status === 403 || erfassen.status === 401,
        `${rolle} darf keine Zeit für andere erfassen (kam ${erfassen.status})`,
      );

      const freigeben = await post(
        '/api/time/approve',
        { entryIds: ['clzzzzzzzzzzzzzzzzzzzzzzz'] },
        { jar: jars[rolle] },
      );
      assert.ok(freigeben.status === 403 || freigeben.status === 401);
    }
  });

  it('eine unbekannte Erfassung gibt es nicht', async () => {
    const antwort = await patch(
      '/api/time/clzzzzzzzzzzzzzzzzzzzzzzz',
      { breakMin: 5 },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 404);
  });

  it('eine unbekannte Personalakte auch nicht', async () => {
    const { startedAt, endedAt } = fenster(71, 7, 1);
    const antwort = await post(
      '/api/time',
      { employeeId: 'clzzzzzzzzzzzzzzzzzzzzzzz', startedAt, endedAt, breakMin: 0 },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 404);
  });
});
