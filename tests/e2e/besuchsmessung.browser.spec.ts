import type { Page } from '@playwright/test';

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
 * Wahrheit ist die Datenbank, nicht das Netzprotokoll des Browsers: Beacons
 * zeigt nicht jede Engine Playwright als Anfrage, gespeicherte Zeilen schon.
 * Gesucht wird nach einem eigenen Pfadzeichen (`?utm_campaign=…`), damit
 * fremde Zeilen anderer Fälle nicht mitzählen.
 */

async function zeilenMitKampagne(kampagne: string): Promise<number> {
  return (await testDb()?.trafficEvent.count({ where: { utmCampaign: kampagne } })) ?? 0;
}

/** Warten, bis Zeilen ankommen — höchstens `ms`. Gibt die Zahl zurück. */
async function warteAufZeilen(kampagne: string, ms: number): Promise<number> {
  const ende = Date.now() + ms;
  let n = 0;
  while (Date.now() < ende) {
    n = await zeilenMitKampagne(kampagne);
    if (n > 0) return n;
    await new Promise((r) => setTimeout(r, 250));
  }
  return n;
}

/** Wegnavigieren löst `pagehide` aus — spätestens dann sendet die Erfassung. */
async function verlassen(page: Page) {
  await page.goto('/impressum').catch(() => undefined);
}

test.describe('Besuchsmessung und Einwilligung', () => {
  test.beforeEach(async () => {
    if (!testDb()) throw new Error('Keine Testdatenbank.');
  });

  test('ohne Einwilligung und mit „Nur notwendige": keine einzige Zeile', async ({ page }, testInfo) => {
    const kampagne = `ohne-${testInfo.project.name}-${Date.now()}`;
    const konsole = konsoleUeberwachen(page);
    await page.goto(`/?utm_campaign=${kampagne}`);
    await page.locator('footer a[href^="tel:"], footer a[href^="mailto:"]').first().click({ modifiers: [] }).catch(() => undefined);
    await verlassen(page);
    await page.goto(`/kontakt?utm_campaign=${kampagne}`);
    await page.getByRole('button', { name: 'Nur notwendige' }).click();
    await page.goto(`/leistungen?utm_campaign=${kampagne}`);
    await verlassen(page);
    // Kurz über die Sammelzeit hinaus warten: Auch verzögert darf nichts kommen.
    expect(await warteAufZeilen(kampagne, 4_000), 'ohne Einwilligung wurde gemessen').toBe(0);
    konsole.keineFehler();
  });

  test('mit Einwilligung „Statistik": Seitenansicht gespeichert — Pfad ohne Abfrage, Kampagne getrennt, kein Token', async ({ page }, testInfo) => {
    const kampagne = `mit-${testInfo.project.name}-${Date.now()}`;
    const konsole = konsoleUeberwachen(page);
    await page.goto('/kontakt');
    await page.getByRole('button', { name: 'Einstellungen' }).click();
    // Nicht vorausgewählt — eine Einwilligung ist eine Handlung, kein Vorgabewert.
    const statistik = page.getByRole('switch', { name: 'Statistik-Cookies' });
    await expect(statistik).toHaveAttribute('aria-checked', 'false');
    await statistik.click();
    await expect(statistik).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('button', { name: 'Auswahl speichern' }).click();

    await page.goto(`/kontakt?utm_campaign=${kampagne}&utm_source=Pruefreihe&token=geheim123`);
    await verlassen(page);
    expect(await warteAufZeilen(kampagne, 10_000), 'nach der Einwilligung keine Seitenansicht gespeichert').toBeGreaterThan(0);

    const zeilen = await testDb()!.trafficEvent.findMany({ where: { utmCampaign: kampagne } });
    for (const z of zeilen) {
      expect(z.path).toBe('/kontakt');
      expect(z.utmSource).toBe('pruefreihe');
      expect(JSON.stringify(z)).not.toContain('geheim123');
      expect(z.sessionHash).toMatch(/^[0-9a-f]{64}$/);
    }
    konsole.keineFehler();
  });

  test('ein Werbeblocker sperrt den Endpunkt: keine Fehler, die Seite funktioniert', async ({ page, context }) => {
    await context.route('**/api/public/traffic', (route) => route.abort('blockedbyclient'));
    const konsole = konsoleUeberwachen(page, [/traffic|blockedbyclient|ERR_BLOCKED_BY_CLIENT|NS_ERROR|Failed to load resource/i]);
    await page.goto('/');
    await page.getByRole('button', { name: 'Alle akzeptieren' }).click();
    await page.locator('footer a[href="/kontakt"]').first().click();
    await page.waitForURL(/\/kontakt$/);
    await expect(page.locator('h1')).toBeVisible();
    await verlassen(page);
    // Nur die erwartete Blockade — kein Seitenfehler, kein unbehandeltes Versprechen.
    expect(konsole.fehler.filter((f) => f.startsWith('pageerror'))).toEqual([]);
  });
});
