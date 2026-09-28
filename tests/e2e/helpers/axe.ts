import { createRequire } from 'node:module';

import type { Page, TestInfo } from '@playwright/test';

/**
 * axe-core im echten Browser — gemeinsam für die Barrierefreiheitsreihen
 * (Wave 18) und die Oberflächenprüfung (Phase 21/22). Vorher stand der Helfer
 * nur in `wave18-barrierefreiheit.spec.ts`; eine zweite Kopie wäre beim
 * nächsten Messfehler (siehe `ruhigWarten`) nur an einer Stelle behoben
 * worden.
 */

// Die Browser-Reihe wird als CommonJS übersetzt — daher `__filename`, nicht `import.meta.url`.
const AXE = createRequire(__filename).resolve('axe-core/axe.min.js');

export interface Verstoss {
  id: string;
  impact: 'minor' | 'moderate' | 'serious' | 'critical' | null;
  help: string;
  nodes: { target: string[]; kontrast?: string }[];
}

/**
 * Warten, bis die Seite ruhig ist — sonst misst axe Zwischenbilder.
 *
 * Gefunden in der Schlussprüfung von Wave 18 (2 von 10 vollen Läufen rot):
 * Das Cookie-Banner erscheint 800 ms nach dem Laden und blendet in 500 ms
 * ein. `networkidle` fiel mal davor, mal mitten hinein; im zweiten Fall mass
 * axe den halb durchsichtigen Link mit 2.5 : 1 statt seiner echten Farbe.
 *
 * Deshalb: auf öffentlichen Seiten erst das Banner abwarten (es gehört zur
 * Seite und wird mitgeprüft), dann alle *endlichen* laufenden Animationen.
 * Unendliche (Laufband, Puls) enden nie und werden übersprungen.
 */
export async function ruhigWarten(page: Page, mitBanner: boolean): Promise<void> {
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

/** axe auf der aktuellen Seite ausführen (WCAG 2.1 A/AA); der Befund hängt am Fall. */
export async function axeMessen(page: Page, name: string, testInfo: Pick<TestInfo, 'attach'>): Promise<{ verstoesse: Verstoss[]; schwer: Verstoss[] }> {
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
  await testInfo.attach(`axe ${name}`, { body: JSON.stringify(verstoesse, null, 2), contentType: 'application/json' });
  return { verstoesse, schwer: verstoesse.filter((v) => v.impact === 'critical' || v.impact === 'serious') };
}

/** Seite laden, ruhig werden lassen, messen. */
export async function pruefe(page: Page, pfad: string, testInfo: Pick<TestInfo, 'attach'>, mitBanner = false) {
  await page.goto(pfad);
  await page.waitForLoadState('networkidle');
  await ruhigWarten(page, mitBanner);
  return axeMessen(page, pfad, testInfo);
}

export const zeile = (pfad: string, v: Verstoss) =>
  `${pfad}: [${v.impact}] ${v.id} — ${v.help} (${v.nodes.map((n) => n.target.join(' ') + (n.kontrast ? ` [${n.kontrast}]` : '')).join(', ')})`;
