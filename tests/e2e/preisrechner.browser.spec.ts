import type { Request } from '@playwright/test';

import { test, expect } from './helpers/basis';
import { konsoleUeberwachen } from './helpers/browser';

/**
 * Sofort-Preisrechner der Startseite: Eine späte Antwort überschreibt nicht
 * die Zahl für die aktuelle Eingabe — in Chromium, Firefox und WebKit.
 *
 * Gefunden am 2026-09-28 beim Untersuchen eines WebKit-Befunds: Der Rechner
 * legte je Eingabe einen `AbortController` an und brach ihn beim nächsten
 * Tastendruck ab — reichte ihn aber nie an die Anfrage weiter. Tippt jemand
 * „60" und dann „500", und kommt die Antwort auf „60" nach der auf „500",
 * stand danach der Preis für 60 m² unter der Eingabe 500 m². Auf einer
 * langsamen Mobilverbindung ist genau diese Reihenfolge wahrscheinlich.
 *
 * Die Verzögerung der Antwort auf „60" ist die Versuchsanordnung: Sie legt die
 * Reihenfolge fest, die im Feld zufällig entsteht.
 */

const preisPfad = '**/api/public/pricing/estimate';

function flaecheVon(anfrage: Request): number | undefined {
  try {
    return (anfrage.postDataJSON() as { squareMeters?: number }).squareMeters;
  } catch {
    return undefined;
  }
}

test('eine späte Antwort auf eine ältere Eingabe überschreibt den aktuellen Preis nicht', async ({ page }) => {
  const konsole = konsoleUeberwachen(page);
  await page.route(preisPfad, async (route) => {
    if (flaecheVon(route.request()) === 60) await new Promise((fertig) => setTimeout(fertig, 2_500));
    // Nach dem Abbruch durch den Rechner ist die Anfrage erledigt; das
    // Weiterreichen scheitert dann und darf es.
    await route.continue().catch(() => undefined);
  });

  await page.goto('/');
  const ergebnis = page.locator('#qe-result');
  await expect(ergebnis).toContainText('inkl. MWST', { timeout: 15_000 });

  const flaeche = page.locator('#qe-area');
  const alt = page.waitForRequest((a) => a.url().endsWith('/api/public/pricing/estimate') && flaecheVon(a) === 60);
  await flaeche.fill('60');
  const anfrageAlt = await alt;

  const neu = page.waitForResponse((a) => a.url().endsWith('/api/public/pricing/estimate') && flaecheVon(a.request()) === 500);
  await flaeche.fill('500');
  const antwortNeu = await neu;
  const preisNeu = ((await antwortNeu.json()) as { data: { grossTotal: number } }).data.grossTotal;
  await expect(ergebnis).toContainText('inkl. MWST');
  const angezeigtNeu = (await ergebnis.locator('.font-display').textContent())?.trim();

  // Die ältere Anfrage ist erledigt — beantwortet (ohne Korrektur) oder
  // abgebrochen (mit Korrektur). `response()` wartet auf beides.
  await anfrageAlt.response().catch(() => null);
  await page.waitForTimeout(200); // ein Renderdurchgang nach der späten Antwort

  await expect(flaeche).toHaveValue('500');
  expect((await ergebnis.locator('.font-display').textContent())?.trim(), `angezeigt nach der späten Antwort (Preis für 500 m²: ${preisNeu})`).toBe(
    angezeigtNeu,
  );
  konsole.keineFehler();
});

test('wird die Eingabe ungültig, während gerechnet wird, bleibt kein „wird berechnet" stehen', async ({ page }) => {
  const konsole = konsoleUeberwachen(page);
  await page.route(preisPfad, async (route) => {
    if (flaecheVon(route.request()) === 60) await new Promise((fertig) => setTimeout(fertig, 2_500));
    await route.continue().catch(() => undefined);
  });

  await page.goto('/');
  const ergebnis = page.locator('#qe-result');
  await expect(ergebnis).toContainText('inkl. MWST', { timeout: 15_000 });

  const flaeche = page.locator('#qe-area');
  const alt = page.waitForRequest((a) => a.url().endsWith('/api/public/pricing/estimate') && flaecheVon(a) === 60);
  await flaeche.fill('60');
  const anfrageAlt = await alt;
  await expect(ergebnis).toContainText('Preis wird berechnet');

  // Unter 5 m² rechnet der Rechner nicht — die laufende Anfrage wird abgebrochen.
  await flaeche.fill('3');
  await anfrageAlt.response().catch(() => null);
  await expect(ergebnis).toContainText('Fläche eingeben, um den Preis zu sehen.');
  await expect(ergebnis).not.toContainText('Preis wird berechnet');
  konsole.keineFehler();
});
