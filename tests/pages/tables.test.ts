import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { get, requireServer } from '../helpers/client';
import { loginAll, type AccountName } from '../helpers/accounts';
import {
  countMatches,
  dataTableCount,
  hasHorizontalScroller,
  rigidWidths,
  unsafeGridTracks,
} from '../helpers/markup';

/**
 * Flächendeckende Prüfung der Tabellen- und Listenausrichtung.
 *
 * Anlass war eine Meldung, Angaben stünden ausserhalb der Tabelle. Die Antwort
 * darauf muss flächendeckend sein und nicht exemplarisch: Diese Prüfung läuft
 * über *jede* Seite hinter der Anmeldung, in der Rolle, die sie sehen darf.
 *
 * Im ausgelieferten HTML wird gesucht nach
 *  1. der alten Pseudotabelle aus `flex flex-wrap` — sie bricht um, statt in
 *     Spalten zu bleiben,
 *  2. Rasterspuren mit blossem `fr` neben festen Spuren — `1fr` weigert sich,
 *     unter die Breite seines Inhalts zu schrumpfen, und schiebt die Nachbarn
 *     hinaus; `minmax(0,1fr)` darf,
 *  3. Datentabellen ohne waagrecht scrollenden Rahmen,
 *  4. festen Breiten über 320 px — der schmalste Rahmen, den wir bedienen.
 */

interface PageUnderTest {
  path: string;
  role: AccountName;
}

let jars: Record<AccountName, string>;

/** Eine Beispiel-ID beschaffen, damit auch Detailseiten geprüft werden. */
async function firstId(path: string, jar: string): Promise<string | null> {
  const response = await get<{ data: { id: string }[] }>(path, { jar });
  if (response.status !== 200) return null;
  return response.payload?.data?.[0]?.id ?? null;
}

async function collectPages(): Promise<PageUnderTest[]> {
  const admin = jars.admin;

  const [customerId, invoiceId, quoteId, bookingId, leadId, employeeId, jobId] = await Promise.all([
    firstId('/api/customers?perPage=1', admin),
    firstId('/api/invoices?perPage=1', admin),
    firstId('/api/quotes?perPage=1', admin),
    firstId('/api/bookings?perPage=1', admin),
    firstId('/api/leads?perPage=1', admin),
    firstId('/api/employees?perPage=1', admin),
    firstId('/api/jobs?perPage=1', admin),
  ]);

  const pages: (PageUnderTest | null)[] = [
    // Verwaltung
    ...[
      '/admin',
      '/admin/buchungen',
      '/admin/einsaetze',
      '/admin/kunden',
      '/admin/kunden/neu',
      '/admin/rechnungen',
      '/admin/rechnungen/neu',
      '/admin/offerten',
      '/admin/offerten/neu',
      '/admin/leads',
      '/admin/leads/neu',
      '/admin/personal',
      '/admin/personal/neu',
      '/admin/personal/bewerbungen',
      '/admin/ki',
      '/admin/aufgaben',
      '/admin/zahlungen',
      '/admin/objekte',
      '/admin/profil',
      '/admin/nachrichten',
      '/admin/ausgaben',
      '/admin/bewertungen',
      '/admin/blog',
      '/admin/einstellungen',
      '/admin/einstellungen/gebiet',
      '/admin/einstellungen/leistungen',
      '/admin/kalender',
      '/admin/marketing',
      '/admin/inhalte',
      '/admin/seo',
      '/admin/auswertungen',
      '/admin/cta',
      '/admin/medien',
      '/admin/website',
      '/admin/benutzer',
    ].map((path) => ({ path, role: 'admin' as const })),

    // Detailseiten — sie tragen die dichtesten Tabellen.
    customerId ? { path: `/admin/kunden/${customerId}`, role: 'admin' as const } : null,
    invoiceId ? { path: `/admin/rechnungen/${invoiceId}`, role: 'admin' as const } : null,
    quoteId ? { path: `/admin/offerten/${quoteId}`, role: 'admin' as const } : null,
    quoteId ? { path: `/admin/offerten/${quoteId}/bearbeiten`, role: 'admin' as const } : null,
    bookingId ? { path: `/admin/buchungen/${bookingId}`, role: 'admin' as const } : null,
    leadId ? { path: `/admin/leads/${leadId}`, role: 'admin' as const } : null,
    employeeId ? { path: `/admin/personal/${employeeId}`, role: 'admin' as const } : null,
    jobId ? { path: `/admin/einsaetze/${jobId}`, role: 'admin' as const } : null,

    // Mitarbeitendenportal
    ...[
      '/portal',
      '/portal/abwesenheiten',
      '/portal/einsaetze',
      '/portal/kalender',
      '/portal/lohn',
      '/portal/profil',
      '/portal/zeiterfassung',
    ].map((path) => ({ path, role: 'employee' as const })),

    // Kundenkonto
    ...[
      '/konto',
      '/konto/rechnungen',
      '/konto/offerten',
      '/konto/objekte',
      '/konto/buchungen',
      '/konto/nachrichten',
      '/konto/profil',
      '/konto/bewertungen',
    ].map((path) => ({ path, role: 'customer' as const })),
  ];

  return pages.filter((page): page is PageUnderTest => page !== null);
}

describe('Tabellen und Listen laufen nicht über', { concurrency: 1 }, async () => {
  await requireServer();
  jars = await loginAll();
  const pages = await collectPages();

  let tablesSeen = 0;

  for (const { path, role } of pages) {
    it(`${path} (${role})`, async () => {
      const response = await get(path, { jar: jars[role] });

      // Eine Route, die es nicht gibt, ist nicht Gegenstand dieser Prüfung.
      if (response.status === 404) return;
      assert.equal(response.status, 200, `HTTP ${response.status}`);

      const html = response.text;
      const problems: string[] = [];

      const legacy = countMatches(html, /flex flex-wrap items-center gap-4 p-\d/);
      if (legacy) problems.push(`${legacy}× umbrechende Pseudotabelle`);

      const tracks = unsafeGridTracks(html);
      if (tracks.length) problems.push(`Spur ohne minmax(0,…): ${tracks.join(' ')}`);

      const tables = dataTableCount(html);
      tablesSeen += tables;
      if (tables > 0 && !hasHorizontalScroller(html)) {
        problems.push(`${tables} Tabelle(n) ohne waagrechten Scrollbereich`);
      }

      const widths = rigidWidths(html);
      if (widths.length) problems.push(`starre Breite: ${widths.join(' ')}`);

      assert.deepEqual(problems, [], problems.join('; '));
    });
  }

  it(`liefert insgesamt Datentabellen aus (${pages.length} Seiten geprüft)`, () => {
    // Eine Absicherung gegen die stille Variante des Fehlschlags: Wären alle
    // Seiten leer, bestünde jede Prüfung oben — und geprüft wäre nichts.
    assert.ok(tablesSeen > 10, `nur ${tablesSeen} Tabellen gefunden — sind die Seiten leer?`);
  });
});
