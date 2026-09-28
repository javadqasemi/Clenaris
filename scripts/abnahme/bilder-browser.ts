/**
 * Abnahme: Bilder der öffentlichen Website in Chromium, Firefox und WebKit —
 * gegen eine **laufende** Instanz, nur lesend (2026-09-28).
 *
 *   ABNAHME_URL=https://… npx tsx scripts/abnahme/bilder-browser.ts [--durchgaenge 3]
 *
 * Wozu: Der Befund „Bilder erscheinen in Firefox erst nach mehrmaligem
 * Neuladen" (docs/PENDENZEN.md, D-01) liess sich lokal nicht nachstellen —
 * `tests/e2e/bilder.browser.spec.ts` ist in allen drei Engines grün. Was die
 * lokale Umgebung nicht hat, sind Cloudflare, https, die echte Galerie und
 * echte Zwischenspeicher. Dieses Skript bringt dieselbe Prüfung dorthin,
 * **ohne** etwas zu schreiben: keine Anmeldung, kein Upload, keine Änderung.
 *
 * Je Engine und Seite, je Durchgang in einem frischen Browserkontext (leerer
 * Zwischenspeicher), danach einmal neu geladen (warmer Zwischenspeicher):
 * jedes `<img>` in den sichtbaren Bereich, dann `complete`, `naturalWidth`,
 * `naturalHeight`, Status der Bildantwort, `content-type`, `cache-control`,
 * `cf-cache-status`. Ausgabe als Tabelle; Exit 0 nur, wenn kein Bild
 * scheiterte.
 *
 * Braucht die Playwright-Browser: `npm run e2e:install`.
 */
import { chromium, firefox, webkit, type Browser, type Page } from 'playwright';

const basis = process.env.ABNAHME_URL?.replace(/\/$/, '');
if (!basis) {
  console.error('ABNAHME_URL fehlt — eine Abnahme ohne Gegenstelle ist keine.');
  process.exit(2);
}

const durchgaenge = Number(process.argv[process.argv.indexOf('--durchgaenge') + 1]) || 3;
const SEITEN = ['/', '/galerie', '/leistungen', '/ueber-uns', '/kontakt'];

interface Befund {
  engine: string;
  seite: string;
  lage: string;
  src: string;
  ok: boolean;
  details: string;
}

async function pruefen(page: Page, engine: string, seite: string, lage: string, antworten: Map<string, string>): Promise<Befund[]> {
  const anzahl = await page.locator('img').count();
  for (let i = 0; i < anzahl; i++) {
    const bild = page.locator('img').nth(i);
    if (await bild.isVisible().catch(() => false)) await bild.scrollIntoViewIfNeeded().catch(() => undefined);
  }
  await page.waitForFunction(() => Array.from(document.images).every((b) => b.complete), undefined, { timeout: 30_000 }).catch(() => undefined);
  const bilder = await page.evaluate(() =>
    Array.from(document.images).map((b) => ({ src: b.currentSrc || b.src, complete: b.complete, w: b.naturalWidth, h: b.naturalHeight })),
  );
  return bilder.map((b) => ({
    engine,
    seite,
    lage,
    src: b.src,
    ok: b.complete && b.w > 0 && b.h > 0,
    details: `${b.w}×${b.h} ${antworten.get(b.src) ?? '(keine Antwort gesehen)'}`,
  }));
}

async function lauf(name: string, browser: Browser): Promise<Befund[]> {
  const befunde: Befund[] = [];
  for (let d = 1; d <= durchgaenge; d++) {
    for (const seite of SEITEN) {
      const context = await browser.newContext({ locale: 'de-CH' });
      const page = await context.newPage();
      const antworten = new Map<string, string>();
      page.on('response', (r) => {
        if (r.request().resourceType() !== 'image') return;
        const h = r.headers();
        antworten.set(r.url(), `${r.status()} ${h['content-type'] ?? '?'} cc=${h['cache-control'] ?? '-'} cf=${h['cf-cache-status'] ?? '-'}`);
      });
      page.on('requestfailed', (r) => {
        if (r.resourceType() === 'image') antworten.set(r.url(), `ABGEBROCHEN ${r.failure()?.errorText ?? ''}`);
      });
      await page.goto(`${basis}${seite}`, { waitUntil: 'load' });
      befunde.push(...(await pruefen(page, name, seite, `kalt ${d}`, antworten)));
      await page.reload({ waitUntil: 'load' });
      befunde.push(...(await pruefen(page, name, seite, `warm ${d}`, antworten)));
      await context.close();
    }
  }
  return befunde;
}

async function main(): Promise<number> {
  const alle: Befund[] = [];
  for (const [name, engine] of [['chromium', chromium], ['firefox', firefox], ['webkit', webkit]] as const) {
    const browser = await engine.launch();
    try {
      alle.push(...(await lauf(name, browser)));
    } finally {
      await browser.close();
    }
  }

  // Null Bilder sind kein Bestehen: Eine Abnahme, die nichts gesehen hat,
  // hat nichts abgenommen.
  if (alle.length === 0) {
    console.error('Auf keiner Seite ein Bild gefunden — nichts abgenommen.');
    return 3;
  }

  const gescheitert = alle.filter((b) => !b.ok);
  for (const engine of ['chromium', 'firefox', 'webkit']) {
    const eigene = alle.filter((b) => b.engine === engine);
    console.log(`${engine.padEnd(9)} ${eigene.length - eigene.filter((b) => !b.ok).length}/${eigene.length} Bilder dekodiert`);
  }
  if (gescheitert.length) {
    console.log('\nNicht dekodiert:');
    for (const b of gescheitert) console.log(`  ${b.engine} ${b.seite} [${b.lage}] ${b.src} — ${b.details}`);
  }
  return gescheitert.length ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (fehler: unknown) => {
    console.error(fehler);
    process.exit(2);
  },
);
