/**
 * Hydration messen — eine Seite N-mal im echten Chromium laden und jeden
 * Fehler #418 samt der DOM-Veränderungen davor festhalten.
 *
 *   npx tsx scripts/hydration-messung.ts --pfad /portal/einsaetze/<id> --konto employee --anzahl 200
 *   npx tsx scripts/hydration-messung.ts --seite portal-einsatz --anzahl 400
 *
 * ---------------------------------------------------------------------------
 *  Warum dieses Skript im Repository liegt
 * ---------------------------------------------------------------------------
 *
 * Die Untersuchung von Wave 9.1 hat mit einem Messskript gearbeitet, das nur
 * im Arbeitsverzeichnis der Sitzung lag (`seiten-rate.ts`). Die Zahlen in
 * `docs/HYDRATION.md` liessen sich danach nicht wiederholen (Audit vom
 * 2026-09-23, L-5). Dieses Werkzeug bleibt.
 *
 * ---------------------------------------------------------------------------
 *  Was es misst
 * ---------------------------------------------------------------------------
 *
 *  • Je Ladevorgang ein **frischer Browserkontext** — kalter HTTP-Speicher,
 *    so wie bei einem ersten Aufruf. Angemeldet wird einmal über die Maske;
 *    die Cookies gehen als Ausgangszustand in jeden Kontext.
 *  • Ein `MutationObserver` **ab dem ersten Skript** (an `document`, nicht an
 *    `documentElement` — das gibt es beim Init-Skript noch nicht), der jede
 *    Einfügung und Entfernung mit Zeitstempel festhält. So hat Wave 9.1 das
 *    versteckte Formularfeld von Radix gefunden: Der Endzustand zeigt nur
 *    Folgen, die Reihenfolge zeigt die Ursache.
 *  • `pageerror` und Konsolenfehler, gefiltert auf #418 und Hydration.
 *
 * **Keine Inhalte.** Festgehalten werden Tag, Kennung, bis zu drei Klassen,
 * die Namen der Attribute und einige unkritische Attributwerte (`type`,
 * `form`, `role`, `data-slot`, `data-state`) — nie Text, nie Werte von
 * Eingabefeldern, nie Bilder. Die Befunde enthalten damit keine Namen oder
 * Adressen aus dem Testbestand (anders als `tests/e2e/helpers/diagnose.ts`,
 * siehe `docs/HYDRATION.md`).
 *
 * Vorausgesetzt: ein Testserver auf `--basis` (Vorgabe `http://127.0.0.1:3001`)
 * und die Playwright-Browser (`npx playwright install chromium`).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { chromium, type BrowserContext } from '@playwright/test';

import { MUTATIONS_BEOBACHTER } from '../tests/e2e/helpers/mutations-beobachter';
import { ACCOUNTS } from '../tests/helpers/accounts';

const argv = process.argv.slice(2);
const wert = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
};

const basis = wert('--basis') ?? 'http://127.0.0.1:3001';
const anzahl = Number.parseInt(wert('--anzahl') ?? '100', 10);
const kontoArg = (wert('--konto') ?? 'employee') as keyof typeof ACCOUNTS;
/**
 * `--warm`: **ein** Kontext, N-mal neu geladen — mit gefülltem HTTP-Speicher.
 *
 * Der Unterschied ist nicht kosmetisch. Die Browserreihe traf #418 auf
 * `/admin/vertraege/‹id›` bei `page.reload()`, während 150 kalte
 * Ladevorgänge derselben Seite sauber blieben: Mit warmem Speicher liegen die
 * Skripte vor dem Dokument bereit, und die Hydration beginnt, während der
 * Parser noch arbeitet — ein anderes Zeitfenster als beim ersten Aufruf.
 */
const warm = argv.includes('--warm');

/**
 * `--cpu N`: den Hauptthread per CDP um den Faktor N drosseln.
 *
 * Kein Nachbau eines langsamen Geräts um seiner selbst willen, sondern ein
 * Hebel auf das Zeitfenster: Gedrosselt beginnt die Hydration später, und die
 * Frage „was ist bis dahin mit dem Dokument geschehen" wird von der Ausnahme
 * zur Regel.
 */
const cpu = Number.parseFloat(wert('--cpu') ?? '1');

/**
 * `--skripte-behalten`: Das Gegenexperiment. Webpacks Chunk-Lader entfernt
 * ein `<script>` nach dem Laden aus `<head>` — auch die vom Server
 * ausgelieferten. Mit diesem Schalter wird genau diese eine Entfernung
 * verhindert, sonst nichts. Sinkt die Rate damit auf null, ist sie die
 * Ursache; bleibt sie, ist die Hypothese widerlegt.
 */
const skripteBehalten = argv.includes('--skripte-behalten');

/**
 * `--skripte-frueh-entfernen`: Die Gegenrichtung. Jedes `<script src>` in
 * `<head>` wird unmittelbar nach seinem Laden entfernt — das, was webpack
 * tut, aber immer vor der Hydration statt nur im seltenen schnellen Fall.
 * Macht das den Fehler zur Regel, ist der Mechanismus bewiesen.
 */
const skripteFrueh = argv.includes('--skripte-frueh-entfernen');
const SKRIPTE_FRUEH = `(() => {
  new MutationObserver((liste) => {
    for (const m of liste) for (const n of m.addedNodes) {
      if (n.nodeName === 'SCRIPT' && n.src && n.parentNode === document.head) {
        n.addEventListener('load', () => n.parentNode && n.parentNode.removeChild(n));
      }
    }
  }).observe(document, { childList: true, subtree: true });
})();`;
const SKRIPTE_BEHALTEN = `(() => {
  const original = Node.prototype.removeChild;
  Node.prototype.removeChild = function (kind) {
    if (this === document.head && kind && kind.nodeName === 'SCRIPT' && kind.src) return kind;
    return original.call(this, kind);
  };
})();`;

/** Das Init-Skript: dasselbe wie in der Browserreihe, siehe `mutations-beobachter.ts`. */
const BEOBACHTER = MUTATIONS_BEOBACHTER;

interface Mutation {
  zeit: number;
  art: string;
  knoten?: string;
  unter?: string;
}

async function anmelden(): Promise<Awaited<ReturnType<BrowserContext['storageState']>>> {
  const browser = await chromium.launch({ channel: 'chromium' });
  const context = await browser.newContext({ baseURL: basis, locale: 'de-CH', timezoneId: 'Europe/Zurich' });
  const page = await context.newPage();
  const { email, password } = ACCOUNTS[kontoArg];
  await page.goto('/auth/anmelden');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[autocomplete="current-password"]').fill(password);
  await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/auth'), { timeout: 30_000 });
  const zustand = await context.storageState();
  await browser.close();
  return zustand;
}

async function pfadAufloesen(zustand: Awaited<ReturnType<typeof anmelden>>): Promise<string> {
  const direkt = wert('--pfad');
  if (direkt) return direkt;
  const seite = wert('--seite');
  const browser = await chromium.launch({ channel: 'chromium' });
  const context = await browser.newContext({ baseURL: basis, storageState: zustand });
  const page = await context.newPage();
  await page.goto('/');
  const holen = async (url: string) => page.evaluate(async (u) => (await fetch(u)).json(), url);
  try {
    if (seite === 'portal-einsatz') {
      await page.goto('/portal/einsaetze');
      const href = await page.locator('a[href^="/portal/einsaetze/"]').first().getAttribute('href');
      if (!href) throw new Error('Kein Einsatz in der Liste');
      return href;
    }
    if (seite === 'vertrag') {
      const antwort = (await holen('/api/contracts?pageSize=1')) as { data: { contracts: { id: string }[] } };
      const id = antwort.data.contracts[0]?.id;
      if (!id) throw new Error('Kein Vertrag');
      return `/admin/vertraege/${id}`;
    }
    return seite ? `/${seite.replace(/^\//, '')}` : '/portal';
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const zustand = await anmelden();
  const pfad = await pfadAufloesen(zustand);
  console.log(
    `\n  Messung: ${pfad} · ${anzahl} Ladevorgänge (${warm ? 'warm, neu geladen' : 'kalt, je frischer Kontext'})` +
      ` · CPU ÷${cpu}${skripteBehalten ? ' · Skripte behalten' : ''} · Konto ${kontoArg}\n`,
  );

  const browser = await chromium.launch({ channel: 'chromium' });
  const befunde: Array<{ nummer: number; fehler: string[]; mutationen: Mutation[] }> = [];
  const unauffaellig: Mutation[][] = [];

  const neueSeite = async () => {
    const context = await browser.newContext({ baseURL: basis, storageState: zustand, locale: 'de-CH', timezoneId: 'Europe/Zurich' });
    await context.addInitScript(BEOBACHTER);
    if (skripteBehalten) await context.addInitScript(SKRIPTE_BEHALTEN);
    if (skripteFrueh) await context.addInitScript(SKRIPTE_FRUEH);
    const page = await context.newPage();
    if (cpu > 1) {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
    }
    const fehler: string[] = [];
    page.on('pageerror', (e) => {
      if (/418|hydrat/i.test(e.message)) fehler.push(e.message.slice(0, 200));
    });
    page.on('console', (m) => {
      if (m.type() === 'error' && /418|hydrat/i.test(m.text())) fehler.push(m.text().slice(0, 200));
    });
    return { context, page, fehler };
  };
  const dauerhaft = warm ? await neueSeite() : null;
  if (dauerhaft) await dauerhaft.page.goto(pfad, { waitUntil: 'load' });

  for (let i = 1; i <= anzahl; i++) {
    const { context, page, fehler } = dauerhaft ?? (await neueSeite());
    fehler.length = 0;
    // Kein festes Warten: `load` und danach ein freier Leerlauf-Slot des
    // Hauptthreads heissen, dass die Hydration durch ist. Nicht
    // `networkidle` — die Glocke fragt regelmässig nach, und das Netz wird
    // auf diesen Seiten nie ruhig genug (ein warmer Lauf brauchte zehn
    // Sekunden je Ladevorgang).
    if (dauerhaft) await page.reload({ waitUntil: 'load' });
    else await page.goto(pfad, { waitUntil: 'load' });
    await page.evaluate(() => new Promise<void>((fertig) => requestIdleCallback(() => fertig(), { timeout: 5_000 })));
    const mutationen = (await page.evaluate(() => (window as unknown as { __hydrationsMutationen: Mutation[] }).__hydrationsMutationen)) ?? [];
    if (new URL(page.url()).pathname.startsWith('/auth')) throw new Error('Abgemeldet — Sitzung abgelaufen, Messung abbrechen und neu starten.');
    if (fehler.length > 0) befunde.push({ nummer: i, fehler: [...fehler], mutationen });
    else if (unauffaellig.length < 20) unauffaellig.push(mutationen);
    if (!dauerhaft) await context.close();
    if (i % 25 === 0) process.stdout.write(`  ${i}/${anzahl} · Fehler bisher ${befunde.length}\n`);
  }
  await browser.close();

  // Welche Entfernungen gibt es nur in fehlerhaften Läufen?
  const schluessel = (m: Mutation) => `${m.art} ${m.knoten} unter ${m.unter}`;
  const normal = new Set(unauffaellig.flat().filter((m) => m.art === 'entfernt').map(schluessel));
  const nurBeiFehler = new Map<string, number>();
  for (const b of befunde) {
    for (const m of b.mutationen) {
      if (m.art !== 'entfernt') continue;
      const k = schluessel(m);
      if (!normal.has(k)) nurBeiFehler.set(k, (nurBeiFehler.get(k) ?? 0) + 1);
    }
  }

  const ergebnis = {
    pfad,
    anzahl,
    fehler: befunde.length,
    rate: `${((befunde.length / anzahl) * 100).toFixed(2)} %`,
    nurBeiFehlerEntfernt: [...nurBeiFehler].sort((a, b) => b[1] - a[1]).slice(0, 30),
    befunde,
    vergleich: unauffaellig.slice(0, 3),
  };
  mkdirSync('hydrationsbefunde', { recursive: true });
  const datei = join('hydrationsbefunde', `messung-${Date.now()}.json`);
  writeFileSync(datei, JSON.stringify(ergebnis, null, 2), 'utf8');

  console.log(`\n  Ergebnis: ${befunde.length} von ${anzahl} (${ergebnis.rate})`);
  for (const [k, n] of ergebnis.nurBeiFehlerEntfernt.slice(0, 10)) console.log(`   ${n}× ${k}`);
  console.log(`\n  Befunde: ${datei}\n`);
}

main().catch((fehler) => {
  console.error(fehler);
  process.exit(1);
});
