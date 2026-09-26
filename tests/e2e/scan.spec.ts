import { randomInt } from 'node:crypto';

import type { Page } from '@playwright/test';

import { eigeneOrganisationId, schutzfreiAufraeumen, testDb } from '../helpers/testdb';

import { expect, test } from './helpers/basis';
import { imBrowserAnmelden } from './helpers/browser';

/**
 * Scanplattform im Browser (2026-09-26): Kamera → Treffer → Schnellaktion →
 * Buchung → Protokoll, und die feindlichen Fälle, bei denen gerade *nichts*
 * geschehen darf.
 *
 * **Die Kamera ist nachgebildet, der Rest nicht.** Der Prüfbrowser hat weder
 * eine Kamera noch — unter Windows — einen `BarcodeDetector`. Ein Init-Skript
 * setzt beides ein: `getUserMedia` liefert den Strom einer leeren Leinwand,
 * der Detektor „erkennt" nach ein paar Bildern den vorgegebenen Text. Alles
 * dahinter ist echt: Komponente, Endpunkt, Rechte, Lagerbuchung, Datenbank,
 * Protokoll. Was damit *nicht* bewiesen ist: dass ein echter Detektor einen
 * gedruckten Code liest — das ist Sache des Browsers (`docs/SCANNER.md`).
 */

const db = testDb();
const SKU = 'PRUEF-E2E-SCAN';
const SKU_NEU = 'PRUEF-E2E-SCAN-NEU';
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function zufallscode(): string {
  return Array.from({ length: 20 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
}

function mitPruefziffer(koerper: string): string {
  let summe = 0;
  for (let i = 0; i < koerper.length; i += 1) summe += Number(koerper[koerper.length - 1 - i]) * (i % 2 === 0 ? 3 : 1);
  return `${koerper}${(10 - (summe % 10)) % 10}`;
}

async function aufraeumen(): Promise<void> {
  if (!db) return;
  const materialien = await db.material.findMany({ where: { sku: { in: [SKU, SKU_NEU] } }, select: { id: true } });
  const ids = materialien.map((m) => m.id);
  if (ids.length === 0) return;
  await schutzfreiAufraeumen(async (tx) => {
    await tx.scanCode.deleteMany({ where: { entityId: { in: ids } } });
    await tx.stockMovement.deleteMany({ where: { materialId: { in: ids } } });
    await tx.material.deleteMany({ where: { id: { in: ids } } });
  });
}

/** Kamera und Detektor nachbilden — der Detektor „sieht" den Text ab dem dritten Bild. */
async function kameraNachbilden(page: Page, text: string): Promise<void> {
  await page.addInitScript((erkannt) => {
    let bilder = 0;
    class Nachbildung {
      static async getSupportedFormats() {
        return ['qr_code', 'ean_13', 'ean_8', 'upc_a', 'code_128'];
      }
      async detect() {
        bilder += 1;
        return bilder >= 3 ? [{ rawValue: erkannt, format: 'qr_code' }] : [];
      }
    }
    Object.defineProperty(window, 'BarcodeDetector', { value: Nachbildung, configurable: true });
    navigator.mediaDevices.getUserMedia = async () => {
      const leinwand = document.createElement('canvas');
      leinwand.width = 320;
      leinwand.height = 240;
      leinwand.getContext('2d')!.fillRect(0, 0, 320, 240);
      return leinwand.captureStream(10);
    };
  }, text);
}

async function scannerOeffnen(page: Page) {
  await page.getByRole('button', { name: 'Scannen' }).click();
  const dialog = page.getByRole('dialog', { name: 'Scannen' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('Scanplattform', () => {
  test.beforeEach(async () => {
    await aufraeumen();
  });
  test.afterEach(async () => {
    await aufraeumen();
  });

  test('Kamera → Treffer → Wareneingang → Bestand und Protokoll', async ({ page }) => {
    test.skip(!db, 'Keine Testdatenbank.');
    const organizationId = (await eigeneOrganisationId())!;
    const material = await db!.material.create({ data: { organizationId, sku: SKU, name: 'Prüfreihe Scanreiniger', unit: 'l', unitCost: 4.2 } });
    const code = zufallscode();
    await db!.scanCode.create({ data: { organizationId, entityType: 'MATERIAL', entityId: material.id, code } });

    // Ein Dialog des Browsers hiesse, der Scan hätte etwas ausgeführt.
    let browserdialoge = 0;
    page.on('dialog', async (d) => {
      browserdialoge += 1;
      await d.dismiss();
    });
    await kameraNachbilden(page, `CLX1:${code}`);
    await imBrowserAnmelden(page, 'manager', /\/admin/);
    const vorher = page.url();

    const dialog = await scannerOeffnen(page);
    await dialog.getByRole('button', { name: 'Kamera', exact: true }).click();

    const treffer = dialog.locator('[data-scan-treffer="MATERIAL"]');
    await expect(treffer).toContainText('Prüfreihe Scanreiniger');
    // Erkannt heisst nicht geöffnet: dieselbe Seite, die Kamera wieder aus.
    expect(page.url()).toBe(vorher);
    await expect(dialog.getByRole('button', { name: 'Kamera', exact: true })).toBeVisible();
    expect(await dialog.locator('video').evaluate((v: HTMLVideoElement) => v.srcObject)).toBeNull();
    // Nichts gebucht, bevor jemand wählt.
    expect(await db!.stockMovement.count({ where: { materialId: material.id } })).toBe(0);

    await treffer.getByRole('button', { name: 'Wareneingang' }).click();
    const maske = treffer.locator('[data-scan-maske="Wareneingang"]');
    await maske.getByLabel(/^Menge/).fill('7');
    await maske.getByLabel(/^Lieferschein/).fill('LS-E2E-SCAN');
    await maske.getByRole('button', { name: 'Eingang buchen' }).click();

    // Der Treffer wird nach dem Buchen neu aufgelöst und zeigt den neuen Bestand.
    await expect(treffer).toContainText(/7\s*l/, { timeout: 25_000 });
    const bewegung = await db!.stockMovement.findFirstOrThrow({ where: { materialId: material.id }, select: { id: true, kind: true, quantity: true, reference: true } });
    expect(bewegung.kind).toBe('RECEIPT');
    expect(Number(bewegung.quantity)).toBe(7);
    expect(bewegung.reference).toBe('LS-E2E-SCAN');
    const eintrag = await db!.auditLog.findFirst({ where: { entity: 'StockMovement', entityId: bewegung.id } });
    expect(eintrag?.action).toBe('CREATE');
    expect(browserdialoge).toBe(0);
  });

  test('feindliche Inhalte: nichts wird geöffnet, ausgeführt oder als Markup dargestellt', async ({ page }) => {
    let dialoge = 0;
    page.on('dialog', async (d) => {
      dialoge += 1;
      await d.dismiss();
    });
    await imBrowserAnmelden(page, 'admin', /\/admin/);
    const vorher = page.url();
    const dialog = await scannerOeffnen(page);
    const feld = dialog.getByLabel('Code eingeben oder einfügen');

    await feld.fill('javascript:alert(document.cookie)');
    await feld.press('Enter');
    await expect(dialog.locator('[data-scan-hinweis]')).toContainText('öffnet gescannte Adressen nicht');
    await expect(dialog.locator('[data-scan-treffer]')).toHaveCount(0);

    await feld.fill('<img src=x onerror=alert(1)>');
    await feld.press('Enter');
    await expect(dialog.locator('[data-scan-eingabe]')).toContainText('<img src=x onerror=alert(1)>');
    expect(await dialog.locator('img[src="x"]').count()).toBe(0);

    await feld.fill('https://login.example.com/clenaris');
    await feld.press('Enter');
    await expect(dialog.locator('[data-scan-hinweis]')).toContainText('öffnet gescannte Adressen nicht');
    expect(await dialog.locator('a[href^="https://login.example.com"]').count()).toBe(0);

    expect(page.url()).toBe(vorher);
    expect(dialoge).toBe(0);
  });

  test('unbekannte EAN → „Neuen Artikel erfassen", vorbelegt nur mit dem Strichcode', async ({ page }) => {
    test.skip(!db, 'Keine Testdatenbank.');
    const ean = mitPruefziffer(`760${String(Date.now()).slice(-9)}`);
    await imBrowserAnmelden(page, 'manager', /\/admin/);
    const dialog = await scannerOeffnen(page);
    const feld = dialog.getByLabel('Code eingeben oder einfügen');
    await feld.fill(ean);
    await feld.press('Enter');

    await expect(dialog.locator('[data-scan-hinweis]')).toHaveText('Artikel nicht gefunden.');
    await dialog.getByRole('button', { name: 'Neuen Artikel erfassen' }).click();
    const maske = dialog.locator('[data-scan-maske="Neuen Artikel erfassen"]');
    await expect(maske.getByLabel(/^Strichcode/)).toHaveValue(ean);
    await expect(maske.getByLabel(/^Bezeichnung/)).toHaveValue('');
    await expect(maske.getByLabel(/^Artikelnummer/)).toHaveValue('');
    await maske.getByLabel(/^Artikelnummer/).fill(SKU_NEU);
    await maske.getByLabel(/^Bezeichnung/).fill('Prüfreihe Neuartikel');
    await maske.getByRole('button', { name: 'Artikel anlegen' }).click();

    await expect(dialog.locator('[data-scan-treffer="MATERIAL"]')).toContainText('Prüfreihe Neuartikel', { timeout: 25_000 });
    const angelegt = await db!.material.findFirstOrThrow({ where: { sku: SKU_NEU }, select: { barcode: true } });
    expect(angelegt.barcode).toBe(ean);
  });
});
