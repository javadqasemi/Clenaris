import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { del, get, data } from '../helpers/client';
import { test, expect } from './helpers/basis';
import { imBrowserAnmelden, konsoleUeberwachen, statusAusSeite } from './helpers/browser';
import { frischAnmelden, offerteAnlegen, stammdatenLesen } from './helpers/bestand';

/**
 * KI-Textassistent im Browser (2026-09-29).
 *
 * Die HTTP-Reihe (`text-assist.test.ts`) prüft Sperren, Rechte und das 503
 * ohne Anbieter. Was sie nicht sehen kann, ist die Oberfläche: Original und
 * Vorschlag nebeneinander, das Feld unverändert, bis „Übernehmen" gedrückt
 * wird, „Verwerfen" ohne Wirkung, „Erneut generieren" als neue Anfrage —
 * und nichts gespeichert, bevor das Formular gespeichert wird.
 *
 * **Keine echte KI.** Der Prüfanbieter (`src/lib/ai/pruefanbieter.ts`)
 * antwortet der Reihe nach mit festen Texten, und nur solange die
 * Schalterdatei im Testzwischenspeicher liegt; er ist ausschliesslich in
 * einer Prüfumgebung wirksam. Er merkt sich die letzte Anfrage **nach** dem
 * Ausgangsfilter — daran prüft der Fall, dass eine E-Mail-Adresse aus dem
 * Feld nicht beim Anbieter angekommen wäre.
 */

const SCHALTER = join(process.env.CLENARIS_TEST_CACHE_DIR ?? '', 'ki-pruefanbieter.json');
const ERSTER = 'Guten Tag, gerne unterbreiten wir Ihnen unser Angebot für die Reinigung.';
const ZWEITER = 'Guten Tag, gerne senden wir Ihnen unser Angebot für die Reinigung zu.';
const ORIGINAL = 'guten tag, gerne unterbreitten wir ihnen unser angebot, antwort an pruef-ki@example.ch.';

function anbieterEinschalten() {
  mkdirSync(dirname(SCHALTER), { recursive: true });
  writeFileSync(SCHALTER, JSON.stringify({ antworten: [ERSTER, ZWEITER], aufrufe: 0 }), 'utf8');
}
const anbieterStand = () => JSON.parse(readFileSync(SCHALTER, 'utf8')) as { aufrufe: number; letzteAnfrage?: string };

test.describe('KI-Textassistent', () => {
  test.afterEach(() => {
    if (existsSync(SCHALTER)) rmSync(SCHALTER);
  });

  test('Original und Vorschlag, Verwerfen, Erneut generieren, Übernehmen — nichts gespeichert, nichts Vertrauliches beim Anbieter', async ({ page }) => {
    const konsole = konsoleUeberwachen(page);
    anbieterEinschalten();
    const jar = await frischAnmelden('admin');
    const { customerId } = await stammdatenLesen(jar);
    const offerte = await offerteAnlegen(jar, customerId);
    const maske = `/admin/offerten/${offerte.id}/bearbeiten`;
    try {
      await imBrowserAnmelden(page, 'admin', new RegExp(`${maske}$`), maske);
      const feldRolle = page.getByRole('textbox', { name: 'Einleitung' });
      await feldRolle.fill(ORIGINAL);
      // Solange der Dialog offen ist, liegt das Formular darunter inert
      // (aria-hidden) — über die Rolle ist es dann nicht zu finden, und genau
      // dann soll sein Wert geprüft werden. Deshalb über die Kennung.
      const feld = page.locator(`[id="${await feldRolle.getAttribute('id')}"]`);

      const oeffnen = page.getByRole('button', { name: 'KI-Textassistent für „Einleitung"' });
      await oeffnen.click();
      const dialog = page.getByRole('dialog', { name: 'KI-Textassistent' });
      await expect(dialog).toBeVisible();

      await dialog.getByRole('button', { name: 'Rechtschreibung korrigieren' }).click();
      const original = dialog.getByRole('region', { name: 'Original' });
      const vorschlag = dialog.getByRole('region', { name: 'Vorschlag' });
      await expect(original).toContainText(ORIGINAL);
      await expect(vorschlag).toContainText(ERSTER);
      await expect(feld, 'das Feld darf sich vor „Übernehmen" nicht ändern').toHaveValue(ORIGINAL);
      expect(anbieterStand().aufrufe).toBe(1);
      expect(anbieterStand().letzteAnfrage ?? '', 'die E-Mail-Adresse wäre beim Anbieter angekommen').not.toContain('pruef-ki@example.ch');

      await dialog.getByRole('button', { name: 'Erneut generieren' }).click();
      await expect(vorschlag).toContainText(ZWEITER);
      expect(anbieterStand().aufrufe, '„Erneut generieren" ist eine neue Anfrage').toBe(2);

      await dialog.getByRole('button', { name: 'Verwerfen' }).click();
      await expect(dialog).toBeHidden();
      await expect(feld, '„Verwerfen" hat das Feld geändert').toHaveValue(ORIGINAL);

      await oeffnen.click();
      await dialog.getByRole('button', { name: 'Rechtschreibung korrigieren' }).click();
      await expect(vorschlag).toContainText(ERSTER);
      await dialog.getByRole('button', { name: 'Übernehmen' }).click();
      await expect(dialog).toBeHidden();
      await expect(feld).toHaveValue(ERSTER);

      // Kein automatisches Speichern: Die Offerte trägt den Text erst, wenn das Formular gespeichert wird.
      const gespeichert = data(await get<{ data: { introText: string | null } }>(`/api/quotes/${offerte.id}`, { jar }));
      expect(gespeichert.introText ?? '').not.toBe(ERSTER);

      // Rechte: Mitarbeitende dürfen den Assistenten nicht aufrufen — auch nicht am Knopf vorbei.
      const personal = await page.context().browser()!.newContext();
      const seite = await personal.newPage();
      await imBrowserAnmelden(seite, 'employee', /\/portal/);
      expect(await statusAusSeite(seite, '/api/ai/text-assist', 'POST')).toBe(403);
      await personal.close();

      konsole.keineFehler();
    } finally {
      await del(`/api/quotes/${offerte.id}`, { jar });
    }
  });
});
