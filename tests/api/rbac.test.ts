import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { call, del, get, post, requireServer } from '../helpers/client';
import { loginAll, ROLE_ORDER, type AccountName } from '../helpers/accounts';

/**
 * Die Rechtematrix — der Kern der Zugriffskontrolle.
 *
 * Für *jede* Rolle wird jeder Schreibweg angefahren und mit der erwarteten
 * Berechtigung verglichen. Ein Endpunkt, der öffnet, was er nicht öffnen darf,
 * fällt hier auf — und ebenso einer, der einer berechtigten Rolle die Tür
 * verschliesst. Die zweite Richtung ist die, die man sonst vergisst.
 *
 * Geprüft wird nur die **Tür**, nicht ob der Vorgang fachlich durchgeht: Ein
 * 422 („Feld fehlt") zählt als durchgelassen. Sonst müsste jeder Testkörper
 * fachlich vollständig sein, und die Matrix zerfiele in fünfzig Einzelfälle.
 */

type RoleExpectation = Record<AccountName, boolean>;

interface MatrixEntry {
  name: string;
  method: string;
  path: string;
  body?: unknown;
  expect: RoleExpectation;
}

/** Kurzschreibweisen für die häufigen Muster. */
const ADMIN_ONLY: RoleExpectation = {
  super: true,
  admin: true,
  manager: false,
  employee: false,
  customer: false,
};
const SUPER_ONLY: RoleExpectation = {
  super: true,
  admin: false,
  manager: false,
  employee: false,
  customer: false,
};
const WITH_MANAGER: RoleExpectation = {
  super: true,
  admin: true,
  manager: true,
  employee: false,
  customer: false,
};

const MATRIX: MatrixEntry[] = [
  {
    name: 'POST /api/cta — Handlungsaufruf anlegen',
    method: 'POST',
    path: '/api/cta',
    body: { key: 'pruef-matrix', label: 'Prüfung', href: '/offerte', slot: 'FOOTER' },
    expect: ADMIN_ONLY,
  },
  {
    name: 'GET /api/cta — Handlungsaufrufe lesen',
    method: 'GET',
    path: '/api/cta',
    expect: WITH_MANAGER,
  },
  {
    // Einladen darf nur, wer auch Rollen vergibt — sonst wäre die
    // Rollenvergabe über den Umweg einer Einladung zu haben.
    name: 'POST /api/users — Person einladen',
    method: 'POST',
    path: '/api/users',
    body: {
      email: 'pruef.matrix@example.ch',
      firstName: 'Prüf',
      lastName: 'Matrix',
      role: 'EMPLOYEE',
    },
    expect: SUPER_ONLY,
  },
  {
    name: 'GET /api/users — Konten lesen',
    method: 'GET',
    path: '/api/users',
    expect: ADMIN_ONLY,
  },
  {
    name: 'GET /api/media — Mediathek',
    method: 'GET',
    path: '/api/media',
    expect: WITH_MANAGER,
  },
  {
    name: 'POST /api/services — Leistung anlegen',
    method: 'POST',
    path: '/api/services',
    body: {
      name: 'Prüfziel',
      slug: 'x',
      kind: 'SPECIAL',
      shortDesc: 'x'.repeat(12),
      description: 'y'.repeat(40),
      pricingModel: 'FLAT',
      basePrice: 10,
    },
    expect: ADMIN_ONLY,
  },
  {
    name: 'POST /api/price-rules — Preisregel anlegen',
    method: 'POST',
    path: '/api/price-rules',
    body: { name: 'Prüfziel', condition: {}, multiplier: 1.2 },
    expect: ADMIN_ONLY,
  },
  {
    name: 'POST /api/leads — Anfrage erfassen',
    method: 'POST',
    path: '/api/leads',
    body: { firstName: 'A', lastName: 'B', email: 'a.b@example.ch', source: 'PHONE' },
    expect: WITH_MANAGER,
  },
];

let jars: Record<AccountName, string>;

/** Was hier entsteht, wird am Ende wieder entfernt. */
const created: { path: string; id: string }[] = [];

const DENIED = [401, 403];

describe('Rechtematrix', { concurrency: 1 }, () => {
  before(async () => {
    await requireServer();
    jars = await loginAll();
  });

  for (const entry of MATRIX) {
    describe(entry.name, () => {
      for (const role of ROLE_ORDER) {
        const allowed = entry.expect[role];
        it(`${role}: ${allowed ? 'darf' : 'darf nicht'}`, async () => {
          const response = await call(entry.method, entry.path, {
            jar: jars[role],
            body: entry.body,
          });

          if (allowed) {
            assert.ok(
              !DENIED.includes(response.status),
              `${role} sollte durchkommen, bekam HTTP ${response.status}`,
            );
          } else {
            assert.ok(
              DENIED.includes(response.status),
              `${role} sollte abgewiesen werden, bekam HTTP ${response.status}`,
            );
          }

          const id = (response.payload as { data?: { id?: string } })?.data?.id;
          if (allowed && response.status === 201 && id) {
            created.push({ path: entry.path, id });
          }
        });
      }
    });
  }

  it('räumt auf, was die Matrix angelegt hat', async () => {
    for (const { path, id } of created) {
      await del(`${path}/${id}`, { jar: jars.super });
      await del(`${path}/${id}?endgueltig=1`, { jar: jars.super });
    }
    assert.ok(true);
  });
});

// ---------------------------------------------------------------------------

describe('Handlungsaufrufe: voller Rundlauf', { concurrency: 1 }, () => {
  let ctaId = '';

  before(async () => {
    await requireServer();
    jars ??= await loginAll();
  });

  it('legt einen Aufruf an', async () => {
    const create = await post<{ data: { id: string } }>(
      '/api/cta',
      {
        key: 'pruef-cta',
        label: 'Prüfung CTA',
        href: '/offerte',
        slot: 'SECTION_BANNER',
        style: 'PRIMARY',
        icon: 'ArrowRight',
        pages: ['/preise'],
        active: false,
      },
      { jar: jars.admin },
    );
    assert.equal(create.status, 201);
    ctaId = create.payload.data.id;
  });

  it('weist einen doppelten Kurznamen ab', async () => {
    const dupe = await post(
      '/api/cta',
      { key: 'pruef-cta', label: 'Zweiter', href: '/offerte', slot: 'FOOTER' },
      { jar: jars.admin },
    );
    assert.equal(dupe.status, 409);
  });

  /**
   * Das Ziel eines Handlungsaufrufs kommt aus der Datenbank und landet
   * ungefiltert in einem `href`. Genau dort sitzt die Lücke, wenn die Prüfung
   * fehlt: `javascript:` führt Code aus, `data:` liefert eine eigene Seite,
   * und `//evil.example` ist trotz führendem Schrägstrich *kein* interner Pfad.
   */
  describe('Sicherheit des Ziels', () => {
    const FORBIDDEN: [string, string][] = [
      ['javascript:alert(1)', 'javascript:'],
      ['data:text/html,<script>x</script>', 'data:'],
      ['http://unsicher.example', 'http:// statt https'],
      ['//evil.example', 'protokollrelativ'],
    ];

    for (const [href, label] of FORBIDDEN) {
      it(`weist ${label} ab`, async () => {
        const response = await post(
          '/api/cta',
          { key: randomKey(), label: 'Prüfziel', href, slot: 'FOOTER' },
          { jar: jars.admin },
        );
        assert.ok([400, 422].includes(response.status), `durchgelassen mit HTTP ${response.status}`);
      });
    }

    const ALLOWED: [string, string][] = [
      ['/offerte', 'interner Pfad'],
      ['https://wa.me/41791234567', 'https'],
      ['tel:+41311234567', 'tel'],
      ['mailto:info@clenaris.ch', 'mailto'],
    ];

    for (const [href, label] of ALLOWED) {
      it(`nimmt ${label} an`, async () => {
        const response = await post<{ data: { id: string } }>(
          '/api/cta',
          { key: randomKey(), label: 'Prüfziel', href, slot: 'FOOTER' },
          { jar: jars.admin },
        );
        assert.equal(response.status, 201);

        const id = response.payload.data.id;
        await del(`/api/cta/${id}`, { jar: jars.admin });
        await del(`/api/cta/${id}?endgueltig=1`, { jar: jars.admin });
      });
    }
  });

  describe('Eigene Farben', () => {
    it('verlangt zur Hintergrund- auch eine Schriftfarbe', async () => {
      // Sonst entsteht eine Schaltfläche, die niemand lesen kann.
      const response = await post(
        '/api/cta',
        {
          key: randomKey(),
          label: 'Prüfziel',
          href: '/offerte',
          slot: 'FOOTER',
          style: 'CUSTOM',
          bgColor: '#123456',
        },
        { jar: jars.admin },
      );
      assert.ok([400, 422].includes(response.status));
    });

    it('nimmt keine Farbe als freien Text', async () => {
      // Der Wert landet in einem `style`-Attribut; freier Text wäre eine
      // offene Tür für alles, was CSS sonst noch kann.
      const response = await post(
        '/api/cta',
        {
          key: randomKey(),
          label: 'Prüfziel',
          href: '/offerte',
          slot: 'FOOTER',
          style: 'CUSTOM',
          bgColor: 'red; background:url(x)',
          fgColor: '#fff',
        },
        { jar: jars.admin },
      );
      assert.ok([400, 422].includes(response.status));
    });
  });

  describe('Veröffentlichen und Papierkorb', () => {
    it('zeigt den Aufruf nach dem Veröffentlichen nur auf der zugewiesenen Seite', async () => {
      const publish = await post(`/api/cta/${ctaId}/publish`, { active: true }, { jar: jars.admin });
      assert.equal(publish.status, 200);

      const preise = await get('/preise');
      const home = await get('/');
      assert.ok(preise.text.includes('Prüfung CTA'), 'fehlt auf /preise');
      assert.ok(!home.text.includes('Prüfung CTA'), 'steht fälschlich auf der Startseite');
    });

    it('lässt ihn nach dem Abschalten wieder verschwinden', async () => {
      const off = await post(`/api/cta/${ctaId}/publish`, { active: false }, { jar: jars.admin });
      assert.equal(off.status, 200);

      const preise = await get('/preise');
      assert.ok(!preise.text.includes('Prüfung CTA'));
    });

    it('löscht nicht endgültig, was nicht im Papierkorb liegt', async () => {
      const early = await del(`/api/cta/${ctaId}?endgueltig=1`, { jar: jars.admin });
      assert.equal(early.status, 422);
    });

    it('legt in den Papierkorb und stellt abgeschaltet wieder her', async () => {
      const soft = await del(`/api/cta/${ctaId}`, { jar: jars.admin });
      assert.equal(soft.status, 204);

      const restored = await post<{ data: { active: boolean } }>(
        `/api/cta/${ctaId}/restore`,
        undefined,
        { jar: jars.admin },
      );
      assert.equal(restored.status, 200);
      assert.equal(
        restored.payload.data.active,
        false,
        'Wiederhergestelltes darf nicht sofort wieder auf der Website stehen',
      );
    });

    it('löscht aus dem Papierkorb endgültig', async () => {
      await del(`/api/cta/${ctaId}`, { jar: jars.admin });
      const purge = await del(`/api/cta/${ctaId}?endgueltig=1`, { jar: jars.admin });
      assert.equal(purge.status, 204);
    });
  });
});

// ---------------------------------------------------------------------------

describe('Papierkorb: die Fachregeln halten', { concurrency: 1 }, () => {
  before(async () => {
    await requireServer();
    jars ??= await loginAll();
  });

  it('löscht keine ausgestellte Rechnung', async () => {
    // Art. 957a OR verlangt eine lückenlose Nummernfolge; eine ausgestellte
    // Rechnung wird storniert, nicht gelöscht.
    const invoices = await get<{ data: { id: string; number: string; status: string }[] }>(
      '/api/invoices?pageSize=50',
      { jar: jars.admin },
    );
    const issued = invoices.payload.data.find((invoice) => invoice.status !== 'DRAFT');
    assert.ok(issued, 'keine ausgestellte Rechnung im Bestand — Datenbank befüllt?');

    const response = await del<{ error: { message: string } }>(`/api/invoices/${issued.id}`, {
      jar: jars.admin,
    });
    assert.equal(response.status, 422);
    assert.ok(
      (response.payload?.error?.message?.length ?? 0) > 40,
      'die Ablehnung muss begründet sein, nicht nur abweisend',
    );
  });

  it('löscht einen Rechnungsentwurf und stellt ihn wieder her', async () => {
    // Der Entwurf wird eigens angelegt statt im Bestand gesucht. Ein Test, der
    // auf zufällig vorhandene Daten baut, meldet irgendwann „nicht gefunden"
    // und hat dann nichts geprüft — ohne dass jemand merkt, dass die Prüfung
    // seither ausfällt.
    const customers = await get<{ data: { id: string }[] }>('/api/customers?perPage=1', {
      jar: jars.admin,
    });
    const customerId = customers.payload.data[0]?.id;
    assert.ok(customerId, 'keine Kundschaft im Bestand');

    const draft = await post<{ data: { id: string; status: string } }>(
      '/api/invoices',
      {
        customerId,
        items: [{ name: 'Prüfposition', quantity: 1, unitPrice: 100, unit: 'Pauschal' }],
        issueImmediately: false,
      },
      { jar: jars.admin },
    );
    assert.equal(draft.status, 201, JSON.stringify(draft.payload));
    assert.equal(draft.payload.data.status, 'DRAFT');
    const id = draft.payload.data.id;

    assert.equal((await del(`/api/invoices/${id}`, { jar: jars.admin })).status, 204);
    assert.equal(
      (await post(`/api/invoices/${id}/restore`, undefined, { jar: jars.admin })).status,
      200,
    );

    // Wieder wegräumen — ein Entwurf darf endgültig gelöscht werden, er trägt
    // noch keine Nummer und reisst deshalb keine Lücke in die Folge.
    await del(`/api/invoices/${id}`, { jar: jars.admin });
    await del(`/api/invoices/${id}?endgueltig=1`, { jar: jars.admin });
  });

  it('begründet, warum Kundschaft mit offenen Posten bleibt', async () => {
    const customers = await get<{ data: { id: string }[] }>('/api/customers?pageSize=50', {
      jar: jars.admin,
    });
    const first = customers.payload.data[0];
    assert.ok(first, 'keine Kundschaft im Bestand');

    const response = await del<{ error: { message: string } }>(`/api/customers/${first.id}`, {
      jar: jars.admin,
    });
    assert.ok(
      response.status === 204 ||
        (response.status === 422 && (response.payload?.error?.message?.length ?? 0) > 40),
      `unbegründete Antwort: HTTP ${response.status}`,
    );
    if (response.status === 204) {
      await post(`/api/customers/${first.id}/restore`, undefined, { jar: jars.admin });
    }
  });
});

// ---------------------------------------------------------------------------

describe('Selbstschutz der Rechteverwaltung', { concurrency: 1 }, () => {
  let selfId = '';
  let otherId = '';

  before(async () => {
    await requireServer();
    jars ??= await loginAll();

    const users = await get<{ data: { id: string; email: string }[] }>('/api/users', {
      jar: jars.super,
    });
    selfId = users.payload.data.find((u) => u.email === 'system@clenaris.ch')?.id ?? '';
    otherId = users.payload.data.find((u) => u.email === 'admin@clenaris.ch')?.id ?? '';
    assert.ok(selfId && otherId, 'Prüfkonten nicht gefunden');
  });

  it('lässt niemanden die eigene Rolle herabsetzen', async () => {
    // Sonst nimmt sich die letzte Systemverantwortung mit einem Klick die
    // Rechte, die sie zum Zurücknehmen bräuchte.
    const response = await call('PATCH', `/api/users/${selfId}/role`, {
      jar: jars.super,
      body: { role: 'CUSTOMER' },
    });
    assert.equal(response.status, 422);
  });

  it('lässt niemanden das eigene Konto sperren', async () => {
    const response = await call('PATCH', `/api/users/${selfId}`, {
      jar: jars.super,
      body: { status: 'SUSPENDED' },
    });
    assert.equal(response.status, 422);
  });

  it('lässt niemanden das eigene Konto löschen', async () => {
    const response = await del(`/api/users/${selfId}`, { jar: jars.super });
    assert.equal(response.status, 422);
  });

  it('verwehrt der Administration die Rollenvergabe', async () => {
    const response = await call('PATCH', `/api/users/${otherId}/role`, {
      jar: jars.admin,
      body: { role: 'SUPER_ADMIN' },
    });
    assert.equal(response.status, 403);
  });
});

// ---------------------------------------------------------------------------

describe('Seitenschutz und Navigation', { concurrency: 1 }, () => {
  before(async () => {
    await requireServer();
    jars ??= await loginAll();
  });

  /**
   * Erwartet wird 200 oder „nicht da". Ein 403 wäre die schlechtere Antwort:
   * Er verriete die *Existenz* der Seite. Wer sie nicht benutzen darf, muss
   * auch nicht wissen, dass es sie gibt — in der Navigation taucht sie ohnehin
   * nicht auf. Die Anwendung antwortet je nach Fall mit 404 oder leitet um;
   * beides zählt hier als „nicht da".
   */
  const PAGES: [string, Record<AccountName, 200 | 404>][] = [
    ['/admin/cta', { super: 200, admin: 200, manager: 200, employee: 404, customer: 404 }],
    ['/admin/rollen', { super: 200, admin: 200, manager: 404, employee: 404, customer: 404 }],
    ['/admin/benutzer', { super: 200, admin: 200, manager: 404, employee: 404, customer: 404 }],
    ['/admin/protokoll', { super: 200, admin: 404, manager: 404, employee: 404, customer: 404 }],
    ['/admin/medien', { super: 200, admin: 200, manager: 200, employee: 404, customer: 404 }],
  ];

  for (const [path, expectation] of PAGES) {
    describe(path, () => {
      for (const role of ROLE_ORDER) {
        const expected = expectation[role];
        it(`${role}: ${expected === 200 ? 'erreichbar' : 'nicht da'}`, async () => {
          const response = await get(path, { jar: jars[role] });
          const effective = [301, 302, 307, 308].includes(response.status) ? 404 : response.status;
          assert.equal(effective, expected, `HTTP ${response.status}`);
        });
      }
    });
  }

  describe('Menüpunkte verschwinden, statt auszugrauen', () => {
    // Ein ausgegrauter Eintrag suggeriert, es fehle nur ein Klick.
    it('verbirgt vor der Betriebsleitung, was sie nicht darf', async () => {
      const html = (await get('/admin', { jar: jars.manager })).text;
      assert.ok(!html.includes('/admin/benutzer'), 'Benutzerkonten sichtbar');
      assert.ok(!html.includes('/admin/protokoll'), 'Prüfprotokoll sichtbar');
      assert.ok(!html.includes('/admin/rollen'), 'Rollen und Rechte sichtbar');
      assert.ok(html.includes('/admin/cta'), 'Handlungsaufrufe fehlen');
    });

    it('zeigt der Administration die Benutzerkonten, aber nicht das Protokoll', async () => {
      const html = (await get('/admin', { jar: jars.admin })).text;
      assert.ok(html.includes('/admin/benutzer'));
      assert.ok(!html.includes('/admin/protokoll'));
    });

    it('zeigt der Systemverantwortung alles', async () => {
      const html = (await get('/admin', { jar: jars.super })).text;
      assert.ok(html.includes('/admin/protokoll'));
      assert.ok(html.includes('/admin/rollen'));
    });
  });
});

const randomKey = () => `pruef-${Math.random().toString(36).slice(2, 8)}`;
