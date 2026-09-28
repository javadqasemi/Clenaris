import { readFileSync } from 'node:fs';

import { build } from 'esbuild';

import { expect, test } from './helpers/basis';

/**
 * RB-001 — der Hydrationsfehler #418, deterministisch nachgestellt.
 *
 * ---------------------------------------------------------------------------
 *  Die Ursache (Nachweis in `docs/HYDRATION.md` §16)
 * ---------------------------------------------------------------------------
 *
 * React 19.2 (von Next 15.5 mitgeliefert, `19.2.0-canary-0bdb9206-20250818`)
 * hat einen Fehler beim **Wiederabspielen** eines angehaltenen Host-Elements
 * während der Hydration:
 *
 *  1. `beginWork(<main>)` beansprucht das DOM-Element `<main>` und rückt den
 *     Hydrationszeiger auf dessen erstes Kind vor.
 *  2. Beim Abgleich der Kinder trifft React auf einen `lazy`-Knoten, der noch
 *     nicht aufgelöst ist — so liefert Flight ein Element, dessen
 *     Client-Referenz (hier die Fehlergrenze `error.tsx` des Segments) noch
 *     lädt. React hält an.
 *  3. Ist der Knoten beim Weitermachen aufgelöst, spielt React **dieselbe
 *     Einheit** erneut ab (`replaySuspendedUnitOfWork`) und beansprucht
 *     `<main>` ein zweites Mal — aber der Zeiger steht schon auf dem ersten
 *     Kind. `<p>` ist nicht `<main>` → #418, der ganze Baum wird verworfen.
 *
 * React 19.3 setzt den Zeiger vor dem Wiederabspielen zurück. Diese Reihe
 * prüft, dass die mitgelieferte React-Fassung das ebenfalls tut
 * (`scripts/react-hydrationskorrektur.mjs`).
 *
 * ---------------------------------------------------------------------------
 *  Warum dieser Aufbau deterministisch ist
 * ---------------------------------------------------------------------------
 *
 * In der Anwendung hängt der Fehler von der Zeit ab: Nur wenn der Chunk
 * zwischen Anhalten und Weitermachen eintrifft, spielt React wieder ab; sonst
 * rendert es von der Wurzel neu, und nichts passiert. Hier wird genau diese
 * Lage hergestellt: ein Thenable mit Statusfeld wie ein Flight-Chunk, das in
 * der Mikroaufgabe nach dem ersten Leseversuch erfüllt wird — und hydriert
 * wird wie in Next (`startTransition`, zeitgeteilt).
 *
 * Gebündelt wird **die React-Fassung, die Next tatsächlich ausliefert**
 * (`next/dist/compiled/react-dom`). Ins Testbündel — und nur dorthin — werden
 * drei Protokollzeilen eingefügt. Sie beweisen, dass der Auslöser (das
 * Wiederabspielen von `<main>`) wirklich eingetreten ist. Ein grüner Test
 * ohne diesen Nachweis hätte nichts bewiesen.
 */

const EINSTIEG = `
import React from 'next/dist/compiled/react';
import { hydrateRoot } from 'next/dist/compiled/react-dom/client';
const h = React.createElement;
window.__fehler = [];
window.__protokoll = [];

// Wie ein Flight-Chunk: Thenable mit Statusfeld. React spielt nur wieder ab,
// wenn der Status beim Weitermachen 'fulfilled' ist.
const chunk = { status: 'pending', value: null, then(erfuellt) { this.rueckrufe.push(erfuellt); }, rueckrufe: [] };
const kind = {
  $$typeof: Symbol.for('react.lazy'),
  _payload: chunk,
  _init(c) {
    if (c.status === 'fulfilled') return c.value;
    // Das Modul trifft ein, nachdem React hier angehalten hat.
    queueMicrotask(() => {
      c.status = 'fulfilled';
      c.value = h('p', null, 'inhalt');
      c.rueckrufe.forEach((f) => f(c.value));
    });
    throw c;
  },
};

const baum = h('div', null, h('header', null, 'kopf'), h('main', { id: 'inhalt' }, kind));
React.startTransition(() => {
  hydrateRoot(document.getElementById('wurzel'), baum, {
    onRecoverableError: (e) => window.__fehler.push(String(e && e.message)),
  });
});
`;

const SERVER_HTML =
  '<!doctype html><html><body><div id="wurzel"><div><header>kopf</header><main id="inhalt"><p>inhalt</p></main></div></div></body></html>';

let bundle = '';

test.beforeAll(async () => {
  const ergebnis = await build({
    stdin: { contents: EINSTIEG, resolveDir: process.cwd(), loader: 'js' },
    bundle: true,
    write: false,
    format: 'iife',
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'error',
    plugins: [
      {
        name: 'protokoll-nur-im-testbuendel',
        setup(b) {
          b.onLoad({ filter: /react-dom-client\.production\.js$/ }, (datei) => {
            let quelle = readFileSync(datei.path, 'utf8');
            const einfuegen = (anker: string, zeile: string) => {
              if (!quelle.includes(anker)) throw new Error(`Anker fehlt im React-Bündel: ${anker}`);
              quelle = quelle.replace(anker, `${anker} ${zeile}`);
            };
            einfuegen(
              'function replaySuspendedUnitOfWork(unitOfWork) {',
              'window.__protokoll.push("wiederabspielen:" + unitOfWork.tag + ":" + unitOfWork.type);',
            );
            einfuegen(
              'function throwOnHydrationMismatch(fiber) {',
              'window.__protokoll.push("abweichung:" + fiber.type);',
            );
            return { contents: quelle, loader: 'js' };
          });
        },
      },
    ],
  });
  bundle = ergebnis.outputFiles[0]!.text;
});

test('spielt ein angehaltenes <main> während der Hydration wieder ab, ohne Abweichung', async ({ page }) => {
  for (let lauf = 1; lauf <= 5; lauf++) {
    await page.setContent(SERVER_HTML);
    await page.addScriptTag({ content: bundle });
    // Kein festes Warten: fertig ist die Hydration, wenn <p> sein Fiber hat.
    await page.waitForFunction(() => {
      const p = document.querySelector('#inhalt > p');
      return Boolean(p && Object.keys(p).some((k) => k.startsWith('__reactFiber$')));
    });

    const { protokoll, fehler } = await page.evaluate(() => ({
      protokoll: (window as unknown as { __protokoll: string[] }).__protokoll,
      fehler: (window as unknown as { __fehler: string[] }).__fehler,
    }));

    expect(
      protokoll,
      `Lauf ${lauf}: Der Auslöser trat nicht ein — ohne Wiederabspielen von <main> beweist der Fall nichts.`,
    ).toContain('wiederabspielen:5:main');
    expect(protokoll, `Lauf ${lauf}: React hat <main> beim Wiederabspielen verfehlt.`).not.toContain(
      'abweichung:main',
    );
    expect(fehler, `Lauf ${lauf}: Hydrationsfehler`).toEqual([]);
  }
});
