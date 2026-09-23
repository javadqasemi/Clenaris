import { createRequire } from 'node:module';

import type { Page } from '@playwright/test';

import { expect, test } from './helpers/basis';
import { imBrowserAnmelden } from './helpers/browser';

/**
 * Wave 18 — Barrierefreiheit, gemessen mit axe-core im echten Browser.
 *
 * ---------------------------------------------------------------------------
 *  Was geprüft wird — und was nicht
 * ---------------------------------------------------------------------------
 *
 * axe prüft die maschinell prüfbaren Regeln von WCAG 2.1 A/AA auf der
 * gerenderten Seite: Beschriftungen von Feldern und Schaltflächen,
 * Alternativtexte, Überschriftenfolge, Sprachattribut, ARIA-Rollen und
 * -Attribute, Kontraste. Das ist ein Teil der Barrierefreiheit, nicht die
 * ganze: Tastaturbedienung im Ablauf, Verständlichkeit, Fokusführung in
 * Dialogen und Screenreader-Erlebnis prüft keine Maschine. Die Reihe beweist
 * deshalb keine Konformität — sie verhindert Rückschritte bei dem, was sich
 * messen lässt.
 *
 * **Schwelle:** Verstösse der Stufe „critical" und „serious" lassen den Fall
 * scheitern. „moderate" und „minor" werden als Anhang festgehalten.
 */

// Die Browser-Reihe wird als CommonJS übersetzt — daher `__filename`, nicht `import.meta.url`.
const AXE = createRequire(__filename).resolve('axe-core/axe.min.js');

interface Verstoss {
  id: string;
  impact: 'minor' | 'moderate' | 'serious' | 'critical' | null;
  help: string;
  nodes: { target: string[]; kontrast?: string }[];
}

/**
 * Warten, bis die Seite ruhig ist — sonst misst axe Zwischenbilder.
 *
 * Gefunden in der Schlussprüfung (2 von 10 vollen Läufen rot): Das
 * Cookie-Banner erscheint 800 ms nach dem Laden und blendet in 500 ms ein.
 * `networkidle` fiel mal davor, mal mitten hinein; im zweiten Fall mass axe
 * den halb durchsichtigen Link mit 2.5 : 1 statt seiner echten Farbe. Der
 * Fehler lag in der Messung, nicht in der Seite — und eine Reihe, die zufällig
 * rot wird, wird abgeschaltet.
 *
 * Deshalb: auf öffentlichen Seiten erst das Banner abwarten (es gehört zur
 * Seite und wird mitgeprüft), dann alle *endlichen* laufenden Animationen.
 * Unendliche (Laufband, Puls) enden nie und werden übersprungen.
 */
async function ruhigWarten(page: Page, mitBanner: boolean): Promise<void> {
  if (mitBanner) {
    await page.locator('[role="dialog"][aria-labelledby="cookie-title"]').waitFor({ state: 'visible', timeout: 10_000 });
  }
  await page.evaluate(async () => {
    const endliche = document.getAnimations().filter((a) => {
      const zeit = a.effect?.getComputedTiming();
      return a.playState === 'running' && zeit !== undefined && zeit.endTime !== Infinity;
    });
    await Promise.all(endliche.map((a) => a.finished.catch(() => undefined)));
  });
}

async function pruefe(
  page: Page,
  pfad: string,
  testInfo: { attach: (name: string, opts: { body: string; contentType: string }) => Promise<void> },
  mitBanner = false,
) {
  await page.goto(pfad);
  await page.waitForLoadState('networkidle');
  await ruhigWarten(page, mitBanner);
  await page.addScriptTag({ path: AXE });
  const verstoesse = await page.evaluate(async () => {
    type Roh = Omit<Verstoss, 'nodes'> & { nodes: { target: string[]; any: { data?: { fgColor?: string; bgColor?: string; contrastRatio?: number } }[] }[] };
    const axe = (window as unknown as { axe: { run: (ctx: Document, opts: unknown) => Promise<{ violations: Roh[] }> } }).axe;
    const r = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
    return r.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      nodes: v.nodes.slice(0, 5).map((n) => {
        const d = n.any[0]?.data;
        return { target: n.target, kontrast: d?.contrastRatio ? `${d.fgColor} auf ${d.bgColor} = ${d.contrastRatio}` : undefined };
      }),
    }));
  });
  await testInfo.attach(`axe ${pfad}`, { body: JSON.stringify(verstoesse, null, 2), contentType: 'application/json' });
  const schwer = verstoesse.filter((v) => v.impact === 'critical' || v.impact === 'serious');
  return { verstoesse, schwer };
}

const zeile = (pfad: string, v: Verstoss) =>
  `${pfad}: [${v.impact}] ${v.id} — ${v.help} (${v.nodes.map((n) => n.target.join(' ') + (n.kontrast ? ` [${n.kontrast}]` : '')).join(', ')})`;

const OEFFENTLICH = ['/', '/auth/anmelden', '/kontakt', '/offerte'];

test.describe('Barrierefreiheit (axe, WCAG 2.1 A/AA)', () => {
  test('öffentliche Seiten', async ({ page }, testInfo) => {
    const befunde: string[] = [];
    for (const pfad of OEFFENTLICH) {
      // Ohne Entscheidung erscheint das Cookie-Banner auf jeder Seite des
      // `(public)`-Rahmens — nicht auf der Anmeldung, die hat einen eigenen.
      const { schwer } = await pruefe(page, pfad, testInfo, !pfad.startsWith('/auth/'));
      for (const v of schwer) befunde.push(zeile(pfad, v));
    }
    expect(befunde, befunde.join('\n')).toEqual([]);
  });

  test('Verwaltung', async ({ page }, testInfo) => {
    await imBrowserAnmelden(page, 'admin', /\/admin/);
    const befunde: string[] = [];
    for (const pfad of ['/admin', '/admin/rechnungen', '/admin/lohn', '/admin/suche?q=Reinigung', '/admin/reklamationen', '/admin/besichtigungen']) {
      const { schwer } = await pruefe(page, pfad, testInfo);
      for (const v of schwer) befunde.push(zeile(pfad, v));
    }
    expect(befunde, befunde.join('\n')).toEqual([]);
  });

  test('Portal und Kundenbereich', async ({ page, browser }, testInfo) => {
    await imBrowserAnmelden(page, 'employee', /\/portal/);
    const befunde: string[] = [];
    for (const pfad of ['/portal', '/portal/lohn']) {
      const { schwer } = await pruefe(page, pfad, testInfo);
      for (const v of schwer) befunde.push(zeile(pfad, v));
    }
    const kunde = await browser.newContext();
    const kundenSeite = await kunde.newPage();
    await imBrowserAnmelden(kundenSeite, 'customer', /\/konto/);
    for (const pfad of ['/konto', '/konto/reklamationen']) {
      const { schwer } = await pruefe(kundenSeite, pfad, testInfo);
      for (const v of schwer) befunde.push(zeile(pfad, v));
    }
    await kunde.close();
    expect(befunde, befunde.join('\n')).toEqual([]);
  });
});
