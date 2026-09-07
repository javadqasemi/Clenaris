import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { get, requireServer } from '../helpers/client';
import { loginAll, type AccountName } from '../helpers/accounts';

/**
 * Rauchtest: Antwortet jede Seite und jeder Endpunkt, den eine Rolle sehen darf?
 *
 * Die flachste aller Prüfungen und trotzdem die, die am häufigsten etwas
 * findet. Ein fehlender Prisma-Join, eine `undefined` in einer Server
 * Component, ein Feld, das nach einer Migration nicht mehr existiert — all das
 * zeigt sich als 500, lange bevor jemand die Seite von Hand öffnet.
 *
 * Erwartet wird 2xx oder 3xx. Eine Umleitung ist in Ordnung: Sie bedeutet, die
 * Anwendung hat eine Meinung. Ein 4xx oder 5xx bedeutet, sie ist gestolpert.
 */

const PAGES: Record<'admin' | 'employee' | 'customer', string[]> = {
  admin: [
    '/admin',
    '/admin/kalender',
    '/admin/buchungen',
    '/admin/einsaetze',
    '/admin/offerten',
    '/admin/offerten/neu',
    '/admin/leads',
    '/admin/leads/neu',
    '/admin/kunden',
    '/admin/kunden/neu',
    '/admin/nachrichten',
    '/admin/objekte',
    '/admin/aufgaben',
    '/admin/rechnungen',
    '/admin/rechnungen/neu',
    '/admin/zahlungen',
    '/admin/ausgaben',
    '/admin/auswertungen',
    '/admin/personal',
    '/admin/personal/neu',
    '/admin/personal/bewerbungen',
    '/admin/marketing',
    '/admin/blog',
    '/admin/bewertungen',
    '/admin/ki',
    '/admin/einstellungen',
    '/admin/einstellungen/leistungen',
    '/admin/einstellungen/gebiet',
    '/admin/profil',
    '/admin/cta',
    '/admin/medien',
    '/admin/website',
    '/admin/inhalte',
    '/admin/seo',
  ],
  employee: [
    '/portal',
    '/portal/einsaetze',
    '/portal/kalender',
    '/portal/zeiterfassung',
    '/portal/abwesenheiten',
    '/portal/lohn',
    '/portal/profil',
  ],
  customer: [
    '/konto',
    '/konto/buchungen',
    '/konto/offerten',
    '/konto/rechnungen',
    '/konto/objekte',
    '/konto/nachrichten',
    '/konto/bewertungen',
    '/konto/profil',
  ],
};

const window = () => {
  const from = new Date(Date.now() - 30 * 864e5).toISOString();
  const to = new Date(Date.now() + 30 * 864e5).toISOString();
  return `from=${from}&to=${to}`;
};

const APIS: Record<'admin' | 'employee' | 'customer', string[]> = {
  admin: [
    '/api/customers',
    '/api/leads',
    '/api/invoices',
    '/api/employees',
    '/api/quotes',
    '/api/tasks',
    '/api/expenses',
    '/api/messages',
    '/api/notifications',
    '/api/notifications/count',
    `/api/jobs/calendar?${window()}`,
  ],
  employee: ['/api/notifications/count', `/api/jobs/calendar?${window()}`],
  customer: ['/api/messages', '/api/reviews', '/api/notifications/count'],
};

describe('Rauchtest', { concurrency: 1 }, async () => {
  await requireServer();
  const jars = await loginAll();

  for (const role of ['admin', 'employee', 'customer'] as const) {
    describe(role, () => {
      for (const path of [...PAGES[role], ...APIS[role]]) {
        it(path, async () => {
          const response = await get(path, { jar: jars[role as AccountName] });
          assert.ok(
            response.status >= 200 && response.status < 400,
            `HTTP ${response.status}`,
          );
        });
      }
    });
  }

  describe('Detailseiten und Dokumente', async () => {
    const firstId = async (path: string) => {
      const response = await get<{ data: { id: string }[] }>(path, { jar: jars.admin });
      return response.payload?.data?.[0]?.id ?? null;
    };

    const [customerId, leadId, invoiceId, quoteId, employeeId] = await Promise.all([
      firstId('/api/customers'),
      firstId('/api/leads'),
      firstId('/api/invoices'),
      firstId('/api/quotes'),
      firstId('/api/employees'),
    ]);

    const targets: [string, string | null][] = [
      ['/admin/kunden', customerId],
      ['/admin/leads', leadId],
      ['/admin/rechnungen', invoiceId],
      ['/admin/offerten', quoteId],
      ['/admin/personal', employeeId],
    ];

    for (const [prefix, id] of targets) {
      it(`${prefix}/:id`, async () => {
        assert.ok(id, `keine Beispiel-ID für ${prefix} — Datenbank befüllt?`);
        const response = await get(`${prefix}/${id}`, { jar: jars.admin });
        assert.ok(response.status >= 200 && response.status < 400, `HTTP ${response.status}`);
      });
    }

    it('/admin/offerten/:id/bearbeiten', async () => {
      assert.ok(quoteId);
      const response = await get(`/admin/offerten/${quoteId}/bearbeiten`, { jar: jars.admin });
      assert.ok(response.status >= 200 && response.status < 400, `HTTP ${response.status}`);
    });

    // Die PDF-Erzeugung ist der Weg, der am ehesten stillschweigend bricht:
    // Sie läuft in einem eigenen Pfad, den keine Seite berührt.
    it('erzeugt ein Offerten-PDF', async () => {
      assert.ok(quoteId);
      const response = await get(`/api/quotes/${quoteId}/pdf`, { jar: jars.admin });
      assert.equal(response.status, 200);
    });

    it('erzeugt ein Rechnungs-PDF', async () => {
      assert.ok(invoiceId);
      const response = await get(`/api/invoices/${invoiceId}/pdf`, { jar: jars.admin });
      assert.equal(response.status, 200);
    });
  });
});
