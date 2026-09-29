/**
 * Standard-Vorschaubild der Website erzeugen (2026-09-29, SEO-06).
 *
 *   npx tsx scripts/vorschaubild-erzeugen.ts      # schreibt public/og-standard.png
 *
 * Geteilte Links (Messenger, soziale Netzwerke) zeigen ohne `og:image` eine
 * leere Karte. Ein gestaltetes Motiv gibt es im Repository nicht — nur die
 * freigegebene Bildmarke (`src/app/icon.svg`). Das Vorschaubild ist deshalb
 * **keine neue Gestaltung**, sondern diese Marke mit dem Namen der Website,
 * in den Farben der Marke, im Format 1200 × 630, das die Plattformen
 * erwarten.
 *
 * Als Datei im Repository statt zur Laufzeit erzeugt: kein Endpunkt, keine
 * Rechenzeit je Abruf, und das Bild ist in der Durchsicht sichtbar. Wer die
 * Marke ändert, führt dieses Skript erneut aus. Eine Seite mit eigenem
 * Vorschaubild aus dem CMS behält ihres — dieses gilt nur, wo keines
 * gepflegt ist (`src/lib/seo/metadaten.ts`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import sharp from 'sharp';

const WURZEL = process.cwd();
const ZIEL = join(WURZEL, 'public', 'og-standard.png');

// Bildmarke aus der freigegebenen Datei, nur ohne ihre eigene Rahmengrösse.
const marke = readFileSync(join(WURZEL, 'src', 'app', 'icon.svg'), 'utf8')
  .replace(/^<svg[^>]*>/, '')
  .replace(/<\/svg>\s*$/, '');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="hsl(180 20% 99%)"/>
  <g transform="translate(284 195) scale(7.5)" fill="none">${marke}</g>
  <text x="564" y="350" font-family="Bricolage Grotesque, Archivo, Segoe UI, Helvetica, Arial, sans-serif" font-size="96" font-weight="700" fill="hsl(185 85% 25%)">Clenaris</text>
</svg>`;

async function main() {
  await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(ZIEL);
  const { width, height } = await sharp(ZIEL).metadata();
  process.stdout.write(`✓ public/og-standard.png — ${width} × ${height}\n`);
}

void main();
