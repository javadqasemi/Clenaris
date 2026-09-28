import { test, expect } from './helpers/basis';
import { imBrowserAnmelden, konsoleUeberwachen, ressourcenfehler } from './helpers/browser';

/**
 * Sitzung über mehrere Tabs (2026-09-28).
 *
 * Zwei Fehler, die dieser Fall festhält:
 *
 *  1. **Ein Tab im Hintergrund meldete die Sitzung ab**, während im Tab
 *     daneben gearbeitet wurde. Jeder Tab führte seine eigene Uhr; der
 *     untätige erreichte nach fünfzehn Minuten sein Limit und rief
 *     `/api/auth/logout` — für alle. Gegen den alten Stand landet Tab B hier
 *     auf der Anmeldemaske.
 *  2. **Eine Abmeldung erreichte die anderen Tabs nicht.** Sie arbeiteten mit
 *     toten Cookies weiter bis zum nächsten Fehler.
 *
 * Dazu die Warnung vor dem Ablauf: zwei Minuten vorher, mit „Weiterarbeiten"
 * und „Abmelden", und eine Antwort in einem Tab gilt für alle.
 *
 * Die Zeit läuft über Playwrights Uhr (`context.clock`) — gewartet wird nicht
 * fünfzehn Minuten, sondern vorgespult. Der Server rechnet weiter in echter
 * Zeit; seine Sitzung bleibt darum gültig, und was hier geprüft wird, ist
 * allein das Verhalten des Wächters im Browser.
 */

test.describe('Sitzung in mehreren Tabs', () => {
  test('Arbeit in einem Tab hält den anderen angemeldet; Warnung, Weiterarbeiten und Abmelden gelten für alle Tabs', async ({ context, page }) => {
    await context.clock.install();
    const konsole = konsoleUeberwachen(page);
    await imBrowserAnmelden(page, 'admin', /\/admin/);

    const tabB = await context.newPage();
    await tabB.goto('/admin');
    await expect(tabB).toHaveURL(/\/admin/);

    // Vierzehn Minuten: in Tab A jede Minute eine Eingabe, Tab B unberührt.
    for (let minute = 0; minute < 14; minute++) {
      await page.mouse.move(100 + minute, 200);
      await page.keyboard.press('Shift');
      await context.clock.runFor(60_000);
    }
    await tabB.bringToFront();
    await context.clock.runFor(10_000);
    await expect(tabB, 'der untätige Tab hat die Sitzung beendet').toHaveURL(/\/admin/);
    await expect(tabB.getByRole('dialog')).toHaveCount(0);

    // Jetzt nirgends mehr eine Eingabe: nach 13 Minuten steht die Warnung.
    await context.clock.runFor(13 * 60_000 + 10_000);
    await expect(tabB.getByRole('dialog', { name: /Sitzung läuft bald ab/ })).toBeVisible();
    await expect(page.getByRole('dialog', { name: /Sitzung läuft bald ab/ })).toBeVisible();

    // „Weiterarbeiten" in Tab A schliesst die Warnung auch in Tab B.
    await page.getByRole('button', { name: 'Weiterarbeiten' }).click();
    await context.clock.runFor(6_000);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(tabB.getByRole('dialog')).toHaveCount(0);
    await expect(tabB).toHaveURL(/\/admin/);

    // Bis hierher kein einziger Fehler — auch keine abgewiesene Erneuerung.
    konsole.keineFehler();

    // Wieder untätig bis zur Warnung, dann „Abmelden" in Tab B: Tab A folgt.
    await context.clock.runFor(13 * 60_000 + 10_000);
    await tabB.getByRole('button', { name: 'Abmelden' }).click();
    await expect(tabB).toHaveURL(/\/auth\/anmelden/);
    await expect(page).toHaveURL(/\/auth\/anmelden.*grund=abgemeldet/);

    /*
      Zwischen dem Abmelden in Tab B und der Nachricht an Tab A liegt ein
      Augenblick, in dem Tab A mit den eben widerrufenen Cookies noch eine
      Erneuerung versuchen kann (Wächter, Glocke) — die Antwort ist dann 401,
      und genau das ist richtig: Die Sitzung ist beendet. Erlaubt ist deshalb
      ausschliesslich ein 401, und erst nach dem Abmelden; vor diesem Schritt
      prüft `keineFehler()` oben ohne Ausnahme.
    */
    konsole.erwartet(ressourcenfehler(401));
    konsole.keineFehler();
  });
});
