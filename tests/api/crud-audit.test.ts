import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { data, del, get, patch, post, requireServer } from '../helpers/client';
import { loginAll, type AccountName } from '../helpers/accounts';

/**
 * Was die CRUD-Prüfung vom 13. September 2026 ergänzt hat: Feiertage als
 * vollständige Datensatzart, das Zurückziehen eigener Abwesenheitsanträge,
 * die Papierkorb-Seite. Geprüft wird die Tür (Berechtigung je Rolle) und der
 * fachliche Rundlauf (anlegen, ändern, löschen, Regelverstoss).
 *
 * Die Prüfungen räumen hinter sich auf und vorher auf: Ein abgebrochener Lauf
 * hinterlässt sonst einen Feiertag, an dem der nächste Lauf mit 409
 * scheitert — und das sagte nichts über das Produkt.
 */

type Jars = Record<AccountName, string>;

interface Holiday {
  id: string;
  name: string;
  date: string;
  recurring: boolean;
}

const HOLIDAY_NAME = 'Prüf-Feiertag CRUD';

/** Ein Datum weit in der Zukunft — löschbar und ohne Berührung mit echten Daten. */
function futureDate(offsetDays: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 400 + offsetDays);
  return date.toISOString().slice(0, 10);
}

describe('Feiertage — vollständige Datensatzart', () => {
  let jars: Jars;

  before(async () => {
    await requireServer();
    jars = await loginAll();

    // Aufräumen vor dem Lauf.
    const existing = await get<{ data: Holiday[] }>('/api/holidays', { jar: jars.admin });
    for (const holiday of data(existing) ?? []) {
      if (holiday.name === HOLIDAY_NAME) {
        await del(`/api/holidays/${holiday.id}`, { jar: jars.admin });
      }
    }
  });

  it('lesen darf, wer die Firmendaten sieht — schreiben nur die Administration', async () => {
    const read = await get('/api/holidays', { jar: jars.manager });
    assert.equal(read.status, 200, 'Betriebsleitung liest Feiertage');

    const denied = await post(
      '/api/holidays',
      { name: HOLIDAY_NAME, date: futureDate(0) },
      { jar: jars.manager },
    );
    assert.equal(denied.status, 403, 'Betriebsleitung legt keine Feiertage an');

    const employee = await get('/api/holidays', { jar: jars.employee });
    assert.equal(employee.status, 403, 'Mitarbeitende sehen die Verwaltung nicht');

    const anonymous = await get('/api/holidays');
    assert.equal(anonymous.status, 401);
  });

  it('anlegen, ändern, doppelt ablehnen, löschen', async () => {
    const created = await post<{ data: Holiday }>(
      '/api/holidays',
      { name: HOLIDAY_NAME, date: futureDate(0), recurring: false },
      { jar: jars.admin },
    );
    assert.equal(created.status, 201, created.text);
    const holiday = data(created);

    const duplicate = await post(
      '/api/holidays',
      { name: HOLIDAY_NAME, date: futureDate(0) },
      { jar: jars.admin },
    );
    assert.equal(duplicate.status, 409, 'derselbe Name am selben Tag ist ein Doppelklick');

    const invalid = await post(
      '/api/holidays',
      { name: HOLIDAY_NAME, date: '2027-13-40' },
      { jar: jars.admin },
    );
    assert.ok([400, 422].includes(invalid.status), 'ein unmögliches Datum wird abgewiesen');

    const updated = await patch(
      `/api/holidays/${holiday.id}`,
      { date: futureDate(1), recurring: true },
      { jar: jars.admin },
    );
    assert.equal(updated.status, 200, updated.text);

    const list = await get<{ data: Holiday[] }>('/api/holidays', { jar: jars.admin });
    const stored = (data(list) ?? []).find((entry) => entry.id === holiday.id);
    assert.ok(stored, 'der Feiertag steht in der Liste');
    assert.equal(stored.recurring, true);
    assert.equal(String(stored.date).slice(0, 10), futureDate(1));

    const deleted = await del(`/api/holidays/${holiday.id}`, { jar: jars.admin });
    assert.equal(deleted.status, 204);

    const gone = await del(`/api/holidays/${holiday.id}`, { jar: jars.admin });
    assert.equal(gone.status, 404);
  });

  it('die Einstellungsseite zeigt die Feiertage der Administration mit Schaltflächen', async () => {
    const page = await get('/admin/einstellungen?bereich=zeiten', { jar: jars.admin });
    assert.equal(page.status, 200);
    assert.ok(page.text.includes('Feiertag erfassen'), 'Erfassen-Knopf für die Administration');

    const manager = await get('/admin/einstellungen?bereich=zeiten', { jar: jars.manager });
    assert.equal(manager.status, 200);
    assert.ok(
      !manager.text.includes('Feiertag erfassen'),
      'die Betriebsleitung sieht keinen Erfassen-Knopf — sie darf nicht schreiben',
    );
  });
});

describe('Abwesenheit — eigenen Antrag zurückziehen', () => {
  let jars: Jars;

  before(async () => {
    await requireServer();
    jars = await loginAll();
  });

  it('Mitarbeitende ziehen den eigenen Antrag zurück; entschieden ist entschieden', async () => {
    // Ein Antrag weit in der Zukunft, damit er keinem echten in die Quere kommt.
    const start = new Date();
    start.setUTCDate(start.getUTCDate() + 300);
    while (start.getUTCDay() === 0 || start.getUTCDay() === 6) {
      start.setUTCDate(start.getUTCDate() + 1);
    }
    const day = start.toISOString().slice(0, 10);

    const created = await post<{ data: { id: string; status: string } }>(
      '/api/absences',
      { type: 'TRAINING', startDate: day, endDate: day, reason: 'Prüfung CRUD' },
      { jar: jars.employee },
    );
    assert.equal(created.status, 201, created.text);
    const absence = data(created);

    // Ein fremdes Konto findet den Antrag nicht — auch die Administration
    // nicht, weil sie kein Mitarbeitendenprofil hat.
    const foreign = await post(`/api/absences/${absence.id}/withdraw`, undefined, {
      jar: jars.admin,
    });
    assert.ok([403, 404].includes(foreign.status), `fremder Zugriff: ${foreign.status}`);

    const customer = await post(`/api/absences/${absence.id}/withdraw`, undefined, {
      jar: jars.customer,
    });
    assert.equal(customer.status, 403, 'Kundschaft hat kein absence:request');

    const withdrawn = await post<{ data: { status: string } }>(
      `/api/absences/${absence.id}/withdraw`,
      undefined,
      { jar: jars.employee },
    );
    assert.equal(withdrawn.status, 200, withdrawn.text);
    assert.equal(data(withdrawn).status, 'CANCELLED');

    const again = await post(`/api/absences/${absence.id}/withdraw`, undefined, {
      jar: jars.employee,
    });
    assert.equal(again.status, 422, 'ein zurückgezogener Antrag bleibt zurückgezogen');

    // Ein entschiedener Antrag lässt sich nicht zurückziehen.
    const second = await post<{ data: { id: string } }>(
      '/api/absences',
      { type: 'TRAINING', startDate: day, endDate: day, reason: 'Prüfung CRUD (entschieden)' },
      { jar: jars.employee },
    );
    assert.equal(second.status, 201, second.text);
    const decided = await post(
      `/api/absences/${data(second).id}/decide`,
      { status: 'REJECTED', decisionNote: 'Prüfung' },
      { jar: jars.manager },
    );
    assert.equal(decided.status, 200, decided.text);

    const locked = await post(`/api/absences/${data(second).id}/withdraw`, undefined, {
      jar: jars.employee,
    });
    assert.equal(locked.status, 422);
  });
});

describe('Papierkorb — Seite und Wiederherstellen', () => {
  let jars: Jars;

  before(async () => {
    await requireServer();
    jars = await loginAll();
  });

  it('Leitung und Administration sehen die Seite, Mitarbeitende und Kundschaft nicht', async () => {
    for (const account of ['admin', 'manager'] as AccountName[]) {
      const page = await get('/admin/papierkorb', { jar: jars[account] });
      assert.equal(page.status, 200, `${account}: ${page.status}`);
      assert.ok(page.text.includes('Papierkorb'));
    }

    for (const account of ['employee', 'customer'] as AccountName[]) {
      const page = await get('/admin/papierkorb', { jar: jars[account] });
      assert.ok(
        [302, 303, 307, 403, 404].includes(page.status),
        `${account} kommt nicht auf die Seite: ${page.status}`,
      );
    }
  });

  it('eine gelöschte Anfrage erscheint im Papierkorb und kommt zurück', async () => {
    /**
     * Ein eindeutiger Name je Lauf: Die Anfrage bleibt am Ende im Papierkorb
     * (Anfragen kennen kein endgültiges Löschen), und der nächste Lauf sähe
     * sonst die alte neben der neuen — die Prüfung „nach dem Wiederherstellen
     * ist sie weg" schlüge dann fehl, ohne dass etwas kaputt wäre.
     */
    const marker = `Prüfung ${Date.now()}`;
    const created = await post<{ data: { id: string } }>(
      '/api/leads',
      {
        firstName: 'Papierkorb',
        lastName: marker,
        email: `papierkorb.${Date.now()}@example.ch`,
        source: 'OTHER',
      },
      { jar: jars.manager },
    );
    assert.equal(created.status, 201, created.text);
    const lead = data(created);

    const deleted = await del(`/api/leads/${lead.id}`, { jar: jars.manager });
    assert.equal(deleted.status, 204, deleted.text);

    const page = await get('/admin/papierkorb', { jar: jars.manager });
    assert.equal(page.status, 200);
    assert.ok(page.text.includes(marker), 'die Anfrage steht im Papierkorb');

    const restored = await post(`/api/leads/${lead.id}/restore`, undefined, { jar: jars.manager });
    assert.equal(restored.status, 200, restored.text);

    const after = await get('/admin/papierkorb', { jar: jars.manager });
    assert.ok(!after.text.includes(marker), 'nach dem Wiederherstellen ist sie weg');

    // Aufräumen: endgültig gibt es nicht — in den Papierkorb zurück, damit die
    // Anfrage keine Liste verstopft.
    await del(`/api/leads/${lead.id}`, { jar: jars.manager });
  });
});
