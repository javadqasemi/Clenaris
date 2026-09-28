import { randomInt } from 'node:crypto';

import { devices, type Page } from '@playwright/test';

import { ACCOUNTS } from '../helpers/accounts';
import { eigeneOrganisationId, schutzfreiAufraeumen, testDb } from '../helpers/testdb';

import { expect, test } from './helpers/basis';
import { imBrowserAnmelden, konsoleUeberwachen } from './helpers/browser';

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

/**
 * Der Detektor ist da, die Kamera aber scheitert mit einem `DOMException`
 * des genannten Namens — so, wie Chromium eine verweigerte Berechtigung
 * (`NotAllowedError`) oder eine fehlende Kamera (`NotFoundError`) meldet.
 * `kameraAnfragen` zählt, wie oft überhaupt gefragt wurde.
 */
async function kameraScheitertMit(page: Page, fehlername: string): Promise<void> {
  await page.addInitScript((name) => {
    class Nachbildung {
      static async getSupportedFormats() {
        return ['qr_code', 'ean_13'];
      }
      async detect() {
        return [];
      }
    }
    Object.defineProperty(window, 'BarcodeDetector', { value: Nachbildung, configurable: true });
    (window as unknown as { kameraAnfragen: number }).kameraAnfragen = 0;
    navigator.mediaDevices.getUserMedia = async () => {
      (window as unknown as { kameraAnfragen: number }).kameraAnfragen += 1;
      throw new DOMException('Permission denied', name);
    };
  }, fehlername);
}

/**
 * Ein Browser **ohne** `BarcodeDetector` — ausdrücklich entfernt, damit der
 * Fall auch auf einem Prüfrechner gilt, dessen Chromium ihn mitbringt (Linux,
 * macOS). `getUserMedia` zählt nur mit: Ohne Erkennung darf gar nicht erst nach
 * der Kamera gefragt werden.
 */
async function ohneDetektor(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'BarcodeDetector', { value: undefined, configurable: true });
    (window as unknown as { kameraAnfragen: number }).kameraAnfragen = 0;
    if (navigator.mediaDevices) {
      navigator.mediaDevices.getUserMedia = async () => {
        (window as unknown as { kameraAnfragen: number }).kameraAnfragen += 1;
        throw new DOMException('nicht erwartet', 'NotAllowedError');
      };
    }
  });
}

const kameraAnfragen = (page: Page) => page.evaluate(() => (window as unknown as { kameraAnfragen: number }).kameraAnfragen);

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

/**
 * Wenn die Kamera nicht will (F-17, 2026-09-27).
 *
 * Die Komponente unterscheidet seit 2026-09-27 verweigert, keine Kamera,
 * belegt und „keine Erkennung" — vorher hiess jeder Fehler „Dieser Browser
 * erkennt keine Codes" und schickte die Person zum falschen Ausweg. Geprüft
 * war das nirgends. Beide Fälle hier müssen ausserdem ohne Seitenfehler
 * ablaufen und die Eingabe offen lassen: Der Handscanner und das Eintippen
 * sind der Weg, der überall funktioniert.
 */
test.describe('Scanplattform — ohne Kamera', () => {
  test('Kamera verweigert (NotAllowedError): klarer Hinweis, kein Strom, die Eingabe bleibt nutzbar', async ({ page }) => {
    const konsole = konsoleUeberwachen(page);
    await kameraScheitertMit(page, 'NotAllowedError');
    await imBrowserAnmelden(page, 'admin', /\/admin/);
    const dialog = await scannerOeffnen(page);

    await dialog.getByRole('button', { name: 'Kamera', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('Der Zugriff auf die Kamera wurde nicht erlaubt');
    // Nicht die Meldung für fehlende Erkennung — das wäre der falsche Ausweg.
    await expect(dialog.getByText('Dieser Browser erkennt keine Codes')).toHaveCount(0);
    expect(await kameraAnfragen(page)).toBe(1);
    expect(await dialog.locator('video').evaluate((v: HTMLVideoElement) => v.srcObject)).toBeNull();
    await expect(dialog.getByRole('button', { name: 'Kamera', exact: true }), 'ein erneuter Versuch bleibt möglich').toBeVisible();

    const feld = dialog.getByLabel('Code eingeben oder einfügen');
    await feld.fill('https://login.example.com/clenaris');
    await feld.press('Enter');
    await expect(dialog.locator('[data-scan-hinweis]')).toContainText('öffnet gescannte Adressen nicht');
    konsole.keineFehler();
  });

  test('BarcodeDetector fehlt: kein Kameraknopf, Hinweis auf Eingabe und Handscanner — die Kamera wird nie gefragt', async ({ page }) => {
    const konsole = konsoleUeberwachen(page);
    await ohneDetektor(page);
    await imBrowserAnmelden(page, 'admin', /\/admin/);
    const dialog = await scannerOeffnen(page);

    await expect(dialog.getByText('Dieser Browser erkennt keine Codes über die Kamera.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Kamera', exact: true })).toHaveCount(0);
    await expect(dialog.getByText('Bild', { exact: true })).toHaveCount(0);
    expect(await kameraAnfragen(page)).toBe(0);

    // Der Weg ohne Kamera — Eingabe wie von einem Handscanner, mit Enter.
    const feld = dialog.getByLabel('Code eingeben oder einfügen');
    await feld.pressSequentially('https://login.example.com/clenaris');
    await feld.press('Enter');
    await expect(dialog.locator('[data-scan-hinweis]')).toContainText('öffnet gescannte Adressen nicht');
    expect(await kameraAnfragen(page)).toBe(0);
    konsole.keineFehler();
  });
});

/**
 * Der Scanner auf dem Telefon (F-17). Dieselbe Übernahme wie in
 * `gate4d-abnahme.spec.ts`: Bildschirm, Pixeldichte, Kennung und Berührung
 * von `Pixel 7`, ohne `defaultBrowserType` — ein Browserwechsel innerhalb
 * einer Gruppe verlangte einen eigenen Worker. Was damit **nicht** bewiesen
 * ist: eine echte Telefonkamera und ein echter Detektor (E-2).
 */
const { defaultBrowserType: _browsertyp, ...telefon } = devices['Pixel 7'];

test.describe('Scanplattform — auf dem Telefon', () => {
  test.use(telefon);

  test('Pixel 7: Scanner öffnen, Kamera → Erkennung, der Dialog passt auf den Bildschirm', async ({ page }) => {
    const konsole = konsoleUeberwachen(page);
    await kameraNachbilden(page, 'https://login.example.com/clenaris');
    await imBrowserAnmelden(page, 'manager', /\/admin/);
    const vorher = page.url();

    const dialog = await scannerOeffnen(page);
    await dialog.getByRole('button', { name: 'Kamera', exact: true }).tap();
    await expect(dialog.locator('[data-scan-hinweis]')).toContainText('öffnet gescannte Adressen nicht');
    // Erkannt, nicht geöffnet — und die Kamera ist danach wieder aus.
    expect(page.url()).toBe(vorher);
    expect(await dialog.locator('video').evaluate((v: HTMLVideoElement) => v.srcObject)).toBeNull();

    const breite = page.viewportSize()!.width;
    const rahmen = (await dialog.boundingBox())!;
    expect(rahmen.x, 'der Dialog beginnt links ausserhalb des Bildschirms').toBeGreaterThanOrEqual(0);
    expect(rahmen.x + rahmen.width, 'der Dialog ragt rechts über den Bildschirm').toBeLessThanOrEqual(breite + 1);
    // Eingabefeld und „Suchen" vollständig sichtbar — der Weg ohne Kamera
    // muss auch auf dem Telefon ohne seitliches Verschieben erreichbar sein.
    const feld = (await dialog.getByLabel('Code eingeben oder einfügen').boundingBox())!;
    expect(feld.x + feld.width).toBeLessThanOrEqual(breite + 1);
    const suchen = (await dialog.getByRole('button', { name: 'Suchen' }).boundingBox())!;
    expect(suchen.x + suchen.width, '„Suchen" liegt ausserhalb des Bildschirms').toBeLessThanOrEqual(breite + 1);
    konsole.keineFehler();
  });
});

/**
 * Der Scanner im Mitarbeiterportal (F-17). Im Portal löst er nur eigene
 * Einsätze und deren Objekte auf (`scan.service.ts`), mit Links ins Portal —
 * `tests/api/scan.test.ts` prüft das am Endpunkt; hier im Browser, über die
 * Kamera, mit der Oberfläche des Portals.
 */
test.describe('Scanplattform — Mitarbeiterportal', () => {
  test('Portal: der eigene Einsatz per Kamera — Link ins Portal und „Einstempeln"; ein fremder Einsatz löst nichts auf', async ({ page }) => {
    test.skip(!db, 'Keine Testdatenbank.');
    const organizationId = (await eigeneOrganisationId())!;
    const person = await db!.employee.findFirst({ where: { user: { email: ACCOUNTS.employee.email } }, select: { id: true } });
    const eigener = await db!.job.findFirst({
      where: { organizationId, deletedAt: null, assignments: { some: { employeeId: person?.id ?? '__' } }, status: { in: ['SCHEDULED', 'DISPATCHED'] } },
      select: { id: true, number: true },
    });
    const fremder = await db!.job.findFirst({
      where: { organizationId, deletedAt: null, assignments: { none: { employeeId: person?.id ?? '__' } } },
      select: { id: true, number: true },
    });
    test.skip(!eigener || !fremder, 'Demobestand ohne passende Einsätze.');

    const konsole = konsoleUeberwachen(page);
    await kameraNachbilden(page, eigener!.number);
    await imBrowserAnmelden(page, 'employee', /\/portal/);
    const vorher = page.url();

    const dialog = await scannerOeffnen(page);
    await dialog.getByRole('button', { name: 'Kamera', exact: true }).click();
    const treffer = dialog.locator('[data-scan-treffer="EINSATZ"]');
    await expect(treffer).toHaveCount(1);
    await expect(treffer.getByRole('link', { name: 'Öffnen' })).toHaveAttribute('href', `/portal/einsaetze/${eigener!.id}`);
    await expect(treffer.getByRole('button', { name: 'Einstempeln' })).toBeVisible();
    expect(await dialog.locator('a[href^="/admin"]').count(), 'ein Link in die Verwaltung im Portal').toBe(0);
    // Erkannt heisst nicht eingestempelt und nicht geöffnet.
    expect(page.url()).toBe(vorher);
    expect(await db!.timeEntry.count({ where: { jobId: eigener!.id, employeeId: person!.id, createdAt: { gte: new Date(Date.now() - 60_000) } } })).toBe(0);

    const feld = dialog.getByLabel('Code eingeben oder einfügen');
    await feld.fill(fremder!.number);
    await feld.press('Enter');
    await expect(dialog.locator('[data-scan-eingabe]')).toContainText(fremder!.number);
    await expect(dialog.locator('[data-scan-treffer]')).toHaveCount(0);
    konsole.keineFehler();
  });
});
