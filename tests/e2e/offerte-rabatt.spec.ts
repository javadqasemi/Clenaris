import type { Page } from '@playwright/test';

import { data, del, get } from '../helpers/client';
import { test, expect } from './helpers/basis';
import { imBrowserAnmelden, konsoleUeberwachen } from './helpers/browser';
import { frischAnmelden, offerteAnlegen, stammdatenLesen } from './helpers/bestand';

/**
 * Offerte bearbeiten → Gesamtrabatt → „Art" wechseln → speichern.
 *
 * Gemeldeter Fehler (2026-09-28): Nach dem Öffnen der Auswahl „Art des
 * Rabatts" verschwanden Seitenleiste und Kopfzeile, und die Änderung liess
 * sich teilweise nicht speichern. Zwei getrennte Ursachen, beide hier belegt:
 *
 *  1. **Die Navigation.** Radix sperrt beim Öffnen einer Auswahl das Scrollen
 *     mit `overflow: hidden` am `<body>`. `globals.css` setzt aber
 *     `html { overflow-x: clip }` — und sobald `<html>` selbst ein `overflow`
 *     trägt, reicht der Browser das des `<body>` nicht mehr an das Fenster
 *     weiter. Der `<body>` wird zum eigenen Scrollrahmen, und die klebende
 *     Seitenleiste und Kopfzeile kleben an *ihm* statt am Fenster. Wer —
 *     wie beim Gesamtrabatt am Formularende — hinuntergescrollt hat, sieht sie
 *     dann schlicht nicht mehr. Deshalb prüft dieser Fall **nach dem Scrollen**
 *     und **bei geöffneter Auswahl**, ob beide noch im Fenster liegen: ganz
 *     oben geöffnet, fiele der Fehler nicht auf.
 *  2. **Das Speichern.** „Kein Rabatt" wurde im Formular zu `undefined`, das
 *     `JSON.stringify` weglässt; der Server behielt darauf die alte Rabattart.
 *     Der Fall wechselt deshalb auch zurück auf „Kein Rabatt" und prüft nach
 *     dem Neuladen, dass der Rabatt wirklich weg ist.
 */

async function navigationImFenster(page: Page): Promise<{ seitenleiste: boolean; kopfzeile: boolean }> {
  return page.evaluate(() => {
    const imFenster = (el: Element | null) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      // Sichtbar heisst: mit einem Teil im Fenster und nicht ohne Ausdehnung.
      return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight;
    };
    return {
      seitenleiste: imFenster(document.querySelector('aside')),
      kopfzeile: imFenster(document.querySelector('header.sticky')),
    };
  });
}

async function artWaehlen(page: Page, bezeichnung: 'Kein Rabatt' | 'Prozentual' | 'Fixbetrag') {
  const ausloeser = page.getByRole('combobox', { name: 'Art' });
  await ausloeser.scrollIntoViewIfNeeded();
  // Ans Formularende gescrollt, wie beim echten Bearbeiten — genau dort trat es auf.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await ausloeser.click();
  await expect(page.getByRole('listbox')).toBeVisible();

  // Die Zusicherung bei **geöffneter** Auswahl: Hier war die Navigation weg.
  expect(await navigationImFenster(page), 'Seitenleiste und Kopfzeile bei geöffneter Auswahl').toEqual({
    seitenleiste: true,
    kopfzeile: true,
  });

  await page.getByRole('option', { name: bezeichnung, exact: true }).click();
  await expect(page.getByRole('listbox')).toBeHidden();
  await expect(ausloeser).toContainText(bezeichnung);
  expect(await navigationImFenster(page), 'Seitenleiste und Kopfzeile nach der Auswahl').toEqual({
    seitenleiste: true,
    kopfzeile: true,
  });
}

interface OfferteDetail {
  discountType: 'PERCENT' | 'FIXED' | null;
  discountValue: number | string;
  discountAmount: number | string;
}

test.describe('Offerte: Gesamtrabatt bearbeiten', () => {
  let offerteId = '';
  let jar = '';

  test.beforeEach(async () => {
    jar = await frischAnmelden('admin');
    const { customerId } = await stammdatenLesen(jar);
    offerteId = (await offerteAnlegen(jar, customerId)).id;
  });

  test.afterEach(async () => {
    if (offerteId) await del(`/api/quotes/${offerteId}`, { jar });
  });

  test('Prozentual, Fixbetrag und zurück auf „Kein Rabatt": Navigation bleibt, Wert wird gespeichert', async ({ page }) => {
    const konsole = konsoleUeberwachen(page);
    // Kleines Fenster in Desktopbreite: Die Seitenleiste ist ab `lg` sichtbar,
    // und das Formular muss länger als das Fenster sein, damit gescrollt wird.
    await page.setViewportSize({ width: 1280, height: 720 });
    await imBrowserAnmelden(page, 'admin', /\/admin/);

    const lesen = async () =>
      data(await get<{ data: OfferteDetail }>(`/api/quotes/${offerteId}`, { jar }));

    for (const [art, wert, erwartet] of [
      ['Prozentual', '10', { discountType: 'PERCENT', betrag: 38.4 }],
      ['Fixbetrag', '50', { discountType: 'FIXED', betrag: 50 }],
      ['Kein Rabatt', null, { discountType: null, betrag: 0 }],
    ] as const) {
      await page.goto(`/admin/offerten/${offerteId}/bearbeiten`);
      await expect(page.getByRole('heading', { name: 'Gesamtrabatt' })).toBeVisible();

      await artWaehlen(page, art);
      const wertFeld = page.getByRole('textbox', { name: 'Wert' });
      if (wert !== null) {
        await wertFeld.fill(wert);
        // Formularzustand bleibt: Die Auswahl ist nach der Eingabe noch da.
        await expect(page.getByRole('combobox', { name: 'Art' })).toContainText(art);
      } else {
        await expect(wertFeld).toBeDisabled();
      }

      await page.getByRole('button', { name: 'Änderungen speichern' }).click();
      await page.waitForURL(new RegExp(`/admin/offerten/${offerteId}$`));

      const gespeichert = await lesen();
      expect(gespeichert.discountType, `Rabattart nach „${art}"`).toBe(erwartet.discountType);
      expect(Number(gespeichert.discountAmount), `Rabattbetrag nach „${art}"`).toBe(erwartet.betrag);

      // Neu laden: Die Bearbeitungsmaske zeigt den gespeicherten Wert.
      await page.goto(`/admin/offerten/${offerteId}/bearbeiten`);
      await expect(page.getByRole('combobox', { name: 'Art' })).toContainText(art);
    }

    konsole.keineFehler();
  });
});
