import type { BrowserContext, Page } from '@playwright/test';
import sharp from 'sharp';

import { BASE_URL, data, patch, post } from '../helpers/client';
import { testDb } from '../helpers/testdb';
import { test, expect } from './helpers/basis';
import { konsoleUeberwachen } from './helpers/browser';
import { frischAnmelden } from './helpers/bestand';

/**
 * Bilder der Website in **allen drei** Engines — Chromium, Firefox, WebKit.
 *
 * Gemeldet (2026-09-28): In Firefox erschienen Bilder, besonders die
 * Vorher-/Nachher-Vergleiche, teilweise erst nach mehrmaligem Neuladen. Diese
 * Datei ist der Regressionsbeweis dafür, dass jedes Bild auf den öffentlichen
 * Seiten beim **ersten** Laden tatsächlich dekodiert und sichtbar ist — nicht
 * bloss, dass seine Adresse 200 antwortet: Ein Statuscode ist kein Bild.
 *
 * Geprüft wird je Bild: Antwort erfolgreich, `complete`, `naturalWidth` und
 * `naturalHeight` > 0, im Layout sichtbar, weder `opacity: 0` noch
 * `visibility: hidden` (an ihm oder einem Vorfahren), keine Konsolen- oder
 * Seitenfehler. Und zwar in den Lagen, in denen der Fehler gemeldet wurde oder
 * sich verstecken könnte: leerer Zwischenspeicher, warmer Zwischenspeicher
 * (Neuladen), direkter Aufruf, Wechsel über einen Link (clientseitig),
 * langsames Netz und Telefonbreite.
 *
 * **Echte Bilddateien.** Der Demobestand verweist auf `/gallery/*.jpg`, die es
 * im Repository nicht gibt (eigener Befund D-03). Geprüft wird deshalb mit
 * zwei echten JPEGs, die hier erzeugt, über den gewöhnlichen Upload-Weg
 * (Ticket → Bytes → Abschluss → Bildfeld) hochgeladen und an den ersten
 * Galerieeintrag gehängt werden — genau der Weg, auf dem ein Betrieb seine
 * Fotos einstellt. Danach wird der alte Stand zurückgeschrieben.
 */

async function jpeg(farbe: { r: number; g: number; b: number }): Promise<Buffer> {
  return sharp({ create: { width: 1600, height: 1000, channels: 3, background: farbe } })
    .jpeg({ quality: 82, progressive: true })
    .toBuffer();
}

async function galeriebildHochladen(bytes: Buffer, name: string, jar: string): Promise<string> {
  const ticket = await post<{ data: { ticketId: string; signedUrl: string } }>(
    '/api/files/upload-url',
    { profile: 'gallery', filename: name, mimeType: 'image/jpeg', sizeBytes: bytes.byteLength },
    { jar },
  );
  if (ticket.status !== 201) throw new Error(`Upload-Ticket: HTTP ${ticket.status} — ${ticket.text}`);
  const hochgeladen = await fetch(`${BASE_URL}${new URL(data(ticket).signedUrl, BASE_URL).pathname}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/jpeg' },
    body: new Uint8Array(bytes),
  });
  if (hochgeladen.status !== 200) throw new Error(`Upload: HTTP ${hochgeladen.status}`);
  const abschluss = await post<{ data: { id: string; url: string } }>(
    '/api/files/finalize',
    { ticketId: data(ticket).ticketId, filename: name },
    { jar },
  );
  if (abschluss.status !== 201) throw new Error(`Abschluss: HTTP ${abschluss.status} — ${abschluss.text}`);
  return data(abschluss).url;
}

interface Bildbefund {
  src: string;
  complete: boolean;
  naturalWidth: number;
  naturalHeight: number;
  sichtbar: boolean;
  grund: string;
}

/**
 * Jedes `<img>` der Seite einmal in den sichtbaren Bereich holen und dann
 * prüfen. Ein Bild ausserhalb des Fensters darf der Browser später laden —
 * ein Bild, das man angesehen hat, nicht.
 */
async function bilderPruefen(page: Page): Promise<Bildbefund[]> {
  const anzahl = await page.locator('img').count();
  for (let i = 0; i < anzahl; i++) {
    const bild = page.locator('img').nth(i);
    if (await bild.isVisible()) await bild.scrollIntoViewIfNeeded();
  }
  // Warten, bis jedes Bild entschieden ist (geladen oder gescheitert) —
  // gezählt wird danach, nicht mit einer geratenen Pause.
  await page.waitForFunction(
    () => Array.from(document.images).every((b) => b.complete),
    undefined,
    { timeout: 30_000 },
  );
  return page.evaluate(() =>
    Array.from(document.images).map((b) => {
      let grund = '';
      for (let el: Element | null = b; el; el = el.parentElement) {
        const stil = getComputedStyle(el);
        if (stil.visibility === 'hidden') grund = `visibility:hidden an <${el.tagName.toLowerCase()}>`;
        if (stil.display === 'none') grund = `display:none an <${el.tagName.toLowerCase()}>`;
        if (Number(stil.opacity) === 0) grund = `opacity:0 an <${el.tagName.toLowerCase()}>`;
        if (grund) break;
      }
      const r = b.getBoundingClientRect();
      if (!grund && (r.width === 0 || r.height === 0)) grund = 'ohne Ausdehnung';
      return {
        src: b.currentSrc || b.src,
        complete: b.complete,
        naturalWidth: b.naturalWidth,
        naturalHeight: b.naturalHeight,
        sichtbar: !grund,
        grund,
      };
    }),
  );
}

function alleGeladen(befunde: Bildbefund[], lage: string) {
  const kaputt = befunde.filter((b) => !b.complete || b.naturalWidth === 0 || b.naturalHeight === 0);
  expect(kaputt, `${lage}: nicht dekodierte Bilder`).toEqual([]);
  // Unsichtbar ist nur ein Fehler, wenn das Bild sichtbar sein sollte — ein
  // Bild im geschlossenen Menü darf verborgen sein. Die Galeriebilder dürfen
  // es nie.
  const verborgen = befunde.filter((b) => b.src.includes('/api/files/blob/') && !b.sichtbar);
  expect(verborgen, `${lage}: verborgene Galeriebilder`).toEqual([]);
}

function bildantwortenBeobachten(context: BrowserContext) {
  const fehlgeschlagen: string[] = [];
  context.on('response', (antwort) => {
    if (antwort.request().resourceType() === 'image' && antwort.status() >= 400) {
      fehlgeschlagen.push(`${antwort.status()} ${new URL(antwort.url()).pathname}`);
    }
  });
  context.on('requestfailed', (anfrage) => {
    if (anfrage.resourceType() === 'image') fehlgeschlagen.push(`abgebrochen ${new URL(anfrage.url()).pathname}: ${anfrage.failure()?.errorText}`);
  });
  return fehlgeschlagen;
}

test.describe('Bilder der Website', () => {
  let galerieId = '';
  let vorherStand: { beforeUrl: string; afterUrl: string; published: boolean; featured: boolean } | null = null;
  let vorherUrl = '';
  let nachherUrl = '';

  test.beforeAll(async () => {
    const jar = await frischAnmelden('admin');
    const db = testDb();
    if (!db) throw new Error('Keine Testdatenbank.');
    // Der Demobestand veröffentlicht keine Galerie ohne echte Fotos (D-03);
    // dieser Fall veröffentlicht einen Eintrag für die Dauer der Prüfung und
    // setzt danach Bilder, Veröffentlichung und Hervorhebung zurück.
    const eintrag = await db.galleryItem.findFirst({
      orderBy: [{ featured: 'desc' }, { position: 'asc' }],
      select: { id: true, beforeUrl: true, afterUrl: true, published: true, featured: true },
    });
    if (!eintrag) throw new Error('Kein Galerieeintrag im Bestand.');
    galerieId = eintrag.id;
    vorherStand = { beforeUrl: eintrag.beforeUrl, afterUrl: eintrag.afterUrl, published: eintrag.published, featured: eintrag.featured };
    await db.galleryItem.update({ where: { id: galerieId }, data: { published: true, featured: true } });

    vorherUrl = await galeriebildHochladen(await jpeg({ r: 120, g: 110, b: 95 }), 'browserpruefung-vorher.jpg', jar);
    nachherUrl = await galeriebildHochladen(await jpeg({ r: 20, g: 130, b: 140 }), 'browserpruefung-nachher.jpg', jar);
    for (const [field, url] of [['beforeUrl', vorherUrl], ['afterUrl', nachherUrl]] as const) {
      const r = await patch('/api/content/asset', { entity: 'galleryItem', id: galerieId, field, url }, { jar });
      if (r.status !== 200) throw new Error(`Bildfeld ${field}: HTTP ${r.status} — ${r.text}`);
    }
  });

  test.afterAll(async () => {
    if (galerieId && vorherStand) await testDb()?.galleryItem.update({ where: { id: galerieId }, data: vorherStand });
  });

  for (const pfad of ['/', '/galerie']) {
    test(`${pfad}: leerer Zwischenspeicher, dann Neuladen — jedes Bild dekodiert und sichtbar`, async ({ page, context }) => {
      const konsole = konsoleUeberwachen(page);
      const fehlgeschlagen = bildantwortenBeobachten(context);

      await page.goto(pfad);
      const kalt = await bilderPruefen(page);
      alleGeladen(kalt, `${pfad} kalt`);
      if (pfad === '/galerie') {
        expect(kalt.map((b) => new URL(b.src).pathname), 'die hochgeladenen Galeriebilder stehen nicht auf der Seite').toEqual(
          expect.arrayContaining([new URL(vorherUrl, BASE_URL).pathname, new URL(nachherUrl, BASE_URL).pathname]),
        );
      }

      /*
        Neu geladen wird, wenn die Seite ruhig ist — nicht mitten in der
        Preisschätzung, die die Startseite mit der Vorgabe 80 m² sofort
        stellt (2026-09-28). Im Release-Lauf auf frisch gestartetem, kaltem
        Server traf das Neuladen in WebKit einmal eine laufende Schätzung;
        WebKit schrieb dazu „Fetch API cannot load … due to access control
        checks" als Konsolenfehler, den Playwright als `pageerror` meldet.
        Die Anwendung fängt den Abbruch ab (ein abgefangener Netzfehler
        erzeugt in WebKit keinen `pageerror`, nachgemessen); lokal war der
        Zeitpunkt mit schnellem Server nicht zu treffen (Pendenz W-08). Die
        Meldung wird nicht gefiltert — geprüft werden hier Bilder, und ein
        Mensch lädt eine fertige Seite neu.
      */
      await page.waitForLoadState('networkidle');
      await page.reload();
      alleGeladen(await bilderPruefen(page), `${pfad} neu geladen`);

      expect(fehlgeschlagen, 'Bildanfragen gescheitert').toEqual([]);
      konsole.keineFehler();
    });
  }

  test('Wechsel über den Link zur Galerie (clientseitig) — Bilder erscheinen ohne Neuladen', async ({ page, context }) => {
    const konsole = konsoleUeberwachen(page);
    const fehlgeschlagen = bildantwortenBeobachten(context);
    await page.goto('/');
    await page.locator('footer a[href="/galerie"]').first().click();
    await page.waitForURL(/\/galerie$/);
    alleGeladen(await bilderPruefen(page), 'Galerie nach Linkwechsel');
    expect(fehlgeschlagen).toEqual([]);
    konsole.keineFehler();
  });

  test('langsames Netz: Bildbytes kommen 1.5 s verzögert — sie erscheinen trotzdem', async ({ page, context }) => {
    const konsole = konsoleUeberwachen(page);
    const fehlgeschlagen = bildantwortenBeobachten(context);
    await context.route('**/api/files/blob/**', async (route) => {
      await new Promise((fertig) => setTimeout(fertig, 1_500));
      await route.continue();
    });
    await page.goto('/galerie');
    alleGeladen(await bilderPruefen(page), 'Galerie bei langsamem Netz');
    expect(fehlgeschlagen).toEqual([]);
    konsole.keineFehler();
  });

  test('Telefonbreite 390 × 844 — die Vergleichsbilder füllen ihre Fläche', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const konsole = konsoleUeberwachen(page);
    await page.goto('/galerie');
    const befunde = await bilderPruefen(page);
    alleGeladen(befunde, 'Galerie mobil');
    const galerie = page.locator(`img[src="${new URL(vorherUrl, BASE_URL).pathname}"], img[src="${vorherUrl}"]`).first();
    const box = await galerie.boundingBox();
    expect(box && box.width > 300 && box.height > 200, `Vergleichsbild mobil zu klein: ${JSON.stringify(box)}`).toBe(true);
    konsole.keineFehler();
  });
});
