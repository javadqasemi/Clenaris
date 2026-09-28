import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { call, get, put, requireServer } from '../helpers/client';
import { ACCOUNTS, loginAll, ROLE_ORDER, type AccountName } from '../helpers/accounts';
import { testDb, testDbSchliessen } from '../helpers/testdb';

/**
 * Die Einstellungen — und die Frage, ob sich der Betrieb ohne Quelltext
 * führen lässt.
 *
 * Der Anspruch an das System lautet, dass die Verwaltung Stammdaten,
 * Arbeitszeiten und Betriebsschalter selbst pflegen kann. Geprüft wird
 * deshalb nicht nur, dass der Endpunkt antwortet, sondern dass die Maske die
 * Werte auch zeigt und der geänderte Wert dort wieder ankommt.
 *
 * Alles wird am Ende zurückgesetzt: Diese Werte hängen an Rechnungen und am
 * Buchungsassistenten, und ein Testlauf darf sie nicht verstellt zurücklassen.
 */

interface Company {
  name: string;
  email: string;
  street: string;
  postalCode: string;
  city: string;
  phone?: string | null;
  [key: string]: unknown;
}

interface Settings {
  bookingLeadDays: number;
  bookingMinNoticeHours: number;
  moderateReviews: boolean;
  [key: string]: unknown;
}

let jars: Record<AccountName, string>;

describe('Einstellungen', { concurrency: 1 }, async () => {
  await requireServer();
  jars = await loginAll();

  let company: Company;
  let settings: Settings;

  after(async () => {
    if (company) await call('PATCH', '/api/company', { jar: jars.admin, body: company });
    if (settings) await call('PATCH', '/api/settings', { jar: jars.admin, body: settings });
    await testDbSchliessen();
  });

  // -------------------------------------------------------------------------
  describe('Zugriff', () => {
    /**
     * Lesen darf die Betriebsleitung — sie braucht Öffnungszeiten und
     * Zahlungsfristen für die Disposition. Ändern darf nur die Verwaltung:
     * Diese Werte stehen auf jeder Rechnung und im Impressum.
     */
    const MAY_READ: Record<AccountName, boolean> = {
      super: true,
      admin: true,
      manager: true,
      employee: false,
      customer: false,
    };
    const MAY_WRITE: Record<AccountName, boolean> = {
      super: true,
      admin: true,
      manager: false,
      employee: false,
      customer: false,
    };

    for (const role of ROLE_ORDER) {
      it(`${role}: liest ${MAY_READ[role] ? 'ja' : 'nein'}, schreibt ${MAY_WRITE[role] ? 'ja' : 'nein'}`, async () => {
        const read = await get('/api/settings', { jar: jars[role] });
        assert.equal(read.status, MAY_READ[role] ? 200 : 403, `Lesen: HTTP ${read.status}`);

        const write = await call('PATCH', '/api/settings', {
          jar: jars[role],
          body: { bookingLeadDays: 90 },
        });
        if (MAY_WRITE[role]) {
          assert.equal(write.status, 200, `Schreiben: HTTP ${write.status}`);
        } else {
          assert.ok([401, 403].includes(write.status), `Schreiben: HTTP ${write.status}`);
        }
      });
    }
  });

  // -------------------------------------------------------------------------
  describe('Firmendaten', () => {
    it('liest den aktuellen Stand', async () => {
      const response = await get<{ data: Company }>('/api/company', { jar: jars.admin });
      assert.equal(response.status, 200);
      assert.ok(response.payload.data.name, 'kein Firmenname');
      company = response.payload.data;
    });

    it('zeigt ihn in der Bearbeitungsmaske', async () => {
      const page = await get('/admin/einstellungen', { jar: jars.admin });
      assert.equal(page.status, 200);
      // Der Wert steht in einem Eingabefeld, nicht nur als Text — sonst wäre
      // die Seite wieder das Protokoll, das sie vorher war.
      assert.ok(
        page.text.includes(`value="${company.email}"`),
        'die E-Mail-Adresse steht in keinem Eingabefeld',
      );
    });

    it('nimmt eine Änderung an und zeigt sie danach an', async () => {
      const marker = `+41 31 000 ${String(Date.now()).slice(-4)}`;
      const saved = await call('PATCH', '/api/company', {
        jar: jars.admin,
        body: { ...company, phone: marker },
      });
      assert.equal(saved.status, 200, JSON.stringify(saved.payload));

      const again = await get<{ data: Company }>('/api/company', { jar: jars.admin });
      assert.equal(again.payload.data.phone, marker);

      const page = await get('/admin/einstellungen', { jar: jars.admin });
      assert.ok(page.text.includes(marker), 'die Änderung erscheint nicht in der Maske');
    });

    it('weist eine unvollständige Adresse ab', async () => {
      // Ohne Ort trüge jede Rechnung eine halbe Absenderadresse.
      const response = await call('PATCH', '/api/company', {
        jar: jars.admin,
        body: { ...company, city: '' },
      });
      assert.ok([400, 422].includes(response.status), `HTTP ${response.status}`);
    });

    it('zeigt der Betriebsleitung das Protokoll statt der Felder', async () => {
      const page = await get('/admin/einstellungen', { jar: jars.manager });
      if (page.status !== 200) {
        assert.ok([307, 308, 404].includes(page.status), `HTTP ${page.status}`);
        return;
      }
      // Ausgegraute Eingabefelder suggerieren, es fehle nur ein Klick.
      assert.ok(
        !page.text.includes(`value="${company.email}"`),
        'die Betriebsleitung sieht bearbeitbare Felder',
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('Arbeitszeiten', () => {
    interface Hour {
      weekday: number;
      opensAt: string | null;
      closesAt: string | null;
      closed: boolean;
    }
    let original: Hour[] = [];

    it('liest die Woche', async () => {
      const response = await get<{ data: Hour[] }>('/api/opening-hours', { jar: jars.admin });
      assert.equal(response.status, 200);
      original = response.payload.data;
      assert.ok(original.length > 0, 'keine Öffnungszeiten hinterlegt');
    });

    it('setzt die ganze Woche auf einmal', async () => {
      // Sieben Zeilen hin, sieben zurück: Tag für Tag zu speichern hinterliesse
      // bei einem Fehlschlag einen halben Wochenplan.
      const week = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
        weekday,
        opensAt: weekday === 0 ? '' : '07:30',
        closesAt: weekday === 0 ? '' : '18:30',
        closed: weekday === 0,
      }));

      const saved = await put<{ data: Hour[] }>('/api/opening-hours', { hours: week }, {
        jar: jars.admin,
      });
      assert.equal(saved.status, 200, JSON.stringify(saved.payload));
      assert.equal(saved.payload.data.length, 7);

      const monday = saved.payload.data.find((hour) => hour.weekday === 1);
      assert.equal(monday?.opensAt, '07:30');
      assert.equal(monday?.closesAt, '18:30');

      const sunday = saved.payload.data.find((hour) => hour.weekday === 0);
      assert.equal(sunday?.closed, true);
    });

    it('zeigt die neuen Zeiten in der Maske', async () => {
      // Die Register sind über die Adresszeile erreichbar; ohne `bereich`
      // liefert der Server nur das erste, und die Prüfung liefe ins Leere.
      const page = await get('/admin/einstellungen?bereich=zeiten', { jar: jars.admin });
      assert.equal(page.status, 200);
      assert.ok(page.text.includes('value="07:30"'), 'die neue Öffnungszeit fehlt in der Maske');
    });

    it('weist eine Schliesszeit vor der Öffnungszeit ab', async () => {
      const response = await put(
        '/api/opening-hours',
        { hours: [{ weekday: 1, opensAt: '18:00', closesAt: '08:00', closed: false }] },
        { jar: jars.admin },
      );
      assert.equal(response.status, 422);
    });

    it('stellt den Ausgangszustand wieder her', async () => {
      const response = await put(
        '/api/opening-hours',
        {
          hours: original.map((hour) => ({
            weekday: hour.weekday,
            opensAt: hour.opensAt ?? '',
            closesAt: hour.closesAt ?? '',
            closed: hour.closed,
          })),
        },
        { jar: jars.admin },
      );
      assert.equal(response.status, 200);
    });
  });

  // -------------------------------------------------------------------------
  describe('Betriebsschalter', () => {
    it('füllt fehlende Schlüssel mit dem Auslieferungswert', async () => {
      const response = await get<{ data: Settings }>('/api/settings', { jar: jars.admin });
      assert.equal(response.status, 200);
      settings = response.payload.data;

      // Alle acht müssen da sein, auch wenn nie eine gespeichert wurde.
      for (const key of [
        'bookingLeadDays',
        'bookingMinNoticeHours',
        'cancellationDeadlineHours',
        'smsRemindersEnabled',
        'autoDunningEnabled',
        'firstReminderAfterDays',
        'reviewRequestAfterDays',
        'moderateReviews',
      ]) {
        assert.ok(key in settings, `Schlüssel ${key} fehlt`);
      }
    });

    it('ändert einzelne Schalter, ohne die übrigen zu verlieren', async () => {
      // Ein vollständiges Überschreiben würde bei zwei gleichzeitig geöffneten
      // Masken die Änderung der jeweils anderen still verwerfen.
      const saved = await call('PATCH', '/api/settings', {
        jar: jars.admin,
        body: { bookingLeadDays: 123 },
      });
      assert.equal(saved.status, 200);

      const after = await get<{ data: Settings }>('/api/settings', { jar: jars.admin });
      assert.equal(after.payload.data.bookingLeadDays, 123);
      assert.equal(
        after.payload.data.bookingMinNoticeHours,
        settings.bookingMinNoticeHours,
        'ein unbeteiligter Schalter hat sich mitverändert',
      );
    });

    it('zeigt den geänderten Wert in der Maske', async () => {
      const page = await get('/admin/einstellungen?bereich=betrieb', { jar: jars.admin });
      assert.equal(page.status, 200);
      assert.ok(page.text.includes('value="123"'), 'der neue Wert fehlt in der Maske');
    });

    it('weist einen Wert ausserhalb der Grenzen ab', async () => {
      // 4000 Tage Vorlauf ist ein Tippfehler, kein Wunsch.
      const response = await call('PATCH', '/api/settings', {
        jar: jars.admin,
        body: { bookingLeadDays: 4000 },
      });
      assert.ok([400, 422].includes(response.status), `HTTP ${response.status}`);
    });

    it('weist einen unbekannten Schlüssel ab', async () => {
      // Zod schneidet unbekannte Schlüssel voreingestellt still ab. Genau dann
      // macht ein Tippfehler — `moderatReviews` statt `moderateReviews` — die
      // Einstellung wirkungslos, und die Antwort lautet trotzdem 200.
      const response = await call('PATCH', '/api/settings', {
        jar: jars.admin,
        body: { moderatReviews: false },
      });
      assert.ok([400, 422].includes(response.status), `HTTP ${response.status}`);
    });

    it('lässt einen Schalter nach einem abgewiesenen Aufruf unverändert', async () => {
      const after = await get<{ data: Settings }>('/api/settings', { jar: jars.admin });
      assert.equal(after.payload.data.moderateReviews, settings.moderateReviews);
    });
  });

  // -------------------------------------------------------------------------
  /**
   * Persönliche Einstellungen gegen Betriebseinstellungen (Produktsprint
   * 2026-09-26).
   *
   * Der Fehler, der hier nicht wiederkommen soll: „Einstellungen" im
   * Kontomenü führte in die Firmenkonfiguration. Geprüft wird beides — dass
   * jede Rolle ihre eigenen Einstellungen erreicht und dort das findet, was
   * ihr eigenes Konto betrifft, und dass der Weg dorthin keine Tür zu Firma,
   * Preisen oder Arbeitszeiten öffnet, weder als Seite noch als Endpunkt.
   */
  describe('Persönliche Einstellungen', () => {
    const BEREICH: Record<AccountName, string> = {
      super: '/admin',
      admin: '/admin',
      manager: '/admin',
      employee: '/portal',
      customer: '/konto',
    };

    for (const role of ROLE_ORDER) {
      it(`${role}: ${BEREICH[role]}/profil/einstellungen zeigt das eigene Konto, nicht die Firma`, async () => {
        const page = await get(`${BEREICH[role]}/profil/einstellungen`, { jar: jars[role] });
        assert.equal(page.status, 200, `HTTP ${page.status}`);
        assert.ok(page.text.includes('Persönliche Einstellungen'), 'Seitentitel fehlt');
        assert.ok(page.text.includes('Passwort ändern'), 'Passwortformular fehlt');
        assert.ok(page.text.includes('Benachrichtigungen'), 'Benachrichtigungen fehlen');
        // Nichts aus der Firmenmaske: weder das Register der Arbeitszeiten
        // noch die Firmenangaben als Eingabefeld.
        assert.ok(!page.text.includes('bereich=zeiten'), 'Register der Betriebseinstellungen auf der persönlichen Seite');
        if (company) {
          assert.ok(!page.text.includes(`value="${company.email}"`), 'Firmenangaben auf der persönlichen Seite');
        }
      });
    }

    it('das Profil verweist auf die persönlichen Einstellungen seines eigenen Bereichs', async () => {
      for (const role of ['admin', 'employee', 'customer'] as const) {
        const page = await get(`${BEREICH[role]}/profil`, { jar: jars[role] });
        assert.equal(page.status, 200);
        assert.ok(
          page.text.includes(`href="${BEREICH[role]}/profil/einstellungen"`),
          `${role}: kein Reiter „Einstellungen" auf dem Profil`,
        );
      }
    });

    it('Mitarbeitende und Kundschaft erreichen die Betriebseinstellungen weder als Seite noch als Endpunkt', async () => {
      for (const role of ['employee', 'customer'] as const) {
        const page = await get('/admin/einstellungen', { jar: jars[role] });
        assert.ok([302, 303, 307, 308, 404].includes(page.status), `${role}: Seite HTTP ${page.status}`);

        for (const [method, path, body] of [
          ['PATCH', '/api/company', { name: 'Übernahme' }],
          ['PATCH', '/api/settings', { bookingLeadDays: 1 }],
          ['PUT', '/api/opening-hours', { hours: [] }],
        ] as const) {
          const response = await call(method, path, { jar: jars[role], body });
          assert.equal(response.status, 403, `${role}: ${method} ${path} HTTP ${response.status}`);
        }
      }
    });

    it('über das eigene Profil lässt sich weder Rolle noch Organisation ändern', async () => {
      const vorher = await get<{ data: { firstName: string; role: string } }>('/api/auth/session', { jar: jars.employee });
      assert.equal(vorher.payload.data.role, 'EMPLOYEE');
      const antwort = await call('PATCH', '/api/account/profile', {
        jar: jars.employee,
        body: {
          firstName: vorher.payload.data.firstName,
          lastName: 'Keller',
          role: 'SUPER_ADMIN',
          organizationId: 'fremd',
          email: 'uebernahme@example.ch',
        },
      });
      // Unbekannte Felder werden entweder abgewiesen oder verworfen — beides
      // ist in Ordnung. Nicht in Ordnung wäre, dass eines davon wirkt.
      assert.ok([200, 400, 422].includes(antwort.status), `HTTP ${antwort.status}`);
      const nachher = await get<{ data: { role: string } }>('/api/auth/session', { jar: jars.employee });
      assert.equal(nachher.payload.data.role, 'EMPLOYEE', 'die Rolle hat sich über das Profil geändert');
      // Die Sitzung trägt die Rolle aus dem Token — massgeblich ist die Zeile.
      const db = testDb();
      if (db) {
        const zeile = await db.user.findUnique({
          where: { email: ACCOUNTS.employee.email },
          select: { role: true, email: true, organizationId: true },
        });
        assert.equal(zeile?.role, 'EMPLOYEE');
        assert.equal(zeile?.email, ACCOUNTS.employee.email);
        assert.notEqual(zeile?.organizationId, 'fremd');
      }
    });
  });
});
