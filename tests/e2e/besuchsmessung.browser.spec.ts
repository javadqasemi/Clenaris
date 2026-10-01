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
 * Einwilligung wirklich meldet, ob ein Werbeblocker, der den Endpunkt
 * sperrt, die Website beschädigt, und (seit 2026-09-30) ob ein Widerruf
 * sofort wirkt. Das sind die Zusagen aus
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

/**
 * Warten, bis die Seitenansicht eines bestimmten Pfads gespeichert ist —
 * höchstens `ms`. Gibt alle Zeilen seit `seit` zurück.
 *
 * Gezielt auf den Pfad statt „bis irgendeine Zeile da ist": Die Erfassung
 * sammelt 500 ms und sendet dann; je nach Tempo der Navigation reisen zwei
 * Seitenansichten in einer Anfrage oder in zweien, und die zweite kommt
 * 0,6–0,9 s nach der ersten an (Diagnoselauf 2026-09-28).
 */
async function warteAufSeitenansicht(seit: Date, pfad: string, ms: number) {
  const ende = Date.now() + ms;
  for (;;) {
    const zeilen = (await testDb()?.trafficEvent.findMany({ where: { occurredAt: { gte: seit } } })) ?? [];
    if (zeilen.some((z) => z.path === pfad) || Date.now() >= ende) return zeilen;
    await new Promise((r) => setTimeout(r, 250));
  }
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

    /*
      Die Seite, auf der die Einwilligung erteilt wurde, zählt ab diesem
      Moment — ihre Ansicht muss ankommen, **während der Tab offen ist**.

      Bis 2026-09-28 schloss der Fall den Tab Millisekunden nach dem
      Linkwechsel. In Firefox ging dabei 1–3 von 20 Mal die Ansicht von
      `/kontakt` verloren. Diagnoselauf mit protokolliertem `sendBeacon`: Der
      Sammeltakt (500 ms) hatte sie gesendet (`sendBeacon` → `true`), 7 ms
      bevor der Tab schloss — und Firefox verwarf die Anfrage mit dem Tab.
      Ab rund 50 ms Abstand kam sie immer an, bei offenem Tab 20 von 20 Mal,
      mit bestehendem Browserkontext ebenso verloren wie ohne. Das ist ein
      Verhalten der Engine im Millisekundenfenster vor dem Schliessen, keine
      Lücke der Erfassung; für die Messung heisst es schlimmstenfalls eine
      Seitenansicht weniger (Pendenz W-05). Ein Mensch schliesst einen Tab
      nicht sieben Millisekunden nach einem Zeitgeber.
    */
    const kontaktAngekommen = await warteAufSeitenansicht(seit, '/kontakt', 10_000);
    expect(kontaktAngekommen.map((z) => z.path), 'die Ansicht der Einwilligungsseite fehlt').toContain('/kontakt');

    await perLinkZu(page, '/ueber-uns');
    konsole.keineFehler();
    await page.close({ runBeforeUnload: true });
    await context.close();

    const zeilen = await warteAufSeitenansicht(seit, '/kontakt', 10_000);
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

  /*
    TA-03 (2026-09-30): Der Widerruf muss so einfach sein wie die Einwilligung
    — und er muss wirken. Die Fälle oben prüfen „nie eingewilligt" und
    „eingewilligt"; was fehlte, ist der Übergang: Wer widerruft, darf ab
    diesem Moment keine Zeile mehr erzeugen, die Kennung des Tabs muss weg
    sein, und das Banner muss neu fragen, statt die alte Entscheidung still
    weiterzuführen.

    Zwei Fallen, die der Fall umgeht:

     • Die Schaltfläche heisst „Einstellungen zurücksetzen"; das Banner hat
       eine Schaltfläche „Einstellungen". `getByRole` vergleicht ohne
       `exact` als Teilzeichenkette — nach dem Neuladen träfe „Einstellungen"
       beide. Deshalb überall `exact: true`.
     • Was **vor** dem Widerruf gesammelt wurde, darf noch ankommen: Ein
       Beacon, den der Browser beim Neuladen abschickt, landet Millisekunden
       später in der Tabelle. Der Zeitpunkt, ab dem nichts mehr kommen darf,
       wird deshalb erst gesetzt, wenn die Tabelle zur Ruhe gekommen ist —
       sonst prüfte der Fall die Laufzeit eines Beacons, nicht den Widerruf.
  */
  test('Widerruf über „Einstellungen zurücksetzen": danach keine Zeile mehr, das Banner fragt neu', async ({ browser }) => {
    const anfang = new Date();
    const context = await menschlicherKontext(browser);
    const page = await context.newPage();

    // Einwilligen und belegen, dass gemessen wird — sonst bewiese die leere
    // Tabelle am Ende nichts über den Widerruf.
    await page.goto('/');
    await page.getByRole('button', { name: 'Alle akzeptieren', exact: true }).click();
    const gemessen = await warteAufSeitenansicht(anfang, '/', 10_000);
    expect(gemessen.map((z) => z.path), 'vor dem Widerruf wurde nicht gemessen').toContain('/');
    expect(await page.evaluate(() => window.sessionStorage.getItem('clenaris-besuch')), 'keine Kennung des Tabs').not.toBeNull();

    // Über die Fusszeile zur Datenschutzerklärung, dort widerrufen.
    await perLinkZu(page, '/legal/datenschutz');
    const zuruecksetzen = page.getByRole('button', { name: 'Einstellungen zurücksetzen', exact: true });
    await expect(zuruecksetzen).toBeVisible();
    // Das Neuladen abwarten — der nächste `load` ist das Neuladen, denn die
    // Wege bis hier waren App-Navigationen ohne eigenes `load`. Eine
    // Markierung am alten `window` belegt danach, dass es wirklich neu ist.
    await page.evaluate(() => {
      (window as unknown as { vorDemWiderruf?: boolean }).vorDemWiderruf = true;
    });
    const neuGeladen = page.waitForEvent('load');
    await zuruecksetzen.click();
    await neuGeladen;
    expect(
      await page.evaluate(() => (window as unknown as { vorDemWiderruf?: boolean }).vorDemWiderruf ?? false),
      'die Seite wurde nicht neu geladen',
    ).toBe(false);

    // Das Banner fragt neu, und im Browser ist nichts von der Einwilligung übrig.
    await expect(page.getByRole('button', { name: 'Alle akzeptieren', exact: true })).toBeVisible();
    const speicher = () =>
      page.evaluate(() => ({
        einwilligung: window.localStorage.getItem('clenaris-consent'),
        kennung: window.sessionStorage.getItem('clenaris-besuch'),
      }));
    expect(await speicher()).toEqual({ einwilligung: null, kennung: null });

    // Ruhe abwarten: so lange, bis 1,5 Sekunden lang keine Zeile mehr dazukam
    // (dreimal die Sammelzeit), höchstens zehn Sekunden.
    let bisher = await zeilenSeit(anfang);
    let ruhigSeit = Date.now();
    const spaetestens = Date.now() + 10_000;
    while (Date.now() - ruhigSeit < 1_500 && Date.now() < spaetestens) {
      await page.waitForTimeout(250);
      const jetzt = await zeilenSeit(anfang);
      if (jetzt !== bisher) {
        bisher = jetzt;
        ruhigSeit = Date.now();
      }
    }
    const seit = new Date();

    // Weiter wie ein Mensch, ohne neue Entscheidung: über die Navigation der
    // Rechtstexte (oben, nicht unter dem Banner) zur Cookie-Erklärung.
    await page.getByRole('navigation', { name: 'Rechtliche Dokumente' }).getByRole('link', { name: 'Cookies', exact: true }).click();
    await page.waitForURL(/\/legal\/cookies$/);
    await expect(page.locator('h1')).toBeVisible();
    expect(await speicher(), 'nach dem Widerruf entstand wieder etwas im Browser').toEqual({ einwilligung: null, kennung: null });
    await page.close({ runBeforeUnload: true });
    await context.close();

    // Über die Sammelzeit hinaus warten: Auch verzögert darf nichts kommen.
    expect(await warteAufZeilen(seit, 4_000), 'nach dem Widerruf wurde weiter gemessen').toBe(0);
  });
});
