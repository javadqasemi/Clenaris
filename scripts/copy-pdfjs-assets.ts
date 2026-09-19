/**
 * PDF.js-Laufzeitdateien aus dem installierten Paket nach `public/` legen.
 *
 * **Warum kopieren statt CDN.** Der Worker muss *exakt* zur installierten
 * `pdfjs-dist`-Version passen — schon eine Nebenversion daneben, und die
 * Seite rendert nichts oder falsch. Ein CDN kann eine andere Version
 * liefern, kann ausfallen, verrät jedem Betreiber, welche Dokumente hier
 * angesehen werden, und brauchte eine Ausnahme in der CSP. Aus dem eigenen
 * Ursprung ausgeliefert gilt `script-src 'self'`, und die Version steht im
 * Pfad, damit ein Zwischenspeicher beim nächsten Upgrade nichts Altes
 * behält.
 *
 * **Warum ein Skript und nicht `new URL(…, import.meta.url)`.** Der Worker
 * allein liesse sich so bündeln. Die Hilfsdateien für JPEG-2000-Bilder
 * (`wasm/`), CJK-Zeichensätze (`cmaps/`) und Standardschriften
 * (`standard_fonts/`) sind Verzeichnisse, die PDF.js zur Laufzeit per Pfad
 * nachlädt — ein Bundler kann Verzeichnisse nicht adressieren. Ein
 * Kopiervorgang deckt alle vier gleich ab und verhält sich in `next dev`
 * (Turbopack) und im Produktionsbuild identisch.
 *
 * Läuft vor `dev`, `build` und `start`. `public/pdfjs/` ist nicht im
 * Repository: Es ist Ableitung, kein Quelltext.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const wurzel = process.cwd();
const paket = join(wurzel, 'node_modules', 'pdfjs-dist');

if (!existsSync(paket)) {
  console.error('pdfjs-dist ist nicht installiert — `npm install` zuerst.');
  process.exit(1);
}

const { version } = JSON.parse(readFileSync(join(paket, 'package.json'), 'utf8')) as {
  version: string;
};

const ziel = join(wurzel, 'public', 'pdfjs', version);
const basis = join(wurzel, 'public', 'pdfjs');

// Alte Versionen entfernen: Nur die installierte darf liegen bleiben, sonst
// merkt niemand, wenn der Viewer versehentlich eine alte anspricht.
if (existsSync(basis)) rmSync(basis, { recursive: true, force: true });
mkdirSync(ziel, { recursive: true });

const teile: Array<[string, string]> = [
  [join('build', 'pdf.worker.min.mjs'), 'pdf.worker.min.mjs'],
  ['wasm', 'wasm'],
  ['cmaps', 'cmaps'],
  ['standard_fonts', 'standard_fonts'],
];

for (const [quelle, name] of teile) {
  const von = join(paket, quelle);
  if (!existsSync(von)) {
    console.error(`Fehlt im Paket: ${quelle}`);
    process.exit(1);
  }
  cpSync(von, join(ziel, name), { recursive: true });
}

// Die Version als Datei, damit sie sich ohne Paketimport nachschlagen lässt —
// etwa in einer Prüfung, die den ausgelieferten Pfad kontrolliert.
writeFileSync(join(basis, 'VERSION'), `${version}\n`, 'utf8');

console.log(`✓ PDF.js ${version}: Worker, wasm, cmaps und Standardschriften nach public/pdfjs/${version}/`);
