import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { BASE_URL, del, get, patch, post, requireServer } from '../helpers/client';
import { ACCOUNTS, loginAll } from '../helpers/accounts';

/**
 * Eigentümerschaft und Rechtegrenzen, die der Rauchtest nicht sieht.
 *
 * Der Rauchtest fragt „antwortet der Endpunkt?", nicht „mit *wessen* Daten?".
 * Genau dort lag der Fehler, den diese Datei festhält: `/api/properties`
 * antwortete der Kundschaft mit 200 — und mit den Objekten aller anderen
 * Kundinnen und Kunden, samt Schlüsseldepot und Zugangshinweis. Ein Test, der
 * nur den Statuscode prüft, hätte das für immer als grün gemeldet.
 */

interface PropertyRow {
  id: string;
  customer: { id: string };
  _count: { jobs: number };
}

describe('Eigentümerschaft und Rechtegrenzen', { concurrency: 1 }, async () => {
  await requireServer();
  const jars = await loginAll();

  describe('Objekte', () => {
    it('die Kundschaft sieht ausschliesslich die eigenen Objekte', async () => {
      const own = await get<{ data: PropertyRow[] }>('/api/properties', { jar: jars.customer });
      assert.equal(own.status, 200);

      const owners = new Set(own.payload.data.map((row) => row.customer.id));
      assert.ok(owners.size <= 1, `Objekte von ${owners.size} verschiedenen Kundschaften sichtbar`);

      // Gegenprobe: Das Büro sieht mehr als eine Kundschaft — sonst bewiese
      // die Prüfung oben nur, dass die Datenbank leer ist.
      const all = await get<{ data: PropertyRow[] }>('/api/properties', { jar: jars.admin });
      const allOwners = new Set(all.payload.data.map((row) => row.customer.id));
      assert.ok(allOwners.size > 1, 'Demodaten enthalten Objekte mehrerer Kundschaften');
    });

    it('Mitarbeitende sehen nur Objekte mit zugeteilten Einsätzen', async () => {
      const response = await get<{ data: PropertyRow[] }>('/api/properties', {
        jar: jars.employee,
      });
      assert.equal(response.status, 200);
      for (const row of response.payload.data) {
        assert.ok(row._count.jobs > 0, `Objekt ${row.id} ohne Einsatz sichtbar`);
      }
    });

    it('die Kundschaft kann fremde Objekte weder lesen noch ändern', async () => {
      const all = await get<{ data: PropertyRow[] }>('/api/properties', { jar: jars.admin });
      const own = await get<{ data: PropertyRow[] }>('/api/properties', { jar: jars.customer });
      const ownIds = new Set(own.payload.data.map((row) => row.id));
      const foreign = all.payload.data.find((row) => !ownIds.has(row.id));
      assert.ok(foreign, 'kein fremdes Objekt in den Demodaten');

      assert.equal((await get(`/api/properties/${foreign.id}`, { jar: jars.customer })).status, 404);
      assert.equal(
        (await patch(`/api/properties/${foreign.id}`, { label: 'Fremdzugriff' }, { jar: jars.customer }))
          .status,
        404,
      );
      assert.equal(
        (
          await post(
            '/api/properties',
            {
              customerId: foreign.customer.id,
              label: 'Untergeschoben',
              kind: 'APARTMENT',
              address: { street: 'Teststrasse', postalCode: '3011', city: 'Bern' },
            },
            { jar: jars.customer },
          )
        ).status,
        403,
      );
    });
  });

  describe('Rollen über die Personalakte', () => {
    it('die Betriebsleitung kann über die Personalakte keine Rolle vergeben', async () => {
      const employees = await get<{ data: { id: string; user: { id: string; role: string } }[] }>(
        '/api/employees',
        { jar: jars.admin },
      );
      const target = employees.payload.data.find((row) => row.user.role === 'EMPLOYEE');
      assert.ok(target, 'kein Konto mit Rolle EMPLOYEE in den Demodaten');

      const response = await patch(
        `/api/employees/${target.id}`,
        { role: 'ADMIN' },
        { jar: jars.manager },
      );
      // Das unbekannte Feld wird verworfen, nicht angewendet.
      assert.ok(response.status < 500, `HTTP ${response.status}`);

      const after = await get<{ data: { user: { role: string } } }>(
        `/api/employees/${target.id}`,
        { jar: jars.admin },
      );
      assert.equal(after.payload.data.user.role, 'EMPLOYEE');
    });

    it('die Administration legt kein Personal mit höherer Rolle an', async () => {
      const response = await post(
        '/api/employees',
        {
          firstName: 'Test',
          lastName: 'Eskalation',
          email: `eskalation.${Date.now()}@example.ch`,
          role: 'MANAGER',
          hiredAt: '2026-01-01',
        },
        { jar: jars.admin },
      );
      assert.equal(response.status, 403);
    });
  });

  /*
   * Audit 2026-09-28 (L-05): `/portal/aufgaben` ist neu — die Liste der
   * eigenen Aufgaben. Die Eigentümerschaft steht in der Prisma-Abfrage
   * (`assigneeId` = Sitzung); geprüft wird am ausgelieferten HTML, dass eine
   * fremde und eine niemandem zugewiesene Aufgabe nicht erscheinen, und am
   * Endpunkt, dass die fremde sich nicht abhaken lässt.
   */
  describe('Aufgaben im Portal', () => {
    it('Mitarbeitende sehen und ändern nur die eigenen Aufgaben', async () => {
      const eigeneTitel = 'Portalaufgabe eigene Prüfung';
      const fremdeTitel = 'Portalaufgabe fremde Prüfung';
      const aufraeumen = async () => {
        for (const titel of [eigeneTitel, fremdeTitel]) {
          const alt = await get<{ data: { id: string; title: string }[] }>(`/api/tasks?q=${encodeURIComponent(titel)}`, { jar: jars.admin });
          for (const t of (alt.payload.data ?? []).filter((x) => x.title === titel)) await del(`/api/tasks/${t.id}`, { jar: jars.admin });
        }
      };
      await aufraeumen();

      const employees = await get<{ data: { user: { id: string; email: string; role: string } }[] }>('/api/employees', { jar: jars.admin });
      const ich = employees.payload.data.find((row) => row.user.email === ACCOUNTS.employee.email);
      assert.ok(ich, 'Demokonto der Mitarbeitenden ohne Personalakte');
      const andere = employees.payload.data.find((row) => row.user.role === 'EMPLOYEE' && row.user.id !== ich.user.id);

      const eigene = await post<{ data: { id: string } }>('/api/tasks', { title: eigeneTitel, assigneeId: ich.user.id }, { jar: jars.admin });
      assert.equal(eigene.status, 201);
      // Fremd: einer anderen Person zugewiesen, sonst niemandem — beides darf nicht erscheinen.
      const fremde = await post<{ data: { id: string } }>('/api/tasks', { title: fremdeTitel, ...(andere ? { assigneeId: andere.user.id } : {}) }, { jar: jars.admin });
      assert.equal(fremde.status, 201);

      try {
        const seite = await get('/portal/aufgaben', { jar: jars.employee });
        assert.equal(seite.status, 200);
        assert.ok(seite.text.includes(eigeneTitel), 'eigene Aufgabe fehlt im Portal');
        assert.ok(!seite.text.includes(fremdeTitel), 'fremde Aufgabe im Portal sichtbar');

        const liste = await get<{ data: { title: string }[] }>('/api/tasks', { jar: jars.employee });
        assert.ok(!liste.payload.data.some((t) => t.title === fremdeTitel), 'fremde Aufgabe über /api/tasks sichtbar');

        assert.equal((await patch(`/api/tasks/${fremde.payload.data.id}`, { status: 'DONE' }, { jar: jars.employee })).status, 403);
        assert.equal((await patch(`/api/tasks/${eigene.payload.data.id}`, { status: 'IN_PROGRESS' }, { jar: jars.employee })).status, 200);

        // Die Kundschaft betritt das Portal nicht.
        const kunde = await get('/portal/aufgaben', { jar: jars.customer, redirect: 'manual' });
        assert.ok(kunde.status >= 300 && kunde.status < 400, `Kundschaft im Portal: HTTP ${kunde.status}`);
      } finally {
        await aufraeumen();
      }
    });
  });

  describe('Bewertungen', () => {
    it('das Büro erhält die Bewertungsliste statt eines 403', async () => {
      const response = await get('/api/reviews', { jar: jars.admin });
      assert.equal(response.status, 200);
    });
  });

  describe('Herkunftsprüfung', () => {
    it('lehnt ändernde Anfragen mit fremdem Origin ab', async () => {
      const response = await post('/api/notifications/read-all', undefined, {
        jar: jars.customer,
        headers: { origin: 'https://fremde-seite.example' },
      });
      assert.equal(response.status, 403);
    });

    it('lässt die eigene Herkunft und Aufrufe ohne Origin durch', async () => {
      const same = await post('/api/notifications/read-all', undefined, {
        jar: jars.customer,
        headers: { origin: new URL(BASE_URL).origin },
      });
      assert.equal(same.status, 200);

      const none = await post('/api/notifications/read-all', undefined, { jar: jars.customer });
      assert.equal(none.status, 200);
    });
  });

  describe('Ausgeliefertes HTML', () => {
    /**
     * Platzhalter, die nie auf einer Seite stehen dürfen. Sie entstehen, wenn
     * ein Feld fehlt und niemand es abgefangen hat — und sie sehen für die
     * Person am Bildschirm wie ein Absturz aus, auch wenn die Seite mit 200
     * antwortet. Skripte werden vorher entfernt: Der RSC-Datenstrom enthält
     * `undefined` legitim.
     */
    const PAGES = [
      ['admin', '/admin'],
      ['admin', '/admin/kunden'],
      ['admin', '/admin/buchungen'],
      ['admin', '/admin/rechnungen'],
      ['admin', '/admin/einsaetze'],
      ['admin', '/admin/personal'],
      ['admin', '/admin/einstellungen'],
      ['employee', '/portal'],
      ['customer', '/konto'],
      ['customer', '/konto/objekte'],
    ] as const;

    for (const [role, path] of PAGES) {
      it(`${path} zeigt keine Platzhalterwerte`, async () => {
        const response = await get(path, { jar: jars[role] });
        assert.equal(response.status, 200);
        const visible = response.text
          .replace(/<script[\s\S]*?<\/script>/g, '')
          .replace(/<[^>]+>/g, ' ');
        for (const marker of ['undefined', 'NaN', 'Invalid Date', '[object Object]']) {
          assert.ok(!visible.includes(marker), `„${marker}" auf ${path}`);
        }
      });
    }
  });
});
