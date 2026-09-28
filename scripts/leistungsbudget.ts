/**
 * Leistungsbudget — was sich **ohne** Stoppuhr messen lässt (2026-09-28).
 *
 *   npx tsx scripts/leistungsbudget.ts                  # JS je Route gegen das Budget
 *   npx tsx scripts/leistungsbudget.ts --html           # dazu HTML je Seite (TEST_BASE_URL)
 *   npx tsx scripts/leistungsbudget.ts --messen         # nur messen, Tabelle ausgeben
 *
 * `scripts/leistungsmessung.ts` misst Antwortzeiten und sagt ausdrücklich, warum
 * es daraus keine Testschwelle macht: Millisekunden hängen an Maschine,
 * Datenbestand und Nebenlast. Diese Datei nimmt die andere Hälfte — Grössen,
 * die auf jeder Maschine gleich herauskommen:
 *
 *  • **First-Load-JavaScript je Route**, gzip, aus dem Bauverzeichnis
 *    (`app-build-manifest.json`: jede Layout- und Seitenstufe mit ihren
 *    Chunks, vereinigt entlang des Pfads). Ein Diagramm-Paket, das
 *    versehentlich in den gemeinsamen Rahmen rutscht, oder ein `'use client'`
 *    zu viel an einer Seite fällt hier auf, bevor es jemand im Feld merkt.
 *  • **HTML-Grösse je Seite** (angemeldet, gegen einen laufenden Server). Die
 *    einzige Seite, die je wirklich langsam war (`/portal/einsaetze`, 1.4 MB
 *    HTML, `docs/LEISTUNG.md`), war es wegen der Menge an gerendertem HTML —
 *    genau das misst diese Zahl.
 *
 * Das Budget steht in `scripts/leistungsbudget.json`: gemessener Stand beim
 * Festlegen plus Spielraum. Überschreitet eine Route es, endet das Skript mit
 * 1 und nennt sie. Ein Budget wird bewusst erhöht (mit Begründung im Commit),
 * nie still.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const WURZEL = join(__dirname, '..');
const BAU = join(WURZEL, process.env.NEXT_DIST_DIR?.trim() || '.next');
const BUDGETDATEI = join(__dirname, 'leistungsbudget.json');

interface Budget {
  stand: string;
  erlaeuterung: string;
  jsKb: Record<string, number>;
  htmlKb: Record<string, { konto: 'admin' | 'employee' | 'customer' | null; kb: number }>;
}

/** Routen, deren JS gemessen wird — Anzeigepfad → Segment im Manifest. */
const ROUTEN: Record<string, string> = {
  '/': '/(public)/page',
  '/buchen': '/(public)/buchen/page',
  '/kontakt': '/(public)/kontakt/page',
  '/admin': '/(app)/admin/page',
  '/admin/kunden': '/(app)/admin/kunden/page',
  '/admin/offerten': '/(app)/admin/offerten/page',
  '/admin/offerten/[id]/bearbeiten': '/(app)/admin/offerten/[id]/bearbeiten/page',
  '/admin/vertraege': '/(app)/admin/vertraege/page',
  '/admin/einsaetze': '/(app)/admin/einsaetze/page',
  '/admin/rechnungen': '/(app)/admin/rechnungen/page',
  '/admin/personal': '/(app)/admin/personal/page',
  '/admin/lohn': '/(app)/admin/lohn/page',
  '/admin/suche': '/(app)/admin/suche/page',
  '/admin/auswertungen': '/(app)/admin/auswertungen/page',
  '/admin/fuehrung': '/(app)/admin/fuehrung/page',
  '/portal': '/(app)/portal/page',
  '/konto': '/(app)/konto/page',
};

function manifestLesen(): Record<string, string[]> {
  const pfad = join(BAU, 'app-build-manifest.json');
  if (!existsSync(pfad)) {
    console.error(`Kein Bau in ${BAU} (app-build-manifest.json fehlt) — erst \`npm run build\`.`);
    process.exit(2);
  }
  return (JSON.parse(readFileSync(pfad, 'utf8')) as { pages: Record<string, string[]> }).pages;
}

const gzipCache = new Map<string, number>();
function gzipGroesse(datei: string): number {
  const bekannt = gzipCache.get(datei);
  if (bekannt !== undefined) return bekannt;
  const groesse = gzipSync(readFileSync(join(BAU, datei))).byteLength;
  gzipCache.set(datei, groesse);
  return groesse;
}

/**
 * Alle Layoutstufen über einer Seite: `/(app)/admin/kunden/page` →
 * `/layout`, `/(app)/layout`, `/(app)/admin/layout`, `/(app)/admin/kunden/layout`.
 */
function stufen(seite: string): string[] {
  const teile = seite.replace(/\/page$/, '').split('/').filter(Boolean);
  const layouts = ['/layout'];
  for (let i = 1; i <= teile.length; i++) layouts.push(`/${teile.slice(0, i).join('/')}/layout`);
  return [...layouts, seite];
}

function jsKb(manifest: Record<string, string[]>, seite: string): number | null {
  if (!manifest[seite]) return null;
  const dateien = new Set<string>();
  for (const stufe of stufen(seite)) for (const d of manifest[stufe] ?? []) if (d.endsWith('.js')) dateien.add(d);
  let bytes = 0;
  for (const d of dateien) bytes += gzipGroesse(d);
  return Math.round(bytes / 102.4) / 10;
}

async function htmlKb(pfad: string, konto: 'admin' | 'employee' | 'customer' | null): Promise<number> {
  const { get } = await import('../tests/helpers/client');
  const { loginAs } = await import('../tests/helpers/accounts');
  const jar = konto ? await loginAs(konto) : undefined;
  const antwort = await get(pfad, jar ? { jar } : undefined);
  if (antwort.status !== 200) throw new Error(`${pfad}: HTTP ${antwort.status}`);
  return Math.round(Buffer.byteLength(antwort.text) / 102.4) / 10;
}

async function main(): Promise<number> {
  const nurMessen = process.argv.includes('--messen');
  const mitHtml = process.argv.includes('--html');
  const budget = JSON.parse(readFileSync(BUDGETDATEI, 'utf8')) as Budget;
  const manifest = manifestLesen();
  const verstoesse: string[] = [];

  console.log('First-Load-JavaScript je Route (gzip, kB)');
  for (const [anzeige, seite] of Object.entries(ROUTEN)) {
    const kb = jsKb(manifest, seite);
    if (kb === null) {
      verstoesse.push(`${anzeige}: Seite fehlt im Bau (${seite}) — Route umbenannt? Budget nachführen.`);
      continue;
    }
    const grenze = budget.jsKb[anzeige];
    const marke = grenze === undefined ? 'kein Budget' : kb > grenze ? `ÜBER ${grenze}` : `≤ ${grenze}`;
    console.log(`  ${anzeige.padEnd(34)} ${kb.toFixed(1).padStart(7)}  ${marke}`);
    if (!nurMessen && grenze !== undefined && kb > grenze) verstoesse.push(`${anzeige}: ${kb} kB JS > Budget ${grenze} kB`);
    if (!nurMessen && grenze === undefined) verstoesse.push(`${anzeige}: kein JS-Budget in leistungsbudget.json`);
  }

  if (mitHtml) {
    console.log('\nHTML je Seite (kB, angemeldet)');
    for (const [pfad, { konto, kb: grenze }] of Object.entries(budget.htmlKb)) {
      const kb = await htmlKb(pfad, konto);
      const marke = kb > grenze ? `ÜBER ${grenze}` : `≤ ${grenze}`;
      console.log(`  ${pfad.padEnd(34)} ${kb.toFixed(1).padStart(7)}  ${marke}`);
      if (!nurMessen && kb > grenze) verstoesse.push(`${pfad}: ${kb} kB HTML > Budget ${grenze} kB`);
    }
  }

  if (verstoesse.length) {
    console.error(`\nBudget überschritten:\n  - ${verstoesse.join('\n  - ')}`);
    return 1;
  }
  console.log(nurMessen ? '\nGemessen (ohne Bewertung).' : '\nAlle Budgets eingehalten.');
  return 0;
}

main().then(
  (code) => process.exit(code),
  (fehler: unknown) => {
    console.error(fehler);
    process.exit(2);
  },
);
