import type { Response } from '@playwright/test';

import { ACCOUNTS } from '../helpers/accounts';
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
  /*
    Geschützte Abfragen, die *nach* dem Beginn der Abmeldung hinausgehen
    (2026-10-01). Die Stressreihe der Härtung fing im Leerlauffall eine
    Glockenabfrage, die 15 ms nach dem Abmelde-POST begann und mit 401
    zurückkam. Seither sperrt `lib/api/client.ts` neue geschützte Aufrufe
    während der Abmeldung; die zurückgehaltene Abfrage oben begann *vorher*
    und zählt hier nicht. Gegen den alten Stand fängt die Liste die nächste
    Glockenabfrage, sobald ihr Takt in die Abmeldung fällt.
  */
  let abmeldungBegonnen = false;
  const nachDerAbmeldung: string[] = [];
  page.on('request', (anfrage) => {
    const pfad = new URL(anfrage.url()).pathname;
    if (pfad.startsWith('/api/auth/refresh')) erneuerungen.push(anfrage.url());
    if (pfad === '/api/auth/logout') abmeldungBegonnen = true;
    else if (abmeldungBegonnen && pfad.startsWith('/api/') && !pfad.startsWith('/api/auth/') && !pfad.startsWith('/api/public/')) {
      nachDerAbmeldung.push(`${anfrage.method()} ${pfad}`);
    }
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
  expect(nachDerAbmeldung, 'nach Beginn der Abmeldung ging noch eine geschützte Abfrage hinaus').toEqual([]);

  /**
   * Die eigene Route abbauen, bevor der Rahmen den Kontext schliesst (RC-21,
   * 2026-10-01).
   *
   * Was diesen Fall von den übrigen unterscheidet, ist die **Art** des
   * Wartens, nicht das Warten selbst. Auch andere Fälle halten Rückrufe
   * zurück — `bilder.browser.spec.ts`, `preisrechner.browser.spec.ts`,
   * `produktsprint-2026-09-26.spec.ts` und `vor-hydration.browser.spec.ts`
   * —, aber mit einer festen Uhr von 1,5 bis 2,5 Sekunden, die von selbst
   * abläuft. Nur hier wartet der Rückruf auf eine Zusage, die der Fall
   * selbst freigibt (`abgemeldet`), also ohne eigene Grenze. Eine frühere
   * Fassung dieses Kommentars nannte den Fall „den einzigen, der einen
   * Rückruf warten lässt"; das war falsch, und die Folgerung daraus — die
   * Hygiene brauche es nur hier — trägt nicht. Tritt RC-21 in einem der
   * vier anderen Fälle auf, gilt dieselbe Massnahme dort; vorbeugend
   * angefasst sind sie nicht, weil es für sie keinen Befund gibt.
   *
   * Nach der Abmeldung kann noch ein Rückruf laufen — der freigegebene
   * `route.continue()` oder eine späte Abfrage der Glocke —, und er liefe
   * dann gegen einen Kontext, der gerade geschlossen wird. Die Meldung aus
   * dem roten Stresslauf (RC-20-Reihe, Befund RC-21) trug den Zusatz „while
   * running route callback" nicht; ein Rückruf ist also nicht als Ursache
   * belegt. `behavior: 'wait'` räumt ihn trotzdem weg: laufende Rückrufe zu
   * Ende führen, keine neuen mehr annehmen. Hängen kann das nicht — der
   * einzige Rückruf, der wartet, wartet auf `abgemeldet`, und das ist oben
   * längst freigegeben. Alle Zusicherungen stehen oben und bleiben
   * unverändert; hier wird nichts wiederholt und nichts gefiltert.
   */
  await page.unrouteAll({ behavior: 'wait' });
});

/**
 * Während der Abmeldung geht keine neue geschützte Abfrage hinaus (2026-10-01).
 *
 * Der Befund aus der Stressreihe der Härtung, deterministisch nachgestellt:
 * Die Glocke fragt alle 30 Sekunden (`refetchInterval` in `app-shell.tsx`).
 * Die Abmelde-Antwort wird zurückgehalten, und währenddessen läuft die Uhr
 * des Browsers 35 Sekunden vor — der Takt der Glocke fällt also sicher in die
 * laufende Abmeldung. Gegen den alten Stand geht genau dann eine neue
 * Glockenabfrage hinaus (und kommt nach der Abmeldung mit 401 zurück); jetzt
 * sperrt `lib/api/client.ts` sie, ohne das Netz zu berühren.
 */
test('während der Abmeldung geht keine neue geschützte Abfrage hinaus', async ({ context, page }) => {
  await context.clock.install();
  await imBrowserAnmelden(page, 'admin', /\/admin/);
  await page.waitForResponse((r) => new URL(r.url()).pathname === '/api/notifications/count');

  let freigeben!: () => void;
  const zurueckgehalten = new Promise<void>((auf) => (freigeben = auf));
  let abmeldungGesehen = false;
  await page.route('**/api/auth/logout', async (route) => {
    abmeldungGesehen = true;
    await zurueckgehalten;
    await route.continue();
  });
  const nachDerAbmeldung: string[] = [];
  page.on('request', (anfrage) => {
    const pfad = new URL(anfrage.url()).pathname;
    if (abmeldungGesehen && pfad.startsWith('/api/') && !pfad.startsWith('/api/auth/') && !pfad.startsWith('/api/public/')) {
      nachDerAbmeldung.push(`${anfrage.method()} ${pfad}`);
    }
  });

  await page.getByRole('button', { name: 'Konto-Menü öffnen' }).click();
  await page.getByRole('menuitem', { name: 'Abmelden' }).click();
  await expect.poll(() => abmeldungGesehen, { message: 'die Abmeldung ging nie hinaus' }).toBe(true);

  // Der Takt der Glocke läuft in die zurückgehaltene Abmeldung hinein.
  await context.clock.runFor(35_000);
  freigeben();
  await page.waitForURL((adresse) => adresse.pathname === '/');

  expect(nachDerAbmeldung, 'während der Abmeldung ging eine geschützte Abfrage hinaus').toEqual([]);
  await page.unrouteAll({ behavior: 'wait' });
});

/**
 * Abmelden und im selben Tab neu anmelden (2026-10-01).
 *
 * Die Abmeldemarke in `lib/api/client.ts` galt bis dahin „für immer": Die
 * Abmeldung über das Profilmenü navigiert clientseitig auf die Startseite,
 * die Anmeldemaske ebenso zurück in die Verwaltung — das Modul bleibt also
 * geladen, und die alte Marke unterdrückte in der neuen Sitzung jede stille
 * Erneuerung und überhörte die Abmeldung anderer Tabs. Seit geschützte
 * Abfragen während der Abmeldung gar nicht mehr hinausgehen, wäre daraus ein
 * sichtbarer Fehler geworden: keine einzige Abfrage der neuen Sitzung.
 * `SessionKeepalive` setzt die Marke beim Einhängen zurück.
 *
 * Die Marke `__ohneNeuladen` beweist, dass wirklich derselbe JavaScript-
 * Kontext weiterläuft. Lädt die Seite irgendwo neu, wäre das Modul frisch und
 * der Fall bewiese nichts — dann scheitert er ausdrücklich daran, statt still
 * grün zu sein. Gegen einen Stand ohne Zurücksetzen bleibt die Glocke nach
 * der neuen Anmeldung stumm, und `waitForResponse` läuft ab.
 */
test('nach Abmelden und neuer Anmeldung im selben Tab laufen geschützte Abfragen wieder', async ({ page }) => {
  type Fenster = Window & { __ohneNeuladen?: boolean };
  await imBrowserAnmelden(page, 'admin', /\/admin/);

  const abmeldung = page.waitForResponse((r) => r.url().includes('/api/auth/logout'));
  await page.getByRole('button', { name: 'Konto-Menü öffnen' }).click();
  await page.getByRole('menuitem', { name: 'Abmelden' }).click();
  expect((await abmeldung).status()).toBe(200);
  await page.waitForURL((adresse) => adresse.pathname === '/');
  await page.evaluate(() => {
    (window as Fenster).__ohneNeuladen = true;
  });

  // Clientseitig zur Anmeldung — über den Link der Kopfzeile, nicht `goto`.
  await page.getByRole('link', { name: 'Anmelden', exact: true }).first().click();
  await page.waitForURL(/\/auth\/anmelden/);
  await page.locator('input[type="email"]').fill(ACCOUNTS.admin.email);
  await page.locator('input[autocomplete="current-password"]').fill(ACCOUNTS.admin.password);
  const glocke = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/notifications/count' && r.request().method() === 'GET',
    { timeout: 30_000 },
  );
  await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
  await page.waitForURL(/\/admin/, { timeout: 30_000 });

  expect((await glocke).status(), 'die erste Abfrage der neuen Sitzung').toBe(200);
  expect(
    await page.evaluate(() => (window as Fenster).__ohneNeuladen === true),
    'die Seite wurde neu geladen — der Fall prüfte dann das Zurücksetzen nicht',
  ).toBe(true);
});
