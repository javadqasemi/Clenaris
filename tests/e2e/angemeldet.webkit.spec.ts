import { del } from '../helpers/client';
import { test, expect } from './helpers/basis';
import { imBrowserAnmelden, konsoleUeberwachen } from './helpers/browser';
import { frischAnmelden, offerteAnlegen, stammdatenLesen } from './helpers/bestand';

/**
 * Angemeldete Rauchreihe für WebKit (2026-09-29, Pendenz W-02).
 *
 * Läuft nur im WebKit-Projekt, über die HTTPS-Vorschaltung
 * (`scripts/test-https-vorschaltung.ts`): Playwrights WebKit schickt die
 * `Secure`-Anmeldecookies nicht über `http://127.0.0.1`, und `Secure`
 * abzuschalten kam nicht in Frage. Bewusst **klein**: die Wege, die sich je
 * Engine unterscheiden können — Anmeldung und Sitzung, Seitenleiste,
 * Auswahlfeld mit Scrollsperre, Suche als Combobox, Dialog mit Fokusfalle,
 * Abmelden. Die fachliche Tiefe prüfen Chromium (ganz) und Firefox.
 *
 * Der Scanner läuft hier über die **manuelle Eingabe**: WebKit hat keinen
 * `BarcodeDetector`, genau wie Safari — der Eingabeweg ist dort der
 * eigentliche. Physisches Safari auf iPhone/iPad bleibt externer Nachweis.
 */

test.describe('WebKit angemeldet', () => {
  test('Anmeldung, Übersicht und Seitenleiste', async ({ page }) => {
    const konsole = konsoleUeberwachen(page);
    await imBrowserAnmelden(page, 'admin', /\/admin/);
    expect(new URL(page.url()).protocol, 'die Rauchreihe muss über HTTPS laufen').toBe('https:');
    await expect(page.getByRole('main')).toBeVisible();

    const navigation = page.getByRole('navigation', { name: 'Bereichsnavigation' }).first();
    await navigation.getByRole('link', { name: 'Offerten', exact: true }).click();
    await page.waitForURL(/\/admin\/offerten$/);
    await expect(navigation.locator('a[aria-current="page"]')).toHaveAttribute('href', '/admin/offerten');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    konsole.keineFehler();
  });

  test('Offerte bearbeiten: Rabattauswahl lässt die Navigation stehen und wird gespeichert', async ({ page }) => {
    const konsole = konsoleUeberwachen(page);
    const jar = await frischAnmelden('admin');
    const { customerId } = await stammdatenLesen(jar);
    const offerte = await offerteAnlegen(jar, customerId);
    const maske = `/admin/offerten/${offerte.id}/bearbeiten`;
    try {
      await page.setViewportSize({ width: 1280, height: 720 });
      await imBrowserAnmelden(page, 'admin', new RegExp(`${maske}$`), maske);
      const art = page.getByRole('combobox', { name: 'Art' });
      await art.scrollIntoViewIfNeeded();
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await art.click();
      await expect(page.getByRole('listbox')).toBeVisible();
      const imFenster = await page.evaluate(() => {
        const sichtbar = (el: Element | null) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight;
        };
        return { seitenleiste: sichtbar(document.querySelector('aside')), kopfzeile: sichtbar(document.querySelector('header.sticky')) };
      });
      expect(imFenster, 'Seitenleiste und Kopfzeile bei geöffneter Auswahl').toEqual({ seitenleiste: true, kopfzeile: true });
      await page.getByRole('option', { name: 'Prozentual', exact: true }).click();
      await page.getByRole('textbox', { name: 'Wert' }).fill('10');
      await page.getByRole('button', { name: 'Änderungen speichern' }).click();
      await page.waitForURL(new RegExp(`/admin/offerten/${offerte.id}$`));
      await page.getByRole('link', { name: 'Bearbeiten' }).click();
      await page.waitForURL(new RegExp(`${maske}$`));
      await expect(page.getByRole('combobox', { name: 'Art' })).toContainText('Prozentual');
      konsole.keineFehler();
    } finally {
      await del(`/api/quotes/${offerte.id}`, { jar });
    }
  });

  test('Suche als Combobox, Scanner-Dialog mit manueller Eingabe und Fokusrückgabe', async ({ page }) => {
    const konsole = konsoleUeberwachen(page);
    await imBrowserAnmelden(page, 'admin', /\/admin/);

    const feld = page.getByRole('banner').getByRole('combobox');
    await feld.click();
    await feld.pressSequentially('Rei', { delay: 30 });
    const liste = page.getByRole('listbox', { name: 'Suchergebnisse' });
    await expect(liste.getByRole('option').first()).toBeVisible({ timeout: 10_000 });
    await feld.press('ArrowDown');
    await expect(feld).toHaveAttribute('aria-activedescendant', /option-0$/);
    await feld.press('Escape');
    await expect(liste).toBeHidden();

    const scan = page.getByRole('button', { name: 'Scannen' });
    await scan.click();
    const dialog = page.getByRole('dialog', { name: 'Scannen' });
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate((d) => d.contains(document.activeElement)), 'Fokus nicht im Dialog').toBe(true);
    await dialog.getByLabel('Code eingeben oder einfügen').fill('4006381333931');
    await dialog.getByRole('button', { name: 'Suchen' }).click();
    // Unbekannte EAN: ein Hinweis mit Handlungsvorschlag, keine Änderung.
    await expect(dialog.getByRole('button', { name: /Neuen Artikel erfassen/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(scan).toBeFocused();
    konsole.keineFehler();
  });

  test('Abmelden über das Kontomenü beendet die Sitzung', async ({ page }) => {
    await imBrowserAnmelden(page, 'admin', /\/admin/);
    await page.getByRole('button', { name: 'Konto-Menü öffnen' }).click();
    await page.getByRole('menuitem', { name: 'Abmelden' }).click();
    // Abmelden führt auf die Website (Startseite), nicht auf die Anmeldung.
    await page.waitForURL((url) => url.pathname === '/');
    // Danach führt jede Verwaltungsseite zur Anmeldung zurück — die Sitzung ist weg, nicht nur die Seite gewechselt.
    await page.goto('/admin');
    await page.waitForURL(/\/auth\/anmelden/);
    await expect(page.getByRole('heading', { name: 'Willkommen zurück' })).toBeVisible();
  });
});
