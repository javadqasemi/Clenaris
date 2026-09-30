import { createHash } from 'node:crypto';

import { eigeneOrganisationId, testDb } from '../helpers/testdb';
import { test, expect } from './helpers/basis';
import { imBrowserAnmelden, konsoleUeberwachen } from './helpers/browser';

/**
 * Auswertung der Website-Besuche im Browser (2026-09-29).
 *
 * Erfassung und Endpunkte prüfen `traffic.test.ts` und
 * `besuchsmessung.browser.spec.ts` (auch: ein gesperrter Messendpunkt bricht
 * die Website nicht). Hier die Seite der Betriebsleitung: Sie zeigt, was im
 * Zeitraum gemessen wurde, der Zeitraum lässt sich wählen, ein leerer
 * Zeitraum hat einen Leerzustand statt einer leeren Tabelle, Mitarbeitende
 * kommen nicht hinein — und nirgends steht eine IP-Adresse oder eine
 * Abfrage mit Token.
 *
 * Die Zeilen legt der Fall selbst an, in einem festen, vergangenen Zeitraum
 * mit eigenen Pfaden: Der Demobestand misst nichts, und andere Prüfungen
 * schreiben in die Gegenwart.
 */

const LAUF = Date.now().toString(36);
const PFAD_A = `/pruef-auswertung-${LAUF}-a`;
const PFAD_B = `/pruef-auswertung-${LAUF}-b`;
const TAGE = ['2025-02-10', '2025-02-11', '2025-02-12'];
const sitzung = (n: number) => createHash('sha256').update(`pruef-${LAUF}-${n}`).digest('hex');

async function aufraeumen() {
  await testDb()?.trafficEvent.deleteMany({ where: { path: { in: [PFAD_A, PFAD_B] } } });
}

test.describe('Website-Besuche: Auswertung', () => {
  test.beforeAll(async () => {
    const db = testDb();
    const org = await eigeneOrganisationId();
    if (!db || !org) throw new Error('Keine Testdatenbank.');
    await aufraeumen();
    const zeile = (tag: string, n: number, pfad: string, eventName: 'PAGE_VIEW' | 'CONTACT_FORM', landing: boolean) => ({
      organizationId: org,
      occurredAt: new Date(`${tag}T09:00:00Z`),
      day: new Date(`${tag}T00:00:00Z`),
      path: pfad,
      eventName,
      sessionHash: sitzung(n),
      landing,
      referrerHost: landing ? 'www.example.org' : null,
      utmCampaign: landing ? 'pruefkampagne' : null,
      device: 'DESKTOP' as const,
      browser: 'FIREFOX' as const,
    });
    await db.trafficEvent.createMany({
      data: [
        zeile(TAGE[0]!, 1, PFAD_A, 'PAGE_VIEW', true),
        zeile(TAGE[0]!, 1, PFAD_B, 'PAGE_VIEW', false),
        zeile(TAGE[1]!, 2, PFAD_A, 'PAGE_VIEW', true),
        zeile(TAGE[2]!, 3, PFAD_A, 'PAGE_VIEW', true),
        zeile(TAGE[2]!, 3, PFAD_A, 'CONTACT_FORM', false),
      ],
    });
  });
  test.afterAll(aufraeumen);

  test('zeigt den gewählten Zeitraum, wechselt Zeiträume, hat einen Leerzustand — ohne IP und ohne Abfrage', async ({ page }) => {
    const konsole = konsoleUeberwachen(page);
    const seite = `/admin/auswertungen/website?zeitraum=eigen&von=${TAGE[0]}&bis=${TAGE[2]}`;
    await imBrowserAnmelden(page, 'admin', /\/admin/, seite);
    await page.waitForURL(/zeitraum=eigen/);

    await expect(page.getByRole('heading', { level: 1, name: 'Website-Besuche' })).toBeVisible();
    const inhalt = page.getByRole('main');
    await expect(inhalt.getByText(PFAD_A).first()).toBeVisible();
    await expect(inhalt.getByText(PFAD_B).first()).toBeVisible();
    // 4 Seitenansichten, 3 Sitzungen, 1 Sitzung mit Kontaktformular.
    await expect(inhalt.getByText('Seitenansichten').first()).toBeVisible();
    await expect(inhalt).toContainText('www.example.org');
    await expect(inhalt).toContainText('pruefkampagne');

    const text = (await inhalt.innerText()) ?? '';
    expect(text, 'eine IP-Adresse steht in der Auswertung').not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
    expect(text, 'eine Abfrage mit Token steht in der Auswertung').not.toMatch(/[?&](token|key|sig)=/i);

    // Zeitraumwahl: ein fester Zeitraum wird aktiv.
    const zeitraeume = page.getByRole('navigation', { name: 'Zeitraum' });
    await zeitraeume.getByRole('link').first().click();
    await expect(zeitraeume.locator('[aria-current="page"]')).toHaveCount(1);
    await expect(inhalt.getByText(PFAD_A)).toHaveCount(0);

    // Eigener Zeitraum ohne Besuche: Leerzustand mit Ausweg, keine leere Tabelle.
    await page.goto('/admin/auswertungen/website?zeitraum=eigen&von=2025-03-01&bis=2025-03-03');
    await expect(page.getByText('Keine Besuche in diesem Zeitraum')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Laufendes Jahr anzeigen' })).toBeVisible();

    konsole.keineFehler();
  });

  test('Mitarbeitende kommen nicht in die Auswertung', async ({ page }) => {
    await imBrowserAnmelden(page, 'employee', /\/portal/);
    await page.goto('/admin/auswertungen/website');
    expect(new URL(page.url()).pathname).not.toBe('/admin/auswertungen/website');
    await expect(page.getByRole('heading', { name: 'Website-Besuche' })).toHaveCount(0);
  });
});
