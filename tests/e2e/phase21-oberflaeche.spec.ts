import type { Browser, Page } from '@playwright/test';

import type { ACCOUNTS } from '../helpers/accounts';
import { axeMessen, pruefe, ruhigWarten, zeile } from './helpers/axe';
import { expect, test } from './helpers/basis';
import { imBrowserAnmelden } from './helpers/browser';

/**
 * Phase 21/22 — Oberfläche und Barrierefreiheit, **aus der Navigation
 * abgeleitet** statt von Hand aufgezählt (2026-09-27).
 *
 * Die Wave-18-Reihe misst vierzehn ausgewählte Seiten bei 1366 px. Eine
 * Auswahl von Hand veraltet mit jeder neuen Seite — genau so blieben 150
 * Seiten ungemessen. Hier liest jeder Fall die Seitenleiste der jeweiligen
 * Rolle und prüft **jeden** Eintrag:
 *
 *  • erreichbar (Antwort < 400, keine Fehlergrenze „Dieser Bereich lässt sich
 *    gerade nicht laden"),
 *  • richtig markiert (`aria-current="page"` genau auf diesem Eintrag),
 *  • axe ohne „critical"/„serious".
 *
 * Dazu, was keine Maschine allein aus einer Seite liest: Sprunglink,
 * Umbruch ohne seitliches Scrollen in sieben Fenstergrössen und bei 200 %
 * Zoom, mobile Navigation mit denselben Einträgen, Fokus in Dialogen und
 * Suche, reduzierte Bewegung. Eine Konformitätsaussage ist das nicht
 * (`docs/BARRIEREFREIHEIT.md`); es verhindert Rückschritte bei allem, was
 * sich messen lässt.
 */

const BEREICHE: { konto: keyof typeof ACCOUNTS; start: string; ziel: RegExp }[] = [
  { konto: 'super', start: '/admin', ziel: /\/admin/ },
  { konto: 'admin', start: '/admin', ziel: /\/admin/ },
  { konto: 'manager', start: '/admin', ziel: /\/admin/ },
  { konto: 'employee', start: '/portal', ziel: /\/portal/ },
  { konto: 'customer', start: '/konto', ziel: /\/konto/ },
];

const FEHLERGRENZE = 'Dieser Bereich lässt sich gerade nicht laden';

async function angemeldet(browser: Browser, konto: keyof typeof ACCOUNTS, ziel: RegExp, viewport = { width: 1366, height: 900 }): Promise<Page> {
  const kontext = await browser.newContext({ viewport, locale: 'de-CH', timezoneId: 'Europe/Zurich' });
  await kontext.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }));
  const seite = await kontext.newPage();
  await imBrowserAnmelden(seite, konto, ziel);
  return seite;
}

async function navigationsziele(page: Page): Promise<string[]> {
  const hrefs = await page.locator('nav[aria-label="Bereichsnavigation"] a[href]').evaluateAll((links) =>
    links.map((a) => a.getAttribute('href') ?? ''),
  );
  return [...new Set(hrefs.filter((h) => h.startsWith('/')))];
}

/** Seitliches Überlaufen des Dokuments — Rollbereiche innerhalb von Komponenten (Tabellen) sind erlaubt. */
async function ueberlauf(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

for (const bereich of BEREICHE) {
  test(`Navigation ${bereich.konto}: jeder Eintrag erreichbar, aktiv markiert, axe ohne schwere Befunde`, async ({ browser }, testInfo) => {
    test.setTimeout(900_000);
    const page = await angemeldet(browser, bereich.konto, bereich.ziel);
    const ziele = await navigationsziele(page);
    expect(ziele.length, 'keine Einträge in der Seitenleiste').toBeGreaterThan(2);

    const befunde: string[] = [];
    for (const ziel of ziele) {
      const antwort = await page.goto(ziel);
      await page.waitForLoadState('networkidle');
      if (!antwort || antwort.status() >= 400) {
        befunde.push(`${ziel}: HTTP ${antwort?.status() ?? 'keine Antwort'}`);
        continue;
      }
      if (await page.getByText(FEHLERGRENZE).count()) {
        befunde.push(`${ziel}: Fehlergrenze`);
        continue;
      }
      const markiert = await page.locator('nav[aria-label="Bereichsnavigation"] a[aria-current="page"]').evaluateAll((a) => a.map((l) => l.getAttribute('href')));
      if (markiert.length !== 1 || markiert[0] !== ziel) befunde.push(`${ziel}: aktiv markiert ist ${JSON.stringify(markiert)}`);
      await ruhigWarten(page, false);
      const { schwer } = await axeMessen(page, `${bereich.konto} ${ziel}`, testInfo);
      for (const v of schwer) befunde.push(zeile(ziel, v));
    }
    await page.context().close();
    expect(befunde, befunde.join('\n')).toEqual([]);
  });
}

test('Sprunglink: erster Tabstopp, springt zum Inhalt — öffentlich, im Konto und beim Unterschreiben', async ({ browser }) => {
  const page = await angemeldet(browser, 'admin', /\/admin/);
  for (const pfad of ['/', '/admin', '/auth/anmelden']) {
    await page.goto(pfad);
    await page.waitForLoadState('networkidle');
    await page.keyboard.press('Tab');
    const fokus = page.locator(':focus');
    await expect(fokus, `${pfad}: erster Tabstopp`).toHaveText('Zum Inhalt springen');
    await expect(fokus).toHaveAttribute('href', '#inhalt');
    expect(await page.locator('#inhalt').count(), `${pfad}: Sprungziel fehlt`).toBe(1);
  }
  // Die Rahmen ohne App-Hülle: Signieren und Abnahme — dort fehlte das Ziel bis 2026-09-27.
  for (const pfad of ['/signieren', '/geraet-uebernehmen']) {
    await page.goto(pfad);
    expect(await page.locator('#inhalt').count(), `${pfad}: Sprungziel fehlt`).toBe(1);
  }
  await page.context().close();
});

const FENSTER = [
  { width: 375, height: 667 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  // 200 % Zoom auf 1366×900 entspricht diesem Fenster (WCAG 1.4.10: Umbruch ohne seitliches Scrollen).
  { width: 683, height: 450 },
];

const KRITISCH: { konto: keyof typeof ACCOUNTS | null; ziel: RegExp; seiten: string[] }[] = [
  { konto: null, ziel: /.*/, seiten: ['/', '/buchen', '/offerte', '/kontakt', '/auth/anmelden'] },
  { konto: 'admin', ziel: /\/admin/, seiten: ['/admin', '/admin/buchungen', '/admin/kunden', '/admin/rechnungen', '/admin/kalender', '/admin/einsaetze', '/admin/einstellungen'] },
  { konto: 'employee', ziel: /\/portal/, seiten: ['/portal', '/portal/einsaetze', '/portal/kalender'] },
  { konto: 'customer', ziel: /\/konto/, seiten: ['/konto', '/konto/buchungen', '/konto/rechnungen'] },
];

test('Umbruch: kein seitliches Scrollen in sieben Fenstergrössen und bei 200 % Zoom', async ({ browser }) => {
  test.setTimeout(900_000);
  const befunde: string[] = [];
  for (const fenster of FENSTER) {
    for (const gruppe of KRITISCH) {
      const page = gruppe.konto
        ? await angemeldet(browser, gruppe.konto, gruppe.ziel, fenster)
        : await (await browser.newContext({ viewport: fenster, locale: 'de-CH' })).newPage();
      for (const pfad of gruppe.seiten) {
        const antwort = await page.goto(pfad);
        if (!antwort || antwort.status() >= 400) {
          befunde.push(`${fenster.width}×${fenster.height} ${pfad}: HTTP ${antwort?.status()}`);
          continue;
        }
        await page.waitForLoadState('networkidle');
        const zuviel = await ueberlauf(page);
        if (zuviel > 1) befunde.push(`${fenster.width}×${fenster.height} ${pfad}: ${zuviel} px seitlich`);
      }
      await page.context().close();
    }
  }
  expect(befunde, befunde.join('\n')).toEqual([]);
});

test('Mobile Navigation: dieselben Einträge wie die Seitenleiste, Escape schliesst, Fokus kehrt zurück', async ({ browser }) => {
  const breit = await angemeldet(browser, 'admin', /\/admin/);
  const erwartet = await navigationsziele(breit);
  await breit.context().close();

  const page = await angemeldet(browser, 'admin', /\/admin/, { width: 390, height: 844 });
  const knopf = page.getByRole('button', { name: 'Navigation öffnen' });
  await knopf.click();
  const menue = page.getByRole('dialog', { name: 'Navigation' });
  await expect(menue).toBeVisible();
  const mobil = await menue.locator('nav[aria-label="Bereichsnavigation"] a[href]').evaluateAll((l) => l.map((a) => a.getAttribute('href')));
  expect(new Set(mobil)).toEqual(new Set(erwartet));
  await page.keyboard.press('Escape');
  await expect(menue).toBeHidden();
  await expect(knopf).toBeFocused();
  await page.context().close();
});

test('Dialog und Suche: Fokus hinein, Escape hinaus, Fokus zurück; Pfeile bis „Alle Treffer"', async ({ browser }, testInfo) => {
  const page = await angemeldet(browser, 'admin', /\/admin/);
  // Der Scanner-Dialog als Stellvertreter für alle Radix-Dialoge.
  const scan = page.getByRole('button', { name: 'Scannen' });
  await scan.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((d) => d.contains(document.activeElement)), 'Fokus nicht im Dialog').toBe(true);
  const { schwer } = await axeMessen(page, 'Scanner-Dialog offen', testInfo);
  expect(schwer.map((v) => zeile('Scanner-Dialog', v))).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(scan).toBeFocused();

  // Suche: Strg+K, Treffer, mit Pfeil bis zur letzten Option „Alle Treffer anzeigen", Enter.
  await page.keyboard.press('Control+k');
  const feld = page.getByRole('combobox');
  await expect(feld).toBeFocused();
  await feld.fill('Re');
  await feld.pressSequentially('i', { delay: 50 });
  const liste = page.getByRole('listbox', { name: 'Suchergebnisse' });
  await expect(liste.getByRole('option').first()).toBeVisible();
  const anzahl = await liste.getByRole('option').count();
  for (let i = 0; i < anzahl; i += 1) await feld.press('ArrowDown');
  await expect(liste.getByRole('option', { name: 'Alle Treffer anzeigen' })).toHaveAttribute('aria-selected', 'true');
  await feld.press('Enter');
  await page.waitForURL(/\/admin\/suche\?q=Rei/);
  await page.context().close();
});

test('Reduzierte Bewegung: keine laufenden Übergänge über 10 ms auf der Startseite', async ({ browser }) => {
  const kontext = await browser.newContext({ reducedMotion: 'reduce', locale: 'de-CH' });
  const page = await kontext.newPage();
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  const lange = await page.evaluate(() =>
    document
      .getAnimations()
      .filter((a) => {
        const t = a.effect?.getComputedTiming();
        return a.playState === 'running' && t !== undefined && Number(t.duration) > 10;
      })
      .map((a) => (a as CSSAnimation).animationName ?? 'Übergang'),
  );
  expect(lange, `Animationen trotz reduzierter Bewegung: ${lange.join(', ')}`).toEqual([]);
  await kontext.close();
});

test('öffentliche Seiten auf dem Telefon: axe ohne schwere Befunde', async ({ browser }, testInfo) => {
  const kontext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'de-CH', hasTouch: true, isMobile: true });
  const page = await kontext.newPage();
  const befunde: string[] = [];
  for (const pfad of ['/', '/buchen', '/offerte', '/kontakt']) {
    const { schwer } = await pruefe(page, pfad, testInfo, true);
    for (const v of schwer) befunde.push(zeile(`390 px ${pfad}`, v));
  }
  await kontext.close();
  expect(befunde, befunde.join('\n')).toEqual([]);
});
