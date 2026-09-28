import type { Page } from '@playwright/test';

import { ACCOUNTS } from '../helpers/accounts';
import { test, expect } from './helpers/basis';
import { konsoleUeberwachen } from './helpers/browser';

/**
 * Eingaben vor der Hydration gehen nicht verloren — in allen drei Engines.
 *
 * Gefunden am 2026-09-28 im WebKit-Lauf: Die Anmeldung schlug fehl mit „E-Mail-
 * Adresse ist erforderlich", obwohl das Feld ausgefüllt worden war. WebKit
 * hydriert langsamer als Chromium, und der Text kam an, bevor React die Seite
 * übernommen hatte. Nachgestellt in Chromium mit verzögertem JavaScript: React
 * schrieb nach der Hydration den leeren gesteuerten Wert zurück ins Feld
 * (`updateInput`), der Text war weg, der Formularzustand leer. Für echte
 * Menschen heisst das: Wer auf einem langsamen Gerät sofort tippt oder wessen
 * Passwortmanager beim Laden ausfüllt, sieht ein leeres Feld.
 *
 * Behoben in `FormControl` (`src/components/ui/form.tsx`), also für jedes
 * Formular, nicht nur für die Anmeldung.
 *
 * **Die Verzögerung der Skripte ist die Versuchsanordnung, kein Warten:** Sie
 * stellt sicher, dass das Ausfüllen *vor* der Hydration geschieht — und der
 * Fall prüft das ausdrücklich, damit er nicht still zu einem gewöhnlichen
 * Anmeldetest wird, wenn die Skripte einmal schneller da sind.
 */

/** Hat React das Feld übernommen? React hängt seine Fiber als Eigenschaft an den Knoten. */
function hydriert(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const feld = document.querySelector('input[type="email"]');
    return !!feld && Object.keys(feld).some((schluessel) => schluessel.startsWith('__reactFiber'));
  });
}

test('Anmeldung: vor der Hydration eingetippte Zugangsdaten werden übernommen', async ({ page, browserName }) => {
  const konsole = konsoleUeberwachen(page);
  const { email, password } = ACCOUNTS.admin;

  let verzoegern = true;
  await page.route('**/_next/static/chunks/**', async (route) => {
    if (verzoegern) await new Promise((fertig) => setTimeout(fertig, 1500));
    await route.continue();
  });
  await page.goto('/auth/anmelden', { waitUntil: 'commit' });

  const emailFeld = page.locator('input[type="email"]');
  const passwortFeld = page.locator('input[autocomplete="current-password"]');
  await emailFeld.waitFor();
  await emailFeld.fill(email);
  await passwortFeld.fill(password);
  expect(await hydriert(page), 'die Anordnung verlangt: ausgefüllt, bevor React die Seite übernimmt').toBe(false);

  await expect.poll(() => hydriert(page), { timeout: 30_000 }).toBe(true);
  // Die Verzögerung hat ihren Zweck erfüllt. Bliebe sie, hielte sie jedes
  // Skript des Verwaltungsbereichs nach der Anmeldung auf — in WebKit über
  // die Wartegrenze hinaus.
  verzoegern = false;
  // Nach der Hydration steht der Text noch im Feld …
  await expect(emailFeld).toHaveValue(email);
  await expect(passwortFeld).toHaveValue(password);

  // … und im Formularzustand: Die Anmeldung wird abgeschickt — mit genau
  // diesen Angaben — und angenommen. Ohne Übernahme hielte die Prüfung im
  // Browser die Anfrage auf („E-Mail-Adresse ist erforderlich").
  const anmeldung = page.waitForResponse(
    (antwort) => antwort.url().endsWith('/api/auth/login') && antwort.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
  const antwort = await anmeldung;
  expect(antwort.request().postDataJSON()).toMatchObject({ email });
  expect(antwort.status()).toBe(200);
  await expect(page.getByText('E-Mail-Adresse ist erforderlich')).toHaveCount(0);

  /*
    Der Sprung in die Verwaltung nur, wo der Prüfbrowser die Sitzung halten
    kann. Die Anmeldecookies sind `Secure` (Produktionsbau), der Prüfserver
    spricht `http://127.0.0.1`. Chromium und Firefox behandeln die Loopback-
    Adresse als sicheren Ursprung; Playwrights WebKit schickt das Cookie dort
    nicht mit — die nächste Seite leitet zur Anmeldung zurück (gemessen
    2026-09-28: Anmeldung 200, danach `/admin` → 307). Mit Safari und HTTPS
    hat das nichts zu tun; offener Punkt W-02 (HTTPS-Prüfserver).
  */
  if (browserName !== 'webkit') await page.waitForURL(/\/admin/, { timeout: 30_000 });
  konsole.keineFehler();
});
