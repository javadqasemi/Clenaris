import type { Browser, BrowserContext, Page } from '@playwright/test';

import { testDb } from '../helpers/testdb';
import { test, expect } from './helpers/basis';
import { konsoleUeberwachen } from './helpers/browser';

/**
 * Eigene Besuchsmessung im Browser — in Chromium, Firefox und WebKit
 * (TA-03, 2026-09-28).
 *
 * Die HTTP-Reihe (`tests/api/traffic.test.ts`) prüft, was der Endpunkt
 * annimmt und speichert. Was sie nicht sehen kann, ist die Seite davor: ob der
 * Browser ohne Einwilligung **gar nichts** schickt, ob er nach der
 * Einwilligung wirklich meldet, und ob ein Werbeblocker, der den Endpunkt
 * sperrt, die Website beschädigt. Das sind die Zusagen aus
 * `docs/TRAFFIC_ANALYTICS.md`, und sie gelten je Engine — `sendBeacon`,
 * `pagehide` und `sessionStorage` verhalten sich nicht überall gleich.
 *
 * **Wahrheit ist die Datenbank**, nicht das Netzprotokoll: Beacons zeigt nicht
 * jede Engine Playwright als Anfrage, gespeicherte Zeilen schon.
 *
 * **Ein gewöhnlicher Browser, kein Automat.** Die Erfassung verwirft
 * Automaten (`AUTOMAT` in `lib/traffic/bereinigen.ts`), und kopfloses
 * Chromium meldet sich als `HeadlessChrome`. Ohne Anpassung wäre der Fall
 * „ohne Einwilligung keine Zeile" in Chromium bedeutungslos gewesen — die
 * Zeile fehlte dann wegen des Automatenfilters, nicht wegen der Einwilligung.
 * Jeder Fall läuft deshalb mit der Kennung, die derselbe Browser sichtbar
 * senden würde. Den Automatenfilter selbst prüft die HTTP-Reihe.
 *
 * **Bewegt wird sich wie ein Mensch**: über Links (Client-Navigation) und
 * durch Schliessen des Tabs. Ein `page.goto` mitten in die Vorabladungen von
 * Next bricht diese ab, und Firefox und WebKit melden jeden Abbruch als
 * Konsolenfehler („Failed to fetch RSC payload") — Lärm, den die Prüfung
 * selbst erzeugte.
 */

async function menschlicherKontext(browser: Browser): Promise<BrowserContext> {
  const probe = await browser.newContext();
  const kennung = await (await probe.newPage()).evaluate(() => navigator.userAgent);
  await probe.close();
  const context = await browser.newContext({ userAgent: kennung.replace(/HeadlessChrome/g, 'Chrome'), locale: 'de-CH' });
  await context.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }));
  return context;
}

async function zeilenSeit(seit: Date): Promise<number> {
  return (await testDb()?.trafficEvent.count({ where: { occurredAt: { gte: seit } } })) ?? 0;
}

/** Warten, bis Zeilen ankommen — höchstens `ms`. Gibt die Zahl zurück. */
async function warteAufZeilen(seit: Date, ms: number): Promise<number> {
  const ende = Date.now() + ms;
  let n = 0;
  while (Date.now() < ende) {
    n = await zeilenSeit(seit);
    if (n > 0) return n;
    await new Promise((r) => setTimeout(r, 250));
  }
  return n;
}

async function perLinkZu(page: Page, pfad: string) {
  await page.locator(`footer a[href="${pfad}"]`).first().click();
  await page.waitForURL(new RegExp(`${pfad.replace('/', '\\/')}$`));
}

test.describe('Besuchsmessung und Einwilligung', () => {
  test.beforeEach(async () => {
    if (!testDb()) throw new Error('Keine Testdatenbank.');
  });

  test('ohne Einwilligung und mit „Nur notwendige": keine einzige Zeile', async ({ browser }) => {
    const seit = new Date();
    const context = await menschlicherKontext(browser);
    const page = await context.newPage();
    const konsole = konsoleUeberwachen(page);

    // Ohne jede Entscheidung: Seite und Telefonlink, dann über die Sammelzeit
    // hinaus warten — gesammelt würde auch ohne Seitenwechsel gesendet. Das
    // Banner deckt die Fusszeile bis zur Entscheidung ab; gewechselt wird erst
    // danach, wie es ein Mensch auch täte.
    await page.goto('/?utm_campaign=ohne-einwilligung');
    // Den Wechsel zur Telefon-App unterbinden (in der Blasenphase): Die
    // Erfassung hört in der Einfangphase und sieht den Klick trotzdem. Ohne
    // das blieb in Chromium und Firefox eine Navigation zu `tel:` offen, die
    // nie „geladen" meldet — und jede weitere Navigation wartete auf sie.
    await page.evaluate(() => {
      document.addEventListener('click', (e) => {
        if (e.target instanceof Element && e.target.closest('a[href^="tel:"]')) e.preventDefault();
      });
    });
    await page.locator('footer a[href^="tel:"]').first().dispatchEvent('click');
    await page.waitForTimeout(3_000);
    // Dann ausdrücklich abgelehnt — und weiter über zwei Links.
    await page.getByRole('button', { name: 'Nur notwendige' }).click();
    await perLinkZu(page, '/kontakt');
    await perLinkZu(page, '/ueber-uns');
    konsole.keineFehler();
    await page.close({ runBeforeUnload: true });
    await context.close();

    // Über die Sammelzeit hinaus warten: Auch verzögert darf nichts kommen.
    expect(await warteAufZeilen(seit, 4_000), 'ohne Einwilligung wurde gemessen').toBe(0);
  });

  test('mit Einwilligung „Statistik": gespeichert — Pfad ohne Abfrage, Kampagne getrennt, kein Token', async ({ browser }) => {
    const seit = new Date();
    const context = await menschlicherKontext(browser);
    const page = await context.newPage();
    const konsole = konsoleUeberwachen(page);

    await page.goto('/kontakt?utm_campaign=Mit-Einwilligung&utm_source=Pruefreihe&token=geheim123');
    await page.getByRole('button', { name: 'Einstellungen' }).click();
    // Nicht vorausgewählt — eine Einwilligung ist eine Handlung, kein Vorgabewert.
    const statistik = page.getByRole('switch', { name: 'Statistik-Cookies' });
    await expect(statistik).toHaveAttribute('aria-checked', 'false');
    await statistik.click();
    await expect(statistik).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('button', { name: 'Auswahl speichern' }).click();
    await perLinkZu(page, '/ueber-uns');
    konsole.keineFehler();
    await page.close({ runBeforeUnload: true });
    await context.close();

    expect(await warteAufZeilen(seit, 10_000), 'nach der Einwilligung keine Zeile gespeichert').toBeGreaterThan(0);
    const zeilen = await testDb()!.trafficEvent.findMany({ where: { occurredAt: { gte: seit } } });
    const kontakt = zeilen.find((z) => z.path === '/kontakt');
    expect(kontakt, `keine Seitenansicht von /kontakt: ${zeilen.map((z) => z.path).join(', ')}`).toBeTruthy();
    expect(kontakt!.utmCampaign).toBe('mit-einwilligung');
    expect(kontakt!.utmSource).toBe('pruefreihe');
    for (const z of zeilen) {
      expect(z.path).not.toContain('?');
      expect(JSON.stringify(z)).not.toContain('geheim123');
      expect(z.sessionHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test('ein Werbeblocker sperrt den Endpunkt: keine Seitenfehler, die Seite funktioniert', async ({ browser }) => {
    const context = await menschlicherKontext(browser);
    await context.route('**/api/public/traffic', (route) => route.abort('blockedbyclient'));
    const page = await context.newPage();
    const seitenfehler: string[] = [];
    page.on('pageerror', (e) => seitenfehler.push(e.message));
    await page.goto('/');
    await page.getByRole('button', { name: 'Alle akzeptieren' }).click();
    await perLinkZu(page, '/kontakt');
    await expect(page.locator('h1')).toBeVisible();
    await page.close({ runBeforeUnload: true });
    await context.close();
    // Die abgewiesene Anfrage selbst meldet der Browser als Netzfehler — das
    // ist die Sperre. Ein Seitenfehler (unbehandelte Ausnahme) wäre der Befund.
    expect(seitenfehler).toEqual([]);
  });
});
