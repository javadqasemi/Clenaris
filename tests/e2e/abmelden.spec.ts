import type { Response } from '@playwright/test';

import { test, expect } from './helpers/basis';
import { anfragenVerfolgen, imBrowserAnmelden } from './helpers/browser';

/**
 * Abmelden mit einer Abfrage unterwegs (2026-09-29).
 *
 * Gefunden im WebKit-Lauf des Release-Kandidaten: Nach „Abmelden" meldete
 * `waitForURL` „Frame load interrupted". Ursache im Produkt, nicht in der
 * Prüfung — eine Abfrage des Rahmens (hier: Zahl der ungelesenen
 * Meldungen), die zur Abmeldung noch lief, bekam 401, versuchte eine
 * Erneuerung und sprang per `goToLogin()` hart zur Anmeldung mit „Sitzung
 * abgelaufen" — im Wettlauf mit dem Sprung auf die Startseite.
 *
 * Der Fall erzwingt den Wettlauf, statt auf ihn zu hoffen: Die erste Abfrage
 * der Glocke wird zurückgehalten, bis die Abmeldung beantwortet ist, und erst
 * dann durchgelassen — sie kommt also sicher mit 401 zurück. Gegen den alten
 * Stand endet die Seite auf `/auth/anmelden?…&grund=abgelaufen` und es geht
 * eine Erneuerung raus; jetzt bleibt sie auf der Startseite, ohne Erneuerung.
 */
test('eine bei der Abmeldung laufende Abfrage schickt nicht zur Anmeldung „abgelaufen"', async ({ page }) => {
  let freigeben!: () => void;
  const abgemeldet = new Promise<void>((auf) => (freigeben = auf));
  let zurueckgehalten = false;
  await page.route('**/api/notifications/count', async (route) => {
    if (zurueckgehalten) return route.continue();
    zurueckgehalten = true;
    await abgemeldet;
    await route.continue();
  });

  await imBrowserAnmelden(page, 'admin', /\/admin/);
  await expect.poll(() => zurueckgehalten, { message: 'die Glocke hat nie abgefragt' }).toBe(true);

  const erneuerungen: string[] = [];
  page.on('request', (anfrage) => {
    if (anfrage.url().includes('/api/auth/refresh')) erneuerungen.push(anfrage.url());
  });
  const verkehr = anfragenVerfolgen(page);

  const abmeldung = page.waitForResponse((r) => r.url().includes('/api/auth/logout'));
  const glocke = page.waitForResponse((r: Response) => r.url().includes('/api/notifications/count'));
  await page.getByRole('button', { name: 'Konto-Menü öffnen' }).click();
  await page.getByRole('menuitem', { name: 'Abmelden' }).click();
  await abmeldung;
  freigeben();
  expect((await glocke).status(), 'die zurückgehaltene Abfrage kam nicht mit 401').toBe(401);

  await verkehr.ruhig();
  const ziel = new URL(page.url());
  expect(ziel.pathname, `nach der Abmeldung auf ${ziel.pathname}${ziel.search}`).toBe('/');
  expect(ziel.search).not.toContain('abgelaufen');
  expect(erneuerungen, 'nach einer gewollten Abmeldung wurde eine Erneuerung versucht').toEqual([]);
});
