import { post } from '../helpers/client';
import { testDb } from '../helpers/testdb';
import { test, expect } from './helpers/basis';
import { imBrowserAnmelden, konsoleUeberwachen } from './helpers/browser';
import { frischAnmelden } from './helpers/bestand';

/**
 * Fehler- und Leerzustände, die das Zustandsaudit des Release-Kandidaten
 * fand (2026-09-29, PENDENZEN RC-06).
 *
 * Jeder Fall erzeugt den Fehler, statt auf ihn zu warten: Die Anfrage wird im
 * Browser abgebrochen (`route.abort`, ein Netzfehler wie ein verlorenes
 * WLAN). Geprüft wird, was die Person dann sieht — und dass „Erneut
 * versuchen" bzw. eine neue Eingabe wieder zum Erfolg führt. Die einzigen
 * Konsolenfehler, die zugelassen werden, sind die selbst ausgelösten
 * Netzabbrüche (`erwartet`, gezählt); alles andere lässt den Fall scheitern.
 *
 * Gegen den alten Stand scheitert jeder Fall: Liste zeigte „Noch keine
 * Nachrichten", der Verlauf blieb im Skelett, der Preis fiel auf den
 * neutralen Platzhalter, die Satztabelle zeigte nur ihre Kopfzeile.
 */

const BETREFF = `Prüfung Zustände ${Date.now().toString(36)}`;

async function verlaeufeAufraeumen() {
  const db = testDb();
  if (!db) return;
  await db.message.deleteMany({ where: { thread: { subject: BETREFF } } });
  await db.messageThread.deleteMany({ where: { subject: BETREFF } });
}

test.describe('Fehler- und Leerzustände', () => {
  let verlaufId = '';

  test.beforeAll(async () => {
    await verlaeufeAufraeumen();
    const jar = await frischAnmelden('customer');
    const antwort = await post<{ data: { id: string } }>('/api/messages', { subject: BETREFF, body: 'Eine Frage zum Termin, bitte.' }, { jar });
    if (antwort.status !== 201) throw new Error(`Verlauf anlegen: HTTP ${antwort.status} — ${antwort.text}`);
    verlaufId = (JSON.parse(antwort.text) as { data: { id: string } }).data.id;
  });
  test.afterAll(verlaeufeAufraeumen);

  test('Nachrichtenliste: ein Netzfehler ist kein leeres Postfach — und „Erneut versuchen" lädt', async ({ page }) => {
    const konsole = konsoleUeberwachen(page);
    await page.route('**/api/messages?**', (route) => route.abort());
    await imBrowserAnmelden(page, 'customer', /\/konto/, '/konto/nachrichten');

    await expect(page.getByText('Die Nachrichten konnten nicht geladen werden')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Noch keine Nachrichten')).toHaveCount(0);

    await page.unroute('**/api/messages?**');
    await page.getByRole('button', { name: 'Erneut versuchen' }).click();
    await expect(page.getByRole('navigation', { name: 'Nachrichtenverläufe' }).getByText(BETREFF)).toBeVisible();
    await expect(page.getByText('Die Nachrichten konnten nicht geladen werden')).toHaveCount(0);

    expect(konsole.erwartet(/ERR_FAILED/), 'der Netzabbruch kam nicht an').toBeGreaterThan(0);
    konsole.keineFehler();
  });

  test('Nachrichtenverlauf: ein Netzfehler lässt kein ewiges Skelett stehen — und „Erneut versuchen" lädt', async ({ page }) => {
    const konsole = konsoleUeberwachen(page);
    const verlauf = `**/api/messages/${verlaufId}`;
    await page.route(verlauf, (route) => (route.request().method() === 'GET' ? route.abort() : route.continue()));
    await imBrowserAnmelden(page, 'customer', /\/konto/, '/konto/nachrichten');

    // Der neueste Verlauf öffnet sich von selbst — das ist der eben angelegte.
    await expect(page.getByText('Der Verlauf konnte nicht geladen werden')).toBeVisible({ timeout: 15_000 });

    await page.unroute(verlauf);
    await page.getByRole('button', { name: 'Erneut versuchen' }).click();
    const panel = page.locator('section').filter({ has: page.getByRole('heading', { name: BETREFF }) });
    await expect(panel).toBeVisible();
    // Der Text steht auch in der Vorschau der Liste — geprüft wird der Verlauf selbst.
    await expect(panel.getByText('Eine Frage zum Termin, bitte.')).toBeVisible();

    expect(konsole.erwartet(/ERR_FAILED/), 'der Netzabbruch kam nicht an').toBeGreaterThan(0);
    konsole.keineFehler();
  });

  test('Buchung: ein Netzfehler der Preisberechnung wird gemeldet, eine neue Eingabe rechnet wieder', async ({ page }) => {
    const konsole = konsoleUeberwachen(page);
    await page.route('**/api/public/pricing/estimate', (route) => route.abort());
    await page.goto('/buchen');
    await page.getByRole('checkbox', { name: /Unterhaltsreinigung/ }).click();
    await page.getByRole('button', { name: 'Weiter' }).click();
    await page.locator('#sqm').fill('120');

    const meldung = page.getByText('Der Preis konnte nicht berechnet werden. Bitte prüfen Sie die Verbindung.').first();
    await expect(meldung).toBeVisible({ timeout: 15_000 });

    await page.unroute('**/api/public/pricing/estimate');
    await page.locator('#sqm').fill('121');
    await expect(meldung).toBeHidden({ timeout: 15_000 });
    // Der Server hat gerechnet: Die Zusammenfassung zeigt einen Betrag.
    await expect(page.locator('aside').getByText(/CHF/).first()).toBeVisible({ timeout: 15_000 });

    expect(konsole.erwartet(/ERR_FAILED/), 'der Netzabbruch kam nicht an').toBeGreaterThan(0);
    konsole.keineFehler();
  });

  test('Lohn: ein Jahr ohne Satzversion zeigt einen Leerzustand statt einer leeren Tabelle', async ({ page }) => {
    const konsole = konsoleUeberwachen(page);
    await imBrowserAnmelden(page, 'admin', /\/admin/, '/admin/lohn?jahr=2001&monat=6');
    await expect(page.getByText('Keine Beitragssätze für 2001')).toBeVisible();
    await expect(page.getByRole('table', { name: 'Satzversionen 2001' })).toHaveCount(0);
    konsole.keineFehler();
  });
});
