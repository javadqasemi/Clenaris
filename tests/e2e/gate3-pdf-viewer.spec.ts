import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Page } from '@playwright/test';

import { expect, test } from './helpers/basis';
import {
  imBrowserAnmelden,
  konsoleUeberwachen,
  netzUeberwachen,
  type Netzwache,
} from './helpers/browser';
import {
  dokumentAnlegen,
  dokumentEntfernen,
  frischAnmelden,
  pdfHochladen,
} from './helpers/bestand';
import { mehrseitigesPdf, pdfMitJavaScript } from './helpers/pdf-fixtures';

/**
 * Gate 3 im echten Browser — der Nachweis, der bisher fehlte.
 *
 * `tests/api/pdf-auslieferung.test.ts` prüft, **was der Server liefert**:
 * `application/pdf`, `nosniff`, nie `public`, Worker und wasm aus dem eigenen
 * Ursprung, keine Ablagekennung im HTML. `tests/api/pdf-viewer-mathematik.ts`
 * prüft die Rechnung hinter Zoom und Seitenwahl. Beides bleibt — und beides
 * lässt die eine Frage offen, an der ein PDF-Viewer scheitert: Startet der
 * Worker unter der ausgelieferten CSP, und erscheint eine Seite?
 *
 * Diese Datei beantwortet sie mit einem Browser: eigens erzeugtes PDF mit
 * bekannter Seitenzahl, echtes Rendern, gezählte Netzanfragen.
 */

const PDFJS_VERSION = readFileSync(join(process.cwd(), 'public', 'pdfjs', 'VERSION'), 'utf8').trim();

const SEITEN = 3;

let adminJar = '';
let dokumentId = '';
let skriptDokumentId = '';

test.beforeAll(async () => {
  adminJar = await frischAnmelden('admin');

  const bytes = await mehrseitigesPdf(SEITEN, 'Gate 3 — Browserprüfung');
  dokumentId = await dokumentAnlegen(
    await pdfHochladen(bytes, 'gate3-browserpruefung.pdf', adminJar),
    `Gate-3-Browserprüfung ${Date.now()}`,
    adminJar,
  );

  const skriptBytes = await pdfMitJavaScript();
  skriptDokumentId = await dokumentAnlegen(
    await pdfHochladen(skriptBytes, 'gate3-pdf-javascript.pdf', adminJar),
    `Gate-3-PDF-JavaScript ${Date.now()}`,
    adminJar,
  );
});

test.afterAll(async () => {
  if (dokumentId) await dokumentEntfernen(dokumentId, adminJar);
  if (skriptDokumentId) await dokumentEntfernen(skriptDokumentId, adminJar);
});

// ---------------------------------------------------------------------------
//  Werkzeuge
// ---------------------------------------------------------------------------

const viewer = (page: Page) => page.locator('[data-pdf-viewer]');
const leinwand = (page: Page) => viewer(page).locator('canvas').first();

/** Wartet, bis eine Seite tatsächlich gerastert auf der Leinwand steht. */
async function warteAufGerenderteSeite(page: Page): Promise<void> {
  await expect(leinwand(page)).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => (await leinwand(page).boundingBox())?.width ?? 0, { timeout: 30_000 })
    .toBeGreaterThan(100);
}

/**
 * Ein Fingerabdruck der gerasterten Seite und wie viel davon nicht weiss ist.
 *
 * Die Leinwand ist gleichen Ursprungs — die Bytes kommen über `fetch` aus
 * derselben Anwendung —, deshalb lässt sie sich auslesen. Ohne diese Messung
 * wäre „das PDF ist sichtbar" nur die Aussage, dass ein `<canvas>` im DOM
 * steht; ein leeres wäre dort genauso.
 */
async function seitenbild(page: Page): Promise<{ breite: number; hoehe: number; gefuellt: number; summe: number }> {
  return leinwand(page).evaluate((element) => {
    const leinwandElement = element as HTMLCanvasElement;
    const kontext = leinwandElement.getContext('2d', { willReadFrequently: true });
    if (!kontext) throw new Error('Kein 2D-Kontext auf der Leinwand.');
    const daten = kontext.getImageData(0, 0, leinwandElement.width, leinwandElement.height).data;

    let gefuellt = 0;
    let summe = 0;
    // Jeder 97. Bildpunkt: genug für eine Aussage, ohne Megapixel zu zählen.
    for (let i = 0; i < daten.length; i += 4 * 97) {
      const r = daten[i]!;
      const g = daten[i + 1]!;
      const b = daten[i + 2]!;
      if (r < 240 || g < 240 || b < 240) gefuellt += 1;
      summe = (summe * 31 + r + g * 3 + b * 7) % 2_147_483_647;
    }
    return { breite: leinwandElement.width, hoehe: leinwandElement.height, gefuellt, summe };
  });
}

/** Die Zoomstufe, wie sie die Werkzeugleiste nennt. */
async function zoomProzent(page: Page): Promise<number> {
  const text = await viewer(page).getByRole('button', { name: /^Zoom \d+ Prozent/ }).textContent();
  return Number.parseInt((text ?? '').replace('%', ''), 10);
}

function pdfjsAnfragen(netz: Netzwache, muster: RegExp) {
  return netz.treffer(muster).filter((e) => e.status !== null);
}

// ---------------------------------------------------------------------------
//  § 5, § 6 — Rendern, Worker, Hilfsdateien, CSP
// ---------------------------------------------------------------------------

test('rendert ein kontrolliertes PDF, startet den Worker aus dem eigenen Ursprung und fragt keinen Dritten', async ({
  page,
  context,
  baseURL,
}) => {
  const konsole = konsoleUeberwachen(page);
  const netz = netzUeberwachen(context);

  await imBrowserAnmelden(page, 'admin', /\/admin/);
  await page.goto(`/admin/fuehrung/dokumente/${dokumentId}`);
  await warteAufGerenderteSeite(page);

  // — Die Seite ist sichtbar, nicht nur vorhanden.
  const bild = await seitenbild(page);
  expect(bild.breite, 'Die Leinwand hat keine Breite.').toBeGreaterThan(200);
  expect(bild.gefuellt, 'Die gerasterte Seite ist vollständig weiss — es wurde nichts gezeichnet.').toBeGreaterThan(20);

  // — Die Seitenzahl stimmt mit dem erzeugten Objekt überein.
  await expect(viewer(page).locator('#pdf-seiten-total')).toHaveText(`/ ${SEITEN}`);

  // — Der Worker: eigener Ursprung, versionierter Pfad, HTTP 200.
  const worker = pdfjsAnfragen(netz, /\/pdfjs\/[^/]+\/pdf\.worker\.min\.mjs/);
  expect(worker.length, 'Der PDF.js-Worker wurde nie geladen.').toBeGreaterThan(0);
  for (const eintrag of worker) {
    expect(eintrag.status, `Worker antwortete mit ${eintrag.status}`).toBe(200);
    expect(new URL(eintrag.url).origin).toBe(new URL(baseURL!).origin);
    expect(eintrag.url).toContain(`/pdfjs/${PDFJS_VERSION}/`);
  }

  /**
   * — Und *alles*, was sonst noch unter `/pdfjs/` angefragt wurde, kam
   * ebenfalls von hier und mit 200. Welche Hilfsdateien das sind, entscheidet
   * das Dokument: cmaps nur bei CJK-Zeichensätzen, wasm nur bei
   * JPEG-2000/JBIG2, Standardschriften nur für nicht eingebettete Schriften —
   * gemessen lädt PDF.js 6 für dieses Objekt keine davon nach. Die Zusicherung
   * ist deshalb nicht „sie werden geladen", sondern „nichts unter diesem Pfad
   * kommt von woanders"; dass sie ausgeliefert *werden*, prüft der nächste
   * Fall.
   */
  for (const eintrag of pdfjsAnfragen(netz, /\/pdfjs\//)) {
    expect(eintrag.status, `${eintrag.url} antwortete mit ${eintrag.status}`).toBe(200);
    expect(new URL(eintrag.url).origin).toBe(new URL(baseURL!).origin);
  }

  // — Kein einziger fremder Ursprung, also insbesondere kein CDN.
  expect(netz.fremdeUrspruenge(baseURL!), 'Es wurde ein fremder Ursprung angefragt.').toEqual([]);

  // — Keine CSP-Verletzung, kein Worker-Fehler, kein wasm-Fehler.
  expect(
    konsole.fehler.filter((f) => /Content Security Policy|refused to|worker|wasm|WebAssembly/i.test(f)),
    'CSP- oder Worker-Fehler in der Konsole.',
  ).toEqual([]);
  konsole.keineFehler();

  // — Die Ablagekennung taucht im HTML nicht auf (der Befund aus `datei-zugriff.test.ts`).
  const html = await page.content();
  expect(html, 'Eine /api/files/blob/<id>-Adresse steht im ausgelieferten HTML.').not.toContain('/api/files/blob/');

  // — Die Bytes selbst kamen über den autorisierten Endpunkt.
  const dokumentAbrufe = pdfjsAnfragen(netz, new RegExp(`/api/bi/documents/${dokumentId}/content`));
  expect(dokumentAbrufe.length).toBeGreaterThan(0);
  expect(dokumentAbrufe[0]!.status).toBe(200);

  /**
   * — Und sie kamen **vollständig** an.
   *
   * Der Fehler, den dieser Fall festhält: Trifft `application/pdf` auf eine
   * `Content-Disposition`, übernimmt Chromiums PDF-Plugin den Datenstrom und
   * beantwortet den `fetch()` des Viewers mit einem leeren 204. Der Viewer
   * meldete dann „Datei nicht lesbar" — in jedem echten Chrome und Edge, und
   * in keiner einzigen Prüfung, weil beide Ebenen ohne PDF-Plugin liefen.
   *
   * Geprüft wird deshalb der Abruf so, wie der Viewer ihn stellt: Status,
   * Content-Type und tatsächliche Byte-Länge. Ein 204 fiele hier sofort auf.
   */
  const abruf = await page.evaluate(async (id) => {
    const antwort = await fetch(`/api/bi/documents/${id}/content?version=1`, {
      credentials: 'same-origin',
      headers: { Accept: 'application/pdf' },
    });
    const bytes = new Uint8Array(await antwort.arrayBuffer());
    return {
      status: antwort.status,
      typ: antwort.headers.get('content-type'),
      disposition: antwort.headers.get('content-disposition'),
      laenge: bytes.byteLength,
      kopf: String.fromCharCode(...bytes.slice(0, 5)),
    };
  }, dokumentId);

  expect(abruf.status, 'Der Abruf des Viewers wurde abgefangen.').toBe(200);
  expect(abruf.typ).toBe('application/pdf');
  expect(abruf.disposition, 'Ein Abruf des Viewers darf keine Content-Disposition bekommen.').toBeNull();
  expect(abruf.laenge).toBeGreaterThan(1000);
  expect(abruf.kopf).toBe('%PDF-');
});

test('liefert wasm und cmaps aus demselben Ursprung aus, falls ein Dokument sie braucht', async ({
  page,
  context,
  baseURL,
}) => {
  /**
   * Die Hilfsdateien für JPEG-2000/JBIG2 (`wasm/`) und CJK-Zeichensätze
   * (`cmaps/`) lädt PDF.js nur bei Bedarf nach — ein Prüfobjekt, das beide
   * erzwingt, wäre ein Binärblob, den niemand mehr lesen kann. Geprüft wird
   * deshalb die Zusicherung selbst: Sie liegen unter derselben versionierten
   * Adresse, die `PDFJS_OPTIONS` konfiguriert, und werden vom eigenen
   * Ursprung mit 200 ausgeliefert.
   */
  netzUeberwachen(context);
  await imBrowserAnmelden(page, 'admin', /\/admin/);

  for (const pfad of [
    `/pdfjs/${PDFJS_VERSION}/wasm/openjpeg.wasm`,
    `/pdfjs/${PDFJS_VERSION}/wasm/qcms_bg.wasm`,
    `/pdfjs/${PDFJS_VERSION}/cmaps/UniJIS-UCS2-H.bcmap`,
    `/pdfjs/${PDFJS_VERSION}/standard_fonts/LiberationSans-Regular.ttf`,
  ]) {
    const antwort = await context.request.get(pfad);
    expect(antwort.status(), `${pfad} antwortete mit ${antwort.status()}`).toBe(200);
    expect(new URL(antwort.url()).origin).toBe(new URL(baseURL!).origin);
  }
});

// ---------------------------------------------------------------------------
//  § 7 — PDF-JavaScript
// ---------------------------------------------------------------------------

test('führt in ein PDF eingebettetes JavaScript nicht aus', async ({ page, context }) => {
  const konsole = konsoleUeberwachen(page);
  const netz = netzUeberwachen(context);

  /**
   * Ein Dialog wäre der sichtbarste Beweis des Gegenteils — und er würde die
   * Automatisierung blockieren. Deshalb wird er hier abgefangen und als
   * Fehlschlag festgehalten, statt darauf zu hoffen, dass keiner kommt.
   */
  const dialoge: string[] = [];
  page.on('dialog', async (dialog) => {
    dialoge.push(`${dialog.type()}: ${dialog.message()}`);
    await dialog.dismiss();
  });

  await imBrowserAnmelden(page, 'admin', /\/admin/);
  await page.goto(`/admin/fuehrung/dokumente/${skriptDokumentId}`);
  await warteAufGerenderteSeite(page);

  // Das Dokument rendert — die Aktion wird ignoriert, nicht die Datei verworfen.
  await expect(viewer(page).locator('#pdf-seiten-total')).toHaveText('/ 1');
  expect((await seitenbild(page)).gefuellt).toBeGreaterThan(5);

  expect(dialoge, 'Das eingebettete PDF-JavaScript hat einen Dialog erzeugt.').toEqual([]);

  /**
   * Der zweite, unabhängige Beleg: PDF.js lädt seine Skript-Sandbox erst,
   * wenn `enableScripting` wahr ist. `scripts/copy-pdfjs-assets.ts` kopiert
   * sie gar nicht erst nach `public/` — eine versehentlich eingeschaltete
   * Option hinterliesse also eine sichtbare Anfrage, die es hier nie gibt.
   */
  expect(netz.treffer(/sandbox/i).map((e) => e.url), 'Die Skript-Sandbox von PDF.js wurde angefragt.').toEqual([]);
  expect(netz.treffer(/quickjs/i).map((e) => e.url), 'Die Skript-Laufzeit von PDF.js wurde angefragt.').toEqual([]);

  // Und der Titel, den das Skript hätte setzen wollen, steht nirgends.
  expect(await page.content()).not.toContain('AUSGEFUEHRT');
  konsole.keineFehler();
});

// ---------------------------------------------------------------------------
//  § 8 — Bedienung
// ---------------------------------------------------------------------------

test('lässt sich im Browser bedienen: blättern, Seite eingeben, zoomen, anpassen, herunterladen, Tastatur', async ({
  page,
  context,
}) => {
  const konsole = konsoleUeberwachen(page);
  netzUeberwachen(context);

  await imBrowserAnmelden(page, 'admin', /\/admin/);
  await page.goto(`/admin/fuehrung/dokumente/${dokumentId}`);
  await warteAufGerenderteSeite(page);

  const seitenfeld = viewer(page).locator('#pdf-seite');
  const bildSeite1 = await seitenbild(page);

  // — Nächste Seite: nicht nur die Ziffer, auch das Bild ändert sich.
  await viewer(page).getByRole('button', { name: 'Nächste Seite' }).click();
  await expect(seitenfeld).toHaveValue('2');
  await expect.poll(async () => (await seitenbild(page)).summe).not.toBe(bildSeite1.summe);

  // — Vorherige Seite.
  await viewer(page).getByRole('button', { name: 'Vorherige Seite' }).click();
  await expect(seitenfeld).toHaveValue('1');

  // — Direkte Seiteneingabe.
  await seitenfeld.fill(String(SEITEN));
  await seitenfeld.press('Enter');
  await expect(seitenfeld).toHaveValue(String(SEITEN));
  await expect(viewer(page).getByRole('button', { name: 'Nächste Seite' })).toBeDisabled();

  // — Zoom.
  await viewer(page).getByRole('button', { name: 'An Breite anpassen' }).click();
  const anBreite = await zoomProzent(page);

  await viewer(page).getByRole('button', { name: 'Vergrössern' }).click();
  expect(await zoomProzent(page)).toBeGreaterThan(anBreite);

  await viewer(page).getByRole('button', { name: 'Verkleinern' }).click();
  await viewer(page).getByRole('button', { name: 'Verkleinern' }).click();
  expect(await zoomProzent(page)).toBeLessThan(anBreite + 1);

  // — „Ganze Seite" ist kleiner als „an Breite", weil A4 höher als breit ist.
  await viewer(page).getByRole('button', { name: 'Ganze Seite anzeigen' }).click();
  await expect(viewer(page).getByRole('button', { name: 'Ganze Seite anzeigen' })).toHaveAttribute('aria-pressed', 'true');
  expect(await zoomProzent(page)).toBeLessThan(anBreite);

  // — Tastatur: Home, Ende, Pfeiltasten. Der Rahmen ist fokussierbar.
  await viewer(page).click({ position: { x: 5, y: 60 } });
  await viewer(page).press('Home');
  await expect(seitenfeld).toHaveValue('1');
  await viewer(page).press('ArrowRight');
  await expect(seitenfeld).toHaveValue('2');
  await viewer(page).press('ArrowLeft');
  await expect(seitenfeld).toHaveValue('1');
  await viewer(page).press('End');
  await expect(seitenfeld).toHaveValue(String(SEITEN));

  // — Herunterladen: das echte Ereignis des Browsers, nicht nur ein `href`.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    viewer(page).getByRole('link', { name: 'PDF herunterladen' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.pdf$/);

  konsole.keineFehler();
});

test('schaltet den Viewer in den Vollbildmodus und wieder zurück', async ({ page }) => {
  const konsole = konsoleUeberwachen(page);

  await imBrowserAnmelden(page, 'admin', /\/admin/);
  await page.goto(`/admin/fuehrung/dokumente/${dokumentId}`);
  await warteAufGerenderteSeite(page);

  const schalter = viewer(page).getByRole('button', { name: 'Vollbild', exact: true });
  await schalter.click();
  await expect
    .poll(async () => page.evaluate(() => Boolean(document.fullscreenElement)), { timeout: 10_000 })
    .toBe(true);

  await viewer(page).getByRole('button', { name: 'Vollbild beenden' }).click();
  await expect
    .poll(async () => page.evaluate(() => Boolean(document.fullscreenElement)), { timeout: 10_000 })
    .toBe(false);

  konsole.keineFehler();
});

// ---------------------------------------------------------------------------
//  § 26 — Zugänglichkeit, nur als Rauchprobe
// ---------------------------------------------------------------------------

test('gibt jedem Bedienelement des Viewers einen zugänglichen Namen und einen Tastaturfokus', async ({ page }) => {
  await imBrowserAnmelden(page, 'admin', /\/admin/);
  await page.goto(`/admin/fuehrung/dokumente/${dokumentId}`);
  await warteAufGerenderteSeite(page);

  // Jede Schaltfläche der Werkzeugleiste hat einen Namen.
  const werkzeugleiste = viewer(page).getByRole('toolbar', { name: 'PDF-Werkzeuge' });
  await expect(werkzeugleiste).toBeVisible();

  const ohneNamen = await werkzeugleiste.evaluate((leiste) =>
    [...leiste.querySelectorAll('button, a')]
      .filter((element) => {
        const name =
          element.getAttribute('aria-label')?.trim() ||
          (element.textContent ?? '').replace(/\s+/g, ' ').trim();
        return name.length === 0;
      })
      .map((element) => element.outerHTML.slice(0, 120)),
  );
  expect(ohneNamen, 'Bedienelemente ohne zugänglichen Namen.').toEqual([]);

  // Das Seitenfeld hat ein Label, auch wenn es nur für Vorleseprogramme sichtbar ist.
  await expect(viewer(page).getByLabel('Seite', { exact: true })).toBeVisible();

  // Der Zustand wird in Worten angesagt.
  await expect(viewer(page).locator('[aria-live="polite"]')).toContainText(/Seite \d+ von \d+/);

  // Der Anzeigebereich selbst ist per Tastatur erreichbar und beschriftet.
  await expect(viewer(page)).toHaveAttribute('aria-label', /PDF-Ansicht/);
  await viewer(page).focus();
  expect(await page.evaluate(() => document.activeElement?.hasAttribute('data-pdf-viewer'))).toBe(true);
});
