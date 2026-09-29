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
    '/admin/vertraege',
    '/admin/vertraege/neu',
    '/admin/qualitaet',
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
    '/admin/ausgaben?bereich=lieferanten',
    '/admin/papierkorb',
    '/admin/auswertungen',
    '/admin/auswertungen/website',
    '/admin/auswertungen/website?zeitraum=eigen&von=2026-01-01&bis=2026-03-31',
    '/admin/auswertungen/website?zeitraum=unsinn',
    '/admin/personal',
    // Ziel der Meldung „Neuer Abwesenheitsantrag" (2026-09-28; vorher
    // `/admin/personal/abwesenheiten`, eine 404).
    '/admin/personal?reiter=abwesenheiten',
    '/admin/personal/neu',
    '/admin/personal/bewerbungen',
    '/admin/lohn',
    '/admin/lohn?jahr=2021&monat=3',
    '/admin/besichtigungen',
    '/admin/suche',
    '/admin/suche?q=Reinigung',
    '/admin/kommunikation',
    '/admin/kommunikation?kanal=sms',
    '/admin/reklamationen',
    '/admin/reklamationen?alle=1',
    '/admin/material',
    '/admin/material?nachbestellen=1',
    '/admin/geraete',
    '/admin/geraete?faellig=1',
    '/admin/marketing',
    '/admin/blog',
    '/admin/bewertungen',
    '/admin/ki',
    '/admin/einstellungen',
    '/admin/einstellungen/leistungen',
    '/admin/einstellungen/gebiet',
    '/admin/profil',
    '/admin/profil/einstellungen',
    '/admin/cta',
    '/admin/medien',
    '/admin/website',
    '/admin/inhalte',
    '/admin/seo',
    '/admin/fuehrung',
    '/admin/fuehrung/kennzahlen',
    '/admin/fuehrung/ziele',
    '/admin/fuehrung/ziele?ansicht=kanban',
    '/admin/fuehrung/ziele/neu',
    '/admin/fuehrung/ziele/roadmap',
    '/admin/fuehrung/budget',
    '/admin/fuehrung/investitionen',
    '/admin/fuehrung/szenarien',
    '/admin/fuehrung/risiken',
    '/admin/fuehrung/qualitaet',
    '/admin/fuehrung/massnahmen',
    '/admin/fuehrung/dokumente',
    '/admin/fuehrung/wissen',
    '/admin/fuehrung/markt',
    '/admin/fuehrung/markt/analyse/neu',
    '/admin/fuehrung/sitzungen',
    '/admin/fuehrung/sitzungen/neu',
    '/admin/fuehrung/berichte',
    '/admin/fuehrung/assistent',
  ],
  employee: [
    '/portal',
    '/portal/einsaetze',
    '/portal/einsaetze?alle=1',
    '/portal/kalender',
    '/portal/zeiterfassung',
    '/portal/abwesenheiten',
    '/portal/lohn',
    '/portal/profil',
    '/portal/profil/einstellungen',
    '/portal/ziele',
    '/portal/wissen',
    // Eigene Aufgaben (2026-09-28) — Ziel der Aufgabenmeldungen an Mitarbeitende.
    '/portal/aufgaben',
  ],
  customer: [
    '/konto',
    '/konto/buchungen',
    '/konto/offerten',
    '/konto/rechnungen',
    '/konto/objekte',
    '/konto/nachrichten',
    '/konto/bewertungen',
    // Ziel der Bewertungsbitte (2026-09-28; vorher `/konto/bewertungen/neu`,
    // eine 404). Eine unbekannte Buchung wählt nichts vor, die Seite steht.
    '/konto/bewertungen?buchung=gibt-es-nicht',
    '/konto/reklamationen',
    // Verträge und Qualitätskontrollen (L-18, 2026-09-28).
    '/konto/vertraege',
    '/konto/qualitaet',
    '/konto/profil',
    '/konto/profil/einstellungen',
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

    const [customerId, leadId, invoiceId, quoteId, employeeId, kpiId, objectiveId, budgetId, investmentId, scenarioId, riskId, controlId, documentId, meetingId, boardId] = await Promise.all([
      firstId('/api/customers'),
      firstId('/api/leads'),
      firstId('/api/invoices'),
      firstId('/api/quotes'),
      firstId('/api/employees'),
      firstId('/api/bi/kpis'),
      firstId('/api/bi/objectives'),
      firstId('/api/bi/budgets'),
      firstId('/api/bi/investments'),
      firstId('/api/bi/scenarios'),
      firstId('/api/bi/risks'),
      firstId('/api/bi/controls'),
      firstId('/api/bi/documents'),
      firstId('/api/bi/meetings'),
      firstId('/api/bi/analysis'),
    ]);

    /*
      Die Qualitätskontrolle hat im Demobestand nicht zwangsläufig einen
      Datensatz. `firstId` gibt dann `null`, und die Schleife unten
      überspringt den Fall — genau wie bei jedem anderen Bereich ohne Daten.
    */
    const inspectionId = await firstId('/api/quality-inspections');

    /**
     * Verträge liefern eine Hülle (`{ gesamt, contracts }`) statt einer nackten
     * Liste — die Seite braucht die Gesamtzahl für die Blätterung. `firstId`
     * passt deshalb nicht, und ein Sonderfall dort wäre ein Sonderfall für
     * alle. Hier reicht ein eigener Griff.
     */
    const contractId = await (async () => {
      const antwort = await get<{ data: { contracts: { id: string }[] } }>('/api/contracts', {
        jar: jars.admin,
      });
      return antwort.payload?.data?.contracts?.[0]?.id ?? null;
    })();

    const targets: [string, string | null][] = [
      ['/admin/vertraege', contractId],
      ['/admin/kunden', customerId],
      ['/admin/leads', leadId],
      ['/admin/rechnungen', invoiceId],
      ['/admin/offerten', quoteId],
      ['/admin/personal', employeeId],
      ['/admin/fuehrung/kennzahlen', kpiId],
      ['/admin/fuehrung/ziele', objectiveId],
      ['/admin/fuehrung/budget', budgetId],
      ['/admin/fuehrung/investitionen', investmentId],
      ['/admin/fuehrung/szenarien', scenarioId],
      ['/admin/fuehrung/risiken', riskId],
      ['/admin/fuehrung/qualitaet', controlId],
      ['/admin/fuehrung/dokumente', documentId],
      ['/admin/fuehrung/sitzungen', meetingId],
      ['/admin/fuehrung/markt/analyse', boardId],
      ['/admin/qualitaet', inspectionId],
    ];

    /**
     * Die Etikettseite der Scanplattform (2026-09-26): für das Büro erreichbar,
     * für Mitarbeitende ohne Lagerrecht nicht vorhanden (404, reine
     * Bearbeitungsmaske). Sie erzeugt beim Aufrufen keinen Code.
     */
    it('/admin/etikett/:art/:id', async () => {
      // Ein Einsatz, weil der Demobestand kein Material kennt; die Seite ist
      // für alle vier Arten dieselbe.
      const jobId = await firstId('/api/jobs?pageSize=1');
      assert.ok(jobId, 'kein Einsatz im Demobestand');
      const buero = await get(`/admin/etikett/JOB/${jobId}`, { jar: jars.admin });
      assert.equal(buero.status, 200, `HTTP ${buero.status}`);
      assert.equal((await get(`/admin/etikett/JOB/${jobId}`, { jar: jars.manager })).status, 200);
      assert.equal((await get(`/admin/etikett/UNBEKANNT/${jobId}`, { jar: jars.admin })).status, 404);
      assert.equal((await get('/admin/etikett/JOB/gibt-es-nicht', { jar: jars.admin })).status, 404);
    });

    for (const [prefix, id] of targets) {
      it(`${prefix}/:id`, async () => {
        assert.ok(id, `keine Beispiel-ID für ${prefix} — Datenbank befüllt?`);
        const response = await get(`${prefix}/${id}`, { jar: jars.admin });
        assert.ok(response.status >= 200 && response.status < 400, `HTTP ${response.status}`);
      });
    }

    /**
     * Die interne Offertansicht der Kundschaft (Gate 2.5) — mit einer
     * *eigenen* Offerte, nicht mit der ersten aus der Verwaltungssicht: Die
     * Seite ist auf Eigentümerschaft gebaut, und die erste Offerte der
     * Verwaltung gehört nicht zwingend dem Demokundenkonto.
     */
    it('/konto/offerten/:id', async () => {
      const eigene = await get<{ data: { id: string }[] }>('/api/quotes?pageSize=1', { jar: jars.customer });
      const id = eigene.payload?.data?.[0]?.id ?? null;
      if (!id) return;
      const response = await get(`/konto/offerten/${id}`, { jar: jars.customer });
      assert.ok(response.status >= 200 && response.status < 400, `HTTP ${response.status}`);
      assert.ok(response.text.includes('data-pdf-viewer-mount'), 'Dokumentansicht fehlt');
    });

    /**
     * Die Vertragsseite der Kundschaft (L-18) — mit einem *eigenen* Vertrag,
     * aus demselben Grund wie bei der Offerte. Die Schnittstelle liefert der
     * Kundschaft auch interne Zustände, die Seite zeigt nur die zugegangenen;
     * deshalb wird hier nach Zustand gewählt. Ohne eigenen Vertrag im
     * Demobestand entfällt der Fall — die Eigentumsprüfung legt sich ihren
     * Vertrag selbst an (`ownership.test.ts`).
     */
    it('/konto/vertraege/:id', async () => {
      const eigene = await get<{ data: { contracts: { id: string; status: string }[] } }>('/api/contracts', {
        jar: jars.customer,
      });
      const sichtbar = ['OFFERED', 'ACTIVE', 'PAUSED', 'NOTICE_GIVEN', 'ENDED'];
      const id = eigene.payload?.data?.contracts?.find((c) => sichtbar.includes(c.status))?.id ?? null;
      if (!id) return;
      const response = await get(`/konto/vertraege/${id}`, { jar: jars.customer });
      assert.equal(response.status, 200, `HTTP ${response.status}`);
    });

    /**
     * Die Abrechnungsliste liefert eine Hülle (`{ eintraege, summe… }`), und
     * der Demobestand hat nicht zwingend eine Abrechnung — ohne Beispiel wird
     * der Fall übersprungen, wie bei der Offertansicht der Kundschaft.
     */
    it('/admin/lohn/:id', async () => {
      const liste = await get<{ data: { eintraege: { id: string }[] } }>('/api/payroll/payslips', { jar: jars.admin });
      const id = liste.payload?.data?.eintraege?.[0]?.id ?? null;
      if (!id) return;
      const response = await get(`/admin/lohn/${id}`, { jar: jars.admin });
      assert.ok(response.status >= 200 && response.status < 400, `HTTP ${response.status}`);
    });

    it('/admin/offerten/:id/bearbeiten', async () => {
      assert.ok(quoteId);
      const response = await get(`/admin/offerten/${quoteId}/bearbeiten`, { jar: jars.admin });
      assert.ok(response.status >= 200 && response.status < 400, `HTTP ${response.status}`);
    });

    it('/admin/leads/:id/bearbeiten', async () => {
      assert.ok(leadId);
      const response = await get(`/admin/leads/${leadId}/bearbeiten`, { jar: jars.admin });
      assert.ok(response.status >= 200 && response.status < 400, `HTTP ${response.status}`);
      assert.ok(response.text.includes('Änderungen speichern'), 'Bearbeitungsmaske fehlt');
    });

    /*
     * Audit Oberfläche 2026-09-28 — tote Links, leere Menüs und Abschnitte,
     * die eine Rolle nicht lesen darf. Jede Prüfung scheitert gegen den
     * alten Stand.
     */
    it('L-03: ?reiter=abwesenheiten öffnet den Reiter der offenen Anträge', async () => {
      const response = await get('/admin/personal?reiter=abwesenheiten', { jar: jars.admin });
      assert.equal(response.status, 200);
      const reiter = response.text.match(/<button[^>]*id="[^"]*trigger-abwesenheiten"[^>]*>/)?.[0] ?? '';
      assert.ok(reiter, 'Reiter „Abwesenheiten" fehlt');
      assert.ok(reiter.includes('aria-selected="true"'), 'Reiter „Abwesenheiten" ist nicht gewählt');
      // Und die Meldung zeigt nicht mehr auf die nie vorhandene Seite.
      assert.notEqual((await get('/admin/personal/abwesenheiten', { jar: jars.admin })).status, 200);
    });

    it('L-17: Bewerbungen sind von der Personalliste aus erreichbar', async () => {
      const response = await get('/admin/personal', { jar: jars.admin });
      assert.ok(response.text.includes('href="/admin/personal/bewerbungen"'), 'kein Weg zu den Bewerbungen');
    });

    it('L-13: bezahlte Rechnung ohne leeres Menü „Weitere Aktionen"', async () => {
      const paid = await get<{ data: { id: string }[] }>('/api/invoices?status=PAID&pageSize=1', { jar: jars.admin });
      const id = paid.payload?.data?.[0]?.id;
      if (!id) return;
      const response = await get(`/admin/rechnungen/${id}`, { jar: jars.admin });
      assert.equal(response.status, 200);
      assert.ok(!response.text.includes('aria-label="Weitere Aktionen"'), 'leeres Aktionsmenü auf einer bezahlten Rechnung');
    });

    it('L-14: die Betriebsleitung sieht in der Personalakte keinen Dokumentabschnitt', async () => {
      assert.ok(employeeId);
      const leitung = await get(`/admin/personal/${employeeId}`, { jar: jars.manager });
      assert.equal(leitung.status, 200);
      assert.ok(!leitung.text.includes('Noch keine Dokumente abgelegt'), 'falsche Leeraussage für die Betriebsleitung');
      assert.ok(!/Dokumente \(/.test(leitung.text.replace(/<!-- -->/g, '')), 'Dokumentabschnitt ohne document:read');
      const verwaltung = await get(`/admin/personal/${employeeId}`, { jar: jars.admin });
      assert.ok(/Dokumente \(/.test(verwaltung.text.replace(/<!-- -->/g, '')), 'Gegenprobe: Abschnitt fehlt der Administration');
    });

    it('L-16: „Termin buchen" in der Kundenakte ohne toten Parameter', async () => {
      assert.ok(customerId);
      const response = await get(`/admin/kunden/${customerId}`, { jar: jars.admin });
      assert.equal(response.status, 200);
      assert.ok(!response.text.includes('/buchen?kunde='), '/buchen wertet ?kunde= nicht aus');
    });

    it('L-04: die Bewertungsbitte im Kundenkonto zeigt auf die vorhandene Seite', async () => {
      const response = await get('/konto', { jar: jars.customer });
      assert.equal(response.status, 200);
      assert.ok(!response.text.includes('/konto/bewertungen/neu'), 'Link auf die nicht vorhandene Seite /konto/bewertungen/neu');
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
