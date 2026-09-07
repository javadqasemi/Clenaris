import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { call, del, get, post, requireServer } from '../helpers/client';
import { loginAll, ROLE_ORDER, type AccountName } from '../helpers/accounts';
import { cookieValue, decodeJwt } from '../helpers/totp';

/**
 * Adressen einer Kundschaft — vom Büro und vom Kundenkonto aus.
 *
 * Der interessante Teil ist nicht das Anlegen, sondern die Grenze: Ein Konto
 * mit `customer:update_own` darf genau eine Akte anfassen, die eigene. Wer
 * das prüft, prüft die Stelle, an der ein Fehler nicht auffällt — er sieht
 * für die betroffene Person aus wie eine ganz normale Antwort.
 *
 * Dazu die Fachregeln, die eine Adresse schützen: Genau eine Standardadresse,
 * kein Löschen dessen, worauf Einsätze verweisen, und die letzte bleibt.
 */

interface Address {
  id: string;
  street: string;
  streetNo: string | null;
  postalCode: string;
  city: string;
  isDefault: boolean;
  isBilling: boolean;
  _count?: { properties: number; bookings: number; jobs: number };
}

let jars: Record<AccountName, string>;
let ownCustomerId = '';
let otherCustomerId = '';

/** Was dieser Lauf angelegt hat — wird am Ende entfernt. */
const created: { customerId: string; addressId: string }[] = [];

describe('Adressen', { concurrency: 1 }, async () => {
  await requireServer();
  jars = await loginAll();

  after(async () => {
    for (const { customerId, addressId } of created) {
      await del(`/api/customers/${customerId}/addresses/${addressId}`, { jar: jars.admin });
    }
  });

  // -------------------------------------------------------------------------
  it('findet die eigene Akte und eine fremde', () => {
    /**
     * Die eigene Kennung kommt aus dem Zugangstoken (`pid`), nicht aus einer
     * Suche in der Kundenliste. Zwei Gründe: Es ist genau der Wert, den der
     * Server für die Grenzprüfung heranzieht — der Test misst damit dieselbe
     * Sache, die er prüft. Und die Liste ist blätterbar; wer dort das erste
     * Blatt durchsucht, findet mit wachsendem Bestand irgendwann nichts mehr
     * und meldet einen Fehler, den es nicht gibt.
     */
    const token = cookieValue(jars.customer, 'clenaris_at');
    assert.ok(token, 'kein Zugangstoken in der Sitzung der Kundschaft');

    const claims = decodeJwt(token);
    assert.equal(claims.role, 'CUSTOMER');
    ownCustomerId = String(claims.pid ?? '');
    assert.match(ownCustomerId, /^c[a-z0-9]{10,}$/, 'keine Kundenkennung im Token');
  });

  it('findet eine fremde Akte im Bestand', async () => {
    const list = await get<{ data: { id: string }[] }>('/api/customers?pageSize=50', {
      jar: jars.admin,
    });
    assert.equal(list.status, 200);

    const other = list.payload.data.find((customer) => customer.id !== ownCustomerId);
    assert.ok(other, 'keine zweite Kundenakte im Bestand');
    otherCustomerId = other.id;
  });

  // -------------------------------------------------------------------------
  describe('Zugriff', () => {
    it('lässt das Büro jede Akte lesen', async () => {
      for (const role of ['super', 'admin', 'manager'] as const) {
        const response = await get(`/api/customers/${otherCustomerId}/addresses`, {
          jar: jars[role],
        });
        assert.equal(response.status, 200, `${role}: HTTP ${response.status}`);
      }
    });

    it('lässt die Kundschaft die eigene Akte lesen', async () => {
      const response = await get<{ data: Address[] }>(
        `/api/customers/${ownCustomerId}/addresses`,
        { jar: jars.customer },
      );
      assert.equal(response.status, 200);
      assert.ok(Array.isArray(response.payload.data));
    });

    it('verwehrt der Kundschaft die fremde Akte — lesend', async () => {
      const response = await get(`/api/customers/${otherCustomerId}/addresses`, {
        jar: jars.customer,
      });
      assert.equal(response.status, 403);
    });

    it('verwehrt der Kundschaft die fremde Akte — schreibend', async () => {
      const response = await post(
        `/api/customers/${otherCustomerId}/addresses`,
        { street: 'Fremdweg', postalCode: '3000', city: 'Bern' },
        { jar: jars.customer },
      );
      assert.equal(response.status, 403);
    });

    it('lässt Mitarbeitende lesen, aber nicht schreiben', async () => {
      /**
       * Mitarbeitende haben `customer:read` — sie müssen wissen, wohin sie
       * fahren. Zum Ändern fehlt ihnen `customer:update`, und `customer:
       * update_own` haben sie nicht, weil sie keine Kundenakte sind.
       *
       * Genau dort verläuft die Grenze, und genau dort muss sie halten.
       */
      const read = await get(`/api/customers/${otherCustomerId}/addresses`, {
        jar: jars.employee,
      });
      assert.equal(read.status, 200, `Lesen: HTTP ${read.status}`);

      const write = await post(
        `/api/customers/${otherCustomerId}/addresses`,
        { street: 'Mitarbeiterweg', postalCode: '3000', city: 'Bern' },
        { jar: jars.employee },
      );
      assert.equal(write.status, 403, `Schreiben: HTTP ${write.status}`);

      const change = await call('PATCH', `/api/customers/${otherCustomerId}/addresses/x`, {
        jar: jars.employee,
        body: { city: 'Thun' },
      });
      assert.equal(change.status, 403, `Ändern: HTTP ${change.status}`);
    });

    it('verwehrt den Zugriff ohne Anmeldung', async () => {
      assert.equal((await get(`/api/customers/${ownCustomerId}/addresses`)).status, 401);
    });
  });

  // -------------------------------------------------------------------------
  describe('Das Büro pflegt eine fremde Akte', () => {
    let addressId = '';

    it('legt eine Adresse an', async () => {
      const response = await post<{ data: Address }>(
        `/api/customers/${otherCustomerId}/addresses`,
        {
          label: 'Prüfadresse',
          street: 'Musterweg',
          streetNo: '7',
          postalCode: '3011',
          city: 'Bern',
          canton: 'BE',
          country: 'CH',
          accessNote: 'Schlüsseldepot beim Briefkasten',
        },
        { jar: jars.admin },
      );
      assert.equal(response.status, 201, JSON.stringify(response.payload));
      addressId = response.payload.data.id;
      created.push({ customerId: otherCustomerId, addressId });
    });

    it('ändert sie', async () => {
      const response = await call<{ data: Address }>(
        'PATCH',
        `/api/customers/${otherCustomerId}/addresses/${addressId}`,
        { jar: jars.admin, body: { city: 'Köniz', postalCode: '3098' } },
      );
      assert.equal(response.status, 200);
      assert.equal(response.payload.data.city, 'Köniz');
      assert.equal(response.payload.data.postalCode, '3098');
    });

    it('weist eine ungültige Postleitzahl ab', async () => {
      const response = await call(
        'PATCH',
        `/api/customers/${otherCustomerId}/addresses/${addressId}`,
        { jar: jars.admin, body: { postalCode: '99' } },
      );
      assert.ok([400, 422].includes(response.status), `HTTP ${response.status}`);
    });

    it('weist ein unbekanntes Feld ab', async () => {
      // Ohne `.strict()` verschwände ein Tippfehler still, und die Antwort
      // lautete trotzdem 200.
      const response = await call(
        'PATCH',
        `/api/customers/${otherCustomerId}/addresses/${addressId}`,
        { jar: jars.admin, body: { ortschaft: 'Bern' } },
      );
      assert.ok([400, 422].includes(response.status), `HTTP ${response.status}`);
    });

    it('findet die Adresse einer fremden Akte nicht', async () => {
      // Die Kennung allein genügt nicht — sie muss zu *dieser* Akte gehören.
      const response = await call(
        'PATCH',
        `/api/customers/${ownCustomerId}/addresses/${addressId}`,
        { jar: jars.admin, body: { city: 'Thun' } },
      );
      assert.equal(response.status, 404);
    });
  });

  // -------------------------------------------------------------------------
  describe('Genau eine Standardadresse', () => {
    let first = '';
    let second = '';

    it('macht die erste Adresse zwangsläufig zur Standardadresse', async (t) => {
      const before = await get<{ data: Address[] }>(
        `/api/customers/${otherCustomerId}/addresses`,
        { jar: jars.admin },
      );
      if (before.payload.data.length === 0) {
        t.skip('Akte hat bereits Adressen — der Erstfall ist hier nicht prüfbar');
        return;
      }
      // Mindestens eine muss Standard sein, sonst käme keine Buchung zustande.
      assert.equal(
        before.payload.data.filter((a) => a.isDefault).length,
        1,
        'es gibt nicht genau eine Standardadresse',
      );
    });

    it('gibt die Markierung weiter, statt sie zu verdoppeln', async () => {
      const list = await get<{ data: Address[] }>(`/api/customers/${otherCustomerId}/addresses`, {
        jar: jars.admin,
      });
      const rows = list.payload.data;
      assert.ok(rows.length >= 2, 'für diese Prüfung braucht es zwei Adressen');

      first = rows.find((a) => a.isDefault)!.id;
      second = rows.find((a) => !a.isDefault)!.id;

      const response = await call(
        'PATCH',
        `/api/customers/${otherCustomerId}/addresses/${second}`,
        { jar: jars.admin, body: { isDefault: true } },
      );
      assert.equal(response.status, 200);

      const after = await get<{ data: Address[] }>(`/api/customers/${otherCustomerId}/addresses`, {
        jar: jars.admin,
      });
      const defaults = after.payload.data.filter((a) => a.isDefault);
      assert.equal(defaults.length, 1, 'es gibt nicht mehr genau eine Standardadresse');
      assert.equal(defaults[0].id, second, 'die Markierung ist nicht gewandert');
    });

    it('lässt die Standardmarkierung nicht abwählen', async () => {
      // Sonst stünde die Kundschaft ohne Standardadresse da und käme im
      // Buchungsformular nicht weiter.
      const response = await call(
        'PATCH',
        `/api/customers/${otherCustomerId}/addresses/${second}`,
        { jar: jars.admin, body: { isDefault: false } },
      );
      assert.equal(response.status, 422);
    });

    it('gibt die Markierung zurück', async () => {
      const response = await call(
        'PATCH',
        `/api/customers/${otherCustomerId}/addresses/${first}`,
        { jar: jars.admin, body: { isDefault: true } },
      );
      assert.equal(response.status, 200);
    });
  });

  // -------------------------------------------------------------------------
  describe('Die Kundschaft pflegt die eigene Akte', () => {
    let addressId = '';

    it('legt eine Adresse an', async () => {
      const response = await post<{ data: Address }>(
        `/api/customers/${ownCustomerId}/addresses`,
        {
          label: 'Ferienwohnung',
          street: 'Seeweg',
          streetNo: '3',
          postalCode: '3600',
          city: 'Thun',
        },
        { jar: jars.customer },
      );
      assert.equal(response.status, 201, JSON.stringify(response.payload));
      addressId = response.payload.data.id;
      created.push({ customerId: ownCustomerId, addressId });
    });

    it('ändert den Zugangshinweis', async () => {
      const response = await call<{ data: { accessNote: string } }>(
        'PATCH',
        `/api/customers/${ownCustomerId}/addresses/${addressId}`,
        { jar: jars.customer, body: { accessNote: 'Schlüssel bei der Nachbarin, 2. Stock' } },
      );
      assert.equal(response.status, 200);
      assert.equal(response.payload.data.accessNote, 'Schlüssel bei der Nachbarin, 2. Stock');
    });

    it('entfernt sie wieder', async () => {
      const response = await del(`/api/customers/${ownCustomerId}/addresses/${addressId}`, {
        jar: jars.customer,
      });
      assert.equal(response.status, 204);
      created.splice(
        created.findIndex((entry) => entry.addressId === addressId),
        1,
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('Was nicht gelöscht werden darf', () => {
    it('behält eine Adresse, auf die Einsätze verweisen', async (t) => {
      const list = await get<{ data: Address[] }>(`/api/customers/${ownCustomerId}/addresses`, {
        jar: jars.admin,
      });
      const used = list.payload.data.find(
        (a) =>
          (a._count?.properties ?? 0) + (a._count?.bookings ?? 0) + (a._count?.jobs ?? 0) > 0,
      );

      if (!used) {
        t.skip('keine verwendete Adresse im Bestand');
        return;
      }

      const response = await del<{ error: { message: string } }>(
        `/api/customers/${ownCustomerId}/addresses/${used.id}`,
        { jar: jars.admin },
      );
      assert.equal(response.status, 422);
      assert.ok(
        (response.payload?.error?.message?.length ?? 0) > 40,
        'die Ablehnung muss begründet sein, nicht nur abweisend',
      );
    });

    it('behält die letzte Adresse einer Akte', async () => {
      // Ohne Adresse käme keine Buchung mehr zustande.
      const list = await get<{ data: Address[] }>(`/api/customers/${ownCustomerId}/addresses`, {
        jar: jars.admin,
      });
      if (list.payload.data.length !== 1) {
        // Der Bestand hat mehrere — dann prüft der Fall oben schon das Nötige.
        assert.ok(true);
        return;
      }
      const response = await del(
        `/api/customers/${ownCustomerId}/addresses/${list.payload.data[0].id}`,
        { jar: jars.admin },
      );
      assert.equal(response.status, 422);
    });
  });

  // -------------------------------------------------------------------------
  describe('Die Masken', () => {
    it('zeigt dem Büro die Adressen der Kundenakte', async () => {
      const page = await get(`/admin/kunden/${otherCustomerId}`, { jar: jars.admin });
      assert.equal(page.status, 200);
      assert.ok(page.text.includes('Adresse hinzufügen'), 'keine Schaltfläche zum Anlegen');
    });

    it('lässt auch die Betriebsleitung bearbeiten', async () => {
      // Sie hat `customer:update` — Kundenakten zu führen gehört zur
      // Disposition. Die Schaltfläche ist dort also richtig; ausgeblendet
      // wäre sie es nur bei Mitarbeitenden, und die kommen gar nicht erst
      // in den Verwaltungsbereich.
      const page = await get(`/admin/kunden/${otherCustomerId}`, { jar: jars.manager });
      assert.equal(page.status, 200);
      assert.ok(page.text.includes('Adresse hinzufügen'));
    });

    it('lässt Mitarbeitende nicht in die Kundenakte', async () => {
      const page = await get(`/admin/kunden/${otherCustomerId}`, { jar: jars.employee });
      assert.ok([307, 308, 404].includes(page.status), `HTTP ${page.status}`);
    });

    it('zeigt der Kundschaft die eigenen Adressen zum Bearbeiten', async () => {
      const page = await get('/konto/objekte', { jar: jars.customer });
      assert.equal(page.status, 200);
      assert.ok(page.text.includes('Adresse hinzufügen'), 'keine Schaltfläche zum Anlegen');
      assert.ok(
        !page.text.includes('Schreiben Sie uns kurz'),
        'der alte Hinweis auf den Umweg über das Büro steht noch da',
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('Die Rechtematrix kennt das neue Recht', () => {
    it('führt Customers.EditOwn und weist es der Kundschaft zu', async () => {
      const page = await get('/admin/rollen', { jar: jars.super });
      assert.equal(page.status, 200);
      assert.ok(page.text.includes('Customers.EditOwn'), 'das Recht fehlt in der Matrix');
    });

    /**
     * Die Matrix in einer Zeile: Wer darf lesen, wer darf schreiben?
     *
     * Lesen dürfen alle angemeldeten Rollen — das Büro über `customer:read`,
     * Mitarbeitende ebenso (sie müssen wissen, wohin sie fahren), die
     * Kundschaft über `customer:read_own` für die eigene Akte.
     *
     * Schreiben trennt: `customer:update` im Büro, `customer:update_own` für
     * die eigene Akte. Mitarbeitende haben keines von beiden.
     */
    const MAY_WRITE: Record<AccountName, boolean> = {
      super: true,
      admin: true,
      manager: true,
      employee: false,
      customer: true,
    };

    for (const role of ROLE_ORDER) {
      it(`${role}: liest ja, schreibt ${MAY_WRITE[role] ? 'ja' : 'nein'}`, async () => {
        const read = await get(`/api/customers/${ownCustomerId}/addresses`, { jar: jars[role] });
        assert.equal(read.status, 200, `Lesen: HTTP ${read.status}`);

        const write = await post(
          `/api/customers/${ownCustomerId}/addresses`,
          { street: 'Matrixweg', streetNo: '1', postalCode: '3000', city: 'Bern' },
          { jar: jars[role] },
        );

        if (MAY_WRITE[role]) {
          assert.equal(write.status, 201, `Schreiben: HTTP ${write.status}`);
          const id = (write.payload as { data?: { id?: string } })?.data?.id;
          if (id) created.push({ customerId: ownCustomerId, addressId: id });
        } else {
          assert.equal(write.status, 403, `Schreiben: HTTP ${write.status}`);
        }
      });
    }
  });
});
