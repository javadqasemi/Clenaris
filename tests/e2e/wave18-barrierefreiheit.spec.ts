import { pruefe, zeile } from './helpers/axe';
import { expect, test } from './helpers/basis';
import { imBrowserAnmelden } from './helpers/browser';

/**
 * Wave 18 — Barrierefreiheit, gemessen mit axe-core im echten Browser.
 *
 * ---------------------------------------------------------------------------
 *  Was geprüft wird — und was nicht
 * ---------------------------------------------------------------------------
 *
 * axe prüft die maschinell prüfbaren Regeln von WCAG 2.1 A/AA auf der
 * gerenderten Seite: Beschriftungen von Feldern und Schaltflächen,
 * Alternativtexte, Überschriftenfolge, Sprachattribut, ARIA-Rollen und
 * -Attribute, Kontraste. Das ist ein Teil der Barrierefreiheit, nicht die
 * ganze: Tastaturbedienung im Ablauf, Verständlichkeit, Fokusführung in
 * Dialogen und Screenreader-Erlebnis prüft keine Maschine. Die Reihe beweist
 * deshalb keine Konformität — sie verhindert Rückschritte bei dem, was sich
 * messen lässt.
 *
 * **Schwelle:** Verstösse der Stufe „critical" und „serious" lassen den Fall
 * scheitern. „moderate" und „minor" werden als Anhang festgehalten.
 */

// Messung und Beruhigung liegen seit 2026-09-27 in `helpers/axe.ts` (geteilt
// mit der Oberflächenprüfung); die Begründung des Wartens steht dort.

const OEFFENTLICH = ['/', '/auth/anmelden', '/kontakt', '/offerte'];

test.describe('Barrierefreiheit (axe, WCAG 2.1 A/AA)', () => {
  test('öffentliche Seiten', async ({ page }, testInfo) => {
    const befunde: string[] = [];
    for (const pfad of OEFFENTLICH) {
      // Ohne Entscheidung erscheint das Cookie-Banner auf jeder Seite des
      // `(public)`-Rahmens — nicht auf der Anmeldung, die hat einen eigenen.
      const { schwer } = await pruefe(page, pfad, testInfo, !pfad.startsWith('/auth/'));
      for (const v of schwer) befunde.push(zeile(pfad, v));
    }
    expect(befunde, befunde.join('\n')).toEqual([]);
  });

  test('Verwaltung', async ({ page }, testInfo) => {
    await imBrowserAnmelden(page, 'admin', /\/admin/);
    const befunde: string[] = [];
    for (const pfad of ['/admin', '/admin/rechnungen', '/admin/lohn', '/admin/suche?q=Reinigung', '/admin/reklamationen', '/admin/besichtigungen']) {
      const { schwer } = await pruefe(page, pfad, testInfo);
      for (const v of schwer) befunde.push(zeile(pfad, v));
    }
    expect(befunde, befunde.join('\n')).toEqual([]);
  });

  test('Portal und Kundenbereich', async ({ page, browser }, testInfo) => {
    await imBrowserAnmelden(page, 'employee', /\/portal/);
    const befunde: string[] = [];
    for (const pfad of ['/portal', '/portal/lohn']) {
      const { schwer } = await pruefe(page, pfad, testInfo);
      for (const v of schwer) befunde.push(zeile(pfad, v));
    }
    const kunde = await browser.newContext();
    const kundenSeite = await kunde.newPage();
    await imBrowserAnmelden(kundenSeite, 'customer', /\/konto/);
    for (const pfad of ['/konto', '/konto/reklamationen']) {
      const { schwer } = await pruefe(kundenSeite, pfad, testInfo);
      for (const v of schwer) befunde.push(zeile(pfad, v));
    }
    await kunde.close();
    expect(befunde, befunde.join('\n')).toEqual([]);
  });
});
