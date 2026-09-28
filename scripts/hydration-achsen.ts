/**
 * RB-001 — Reproduktionsmatrix: welche Kombination erzeugt #418?
 *
 *   npx tsx scripts/hydration-achsen.ts --modus login-goto --ziel portal-einsatz --anzahl 40
 *
 * ---------------------------------------------------------------------------
 *  Warum es dieses Skript neben `hydration-messung.ts` gibt
 * ---------------------------------------------------------------------------
 *
 * 610 isolierte Ladevorgänge ergaben 0 Fehler, die Browserreihe dagegen fast
 * in jedem Lauf einen. Die Messung lud mit einem vorbereiteten
 * `storageState`; die Reihe meldet sich **über die Maske** an und ruft
 * unmittelbar danach `page.goto()` auf. Dieses Skript prüft solche Achsen
 * einzeln, mit identischer Instrumentierung für saubere und fehlerhafte
 * Ladevorgänge.
 *
 * Je Ladevorgang festgehalten: Modus, Versuch, Kontext, Adresse beim Fehler,
 * #418 ja/nein, Navigationsart, `readyState` beim Fehler, DOMContentLoaded,
 * load, ob `<link rel=preload as=script>` beim Parsen vorhanden war und wann
 * er verschwand. **Keine** Cookies, Tokens, Inhalte oder Personendaten —
 * Adressen nur als Pfad, Kennungen durch `‹id›` ersetzt.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';

import { ACCOUNTS } from '../tests/helpers/accounts';

const argv = process.argv.slice(2);
const wert = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
};

const basis = wert('--basis') ?? 'http://127.0.0.1:3001';
const anzahl = Number.parseInt(wert('--anzahl') ?? '30', 10);
const modus = wert('--modus') ?? 'login-goto';
const zielArt = wert('--ziel') ?? 'portal-einsatz';

type Konto = keyof typeof ACCOUNTS;
const konto: Konto = zielArt === 'vertrag' ? 'admin' : 'employee';
const landung = konto === 'admin' ? /\/admin/ : /\/portal/;

/** Der Entwicklungsbau übersetzt jede Seite beim ersten Aufruf — dort mehr Zeit. */
const grenzeMs = argv.includes('--langsam') ? 180_000 : 30_000;

/** Die Seite vor dem Ziel (--landung), Vorgabe die Startseite des Bereichs. */
const landeseite = wert('--landung') ?? (konto === 'admin' ? '/admin' : '/portal');

/**
 * Das Init-Skript: nur Zeitpunkte und Ja/Nein, keine Inhalte.
 */
const SONDE = `(() => {
  const t0 = performance.now();
  const z = { preloadGesehen: false, preloadWeg: null, fehler: [], dcl: null, load: null };
  window.__sonde = z;
  const istPreload = (n) => n && n.nodeName === 'LINK' && n.rel === 'preload' && n.getAttribute('as') === 'script';
  new MutationObserver((liste) => {
    for (const m of liste) {
      for (const n of m.addedNodes) if (istPreload(n)) z.preloadGesehen = true;
      for (const n of m.removedNodes) if (istPreload(n) && z.preloadWeg === null) z.preloadWeg = Math.round(performance.now() - t0);
    }
  }).observe(document, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', () => { z.dcl = Math.round(performance.now() - t0); });
  window.addEventListener('load', () => { z.load = Math.round(performance.now() - t0); });
  const aufnehmen = (text) => {
    if (/418|hydrat/i.test(text)) z.fehler.push({ zeit: Math.round(performance.now() - t0), readyState: document.readyState });
  };
  window.addEventListener('error', (e) => aufnehmen(String(e.message || '')));
})();`;

interface Ladevorgang {
  modus: string;
  versuch: number;
  kontext: number;
  pfad: string;
  navigationsart: string | null;
  fehler418: boolean;
  fehlerReadyState: string | null;
  fehlerZeit: number | null;
  dcl: number | null;
  load: number | null;
  preloadGesehen: boolean;
  preloadWeg: number | null;
}

const sicher = (url: string) => {
  try {
    return new URL(url, basis).pathname.replace(/[a-z0-9]{20,}/g, '‹id›');
  } catch {
    return '?';
  }
};

let kontextZaehler = 0;
const ladevorgaenge: Ladevorgang[] = [];

async function neuerKontext(browser: Browser, zustand?: Awaited<ReturnType<BrowserContext['storageState']>>) {
  kontextZaehler += 1;
  const context = await browser.newContext({ baseURL: basis, locale: 'de-CH', timezoneId: 'Europe/Zurich', storageState: zustand });
  await context.route('**/favicon.ico', (r) => r.fulfill({ status: 204, body: '' }));
  await context.addInitScript(SONDE);
  context.setDefaultTimeout(grenzeMs);
  context.setDefaultNavigationTimeout(grenzeMs);
  return { context, id: kontextZaehler };
}

/**
 * `--debugger`: Die Stelle der Abweichung im **Produktionsbau** benennen.
 *
 * React wirft bei einer Abweichung intern `HydrationMismatchException`
 * (Meldung #519) aus `throwOnHydrationMismatch(fiber)`; der eigentliche
 * #418-Fehler wird nur gesammelt. Im Debugger hält die Seite genau dort an,
 * und `arguments[0]` ist der Fiber, an dem die Hydration scheiterte. Gelesen
 * werden nur Struktur und Klassen — Typ, Schlüssel, `className`, die
 * Elternkette und die Kinder des DOM-Elternknotens —, **nie Text**.
 *
 * Kein Eingriff in den Produktionscode, kein Modultausch: Die Anwendung
 * läuft unverändert, nur der Browser schaut hin.
 */
const STELLE_LESEN = `(() => {
  const f = arguments[0];
  const name = (x) => !x ? '?' : typeof x.type === 'string' ? x.type : (x.type && (x.type.displayName || x.type.name)) || ('tag' + x.tag);
  const kls = (x) => {
    const c = x && x.pendingProps && typeof x.pendingProps.className === 'string' ? x.pendingProps.className : '';
    return c ? '.' + c.split(/\\s+/).slice(0, 4).join('.') : '';
  };
  const kette = [];
  for (let x = f, i = 0; x && i < 25; x = x.return, i++) kette.push(name(x) + kls(x) + (x.key ? '#' + String(x.key).slice(0, 20) : ''));
  let eltern = f.return;
  while (eltern && eltern.tag !== 5 && eltern.tag !== 3 && eltern.tag !== 27) eltern = eltern.return;
  const dom = eltern && eltern.stateNode && eltern.stateNode.childNodes ? [...eltern.stateNode.childNodes] : [];
  const beschreibe = (n) => n.nodeType === 1 ? n.tagName.toLowerCase() + (n.getAttribute('class') ? '.' + n.getAttribute('class').split(/\\s+/).slice(0, 3).join('.') : '') + (n.id ? '#' + n.id : '') : n.nodeType === 3 ? '#text' : n.nodeType === 8 ? '#kommentar:' + n.data.slice(0, 6) : '?';
  const geschwister = [];
  for (let s = eltern && eltern.child, i = 0; s && i < 40; s = s.sibling, i++) geschwister.push(name(s) + kls(s));
  // Reacts Modulvariablen im minifizierten Bündel: rN = nextHydratableInstance
  // (der DOM-Knoten, gegen den React hydrieren wollte), rP = hydrationParentFiber.
  let erwartet = 'unbekannt';
  let erwartetGeschwister = [];
  try {
    erwartet = rN ? beschreibe(rN) : 'null (kein Knoten mehr)';
    for (let n = rN, i = 0; n && i < 8; n = n.nextSibling, i++) erwartetGeschwister.push(beschreibe(n));
  } catch (e) { erwartet = 'nicht lesbar: ' + e.message; }
  let parentFiber = 'unbekannt';
  try { parentFiber = rP ? name(rP) + kls(rP) : 'null'; } catch (e) {}
  return JSON.stringify({
    erwarteterDomKnoten: erwartet,
    folgendeDomKnoten: erwartetGeschwister,
    hydrationParentFiber: parentFiber,
    art: arguments.length > 1 && arguments[1] ? 'text' : 'HTML',
    fiber: name(f) + kls(f),
    fiberTag: f.tag,
    props: f.pendingProps ? Object.keys(f.pendingProps).slice(0, 15) : [],
    kette,
    domEltern: eltern ? name(eltern) + kls(eltern) : null,
    domKinder: dom.slice(0, 40).map(beschreibe),
    fiberKinderDesElterns: geschwister,
    readyState: document.readyState,
  });
})()`;

async function debuggerAnhaengen(context: BrowserContext, page: Page, versuch: number) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Debugger.enable');
  /*
    Nicht „bei jeder Ausnahme anhalten": React wirft für Suspense laufend
    Ausnahmen, jedes Anhalten verschiebt die Zeit, und der Fehler verschwand
    (0 von 30). Stattdessen ein Haltepunkt genau in `throwOnHydrationMismatch`
    — er kostet nichts, solange nichts abweicht. Die Spalte ist die von
    `var n=Error(i(418` im React-Chunk dieses Baus (`--spalte`).
  */
  const spalte = Number.parseInt(wert('--spalte') ?? '35055', 10);
  await cdp.send('Debugger.setBreakpointByUrl', {
    urlRegex: wert('--chunk') ?? '4bd1b696-[0-9a-f]+\\.js',
    lineNumber: 0,
    columnNumber: spalte,
  });
  cdp.on('Debugger.paused', async (p) => {
    try {
      if (p.reason !== 'exception') {
        const r = await cdp.send('Debugger.evaluateOnCallFrame', {
          callFrameId: p.callFrames[0]!.callFrameId,
          expression: STELLE_LESEN,
          returnByValue: true,
        });
        const wert = r.result.value as string | undefined;
        console.log(`\n----- Stelle der Abweichung (Versuch ${versuch}, Funktion ${p.callFrames[0]!.functionName}) -----\n${wert ?? JSON.stringify(r.exceptionDetails ?? r.result).slice(0, 500)}\n-----`);
        stellen.push({ versuch, stelle: wert ? JSON.parse(wert) : null });
      }
    } catch (fehler) {
      console.log(`   Debugger: ${(fehler as Error).message}`);
    } finally {
      await cdp.send('Debugger.resume').catch(() => undefined);
    }
  });
}

const stellen: Array<{ versuch: number; stelle: unknown }> = [];

/**
 * `--fehlerstelle`: dieselbe Frage ohne Debugger.
 *
 * Der Debugger allein liess den Fehler verschwinden (0 von 40): V8 übersetzt
 * mit angehängtem Debugger anders, und die Zeit verschiebt sich. Diese Sonde
 * kostet bis zum Fehler nichts: `Error` wird durch einen durchsichtigen Proxy
 * ersetzt (`new`, `instanceof`, Unterklassen bleiben gleich). Erst wenn React
 * die Meldung #418 **erzeugt** — synchron, an der Stelle der Abweichung —,
 * wird das DOM angesehen: React markiert jedes hydrierte Element mit
 * `__reactFiber$…` und schliesst Elemente in Nachordnung ab. Die Grenze
 * zwischen markiert und unmarkiert in Dokumentreihenfolge ist die Stelle.
 * Nur Tag, Klassen, Attributnamen — kein Text.
 */
const FEHLERSTELLE = `(() => {
  const E = window.Error;
  const beschreibe = (n) => n.nodeType === 1
    ? n.tagName.toLowerCase() + (n.getAttribute('class') ? '.' + n.getAttribute('class').split(/\\s+/).slice(0, 3).join('.') : '') + (n.id ? '#' + n.id : '') + '[' + [...n.attributes].map((a) => a.name).filter((a) => a !== 'class' && a !== 'id').slice(0, 6).join(',') + ']'
    : n.nodeType === 3 ? '#text' : n.nodeType === 8 ? '#kommentar' : '?';
  const pfad = (n) => { const t = []; for (let e = n, i = 0; e && e.nodeType === 1 && i < 7; e = e.parentElement, i++) t.unshift(beschreibe(e)); return t.join(' > '); };
  const hydriert = (el) => Object.keys(el).some((k) => k.startsWith('__reactFiber$'));
  const erfassen = () => {
    try {
      const alle = document.body ? [...document.body.querySelectorAll('*')] : [];
      const ohne = alle.filter((el) => !hydriert(el) && el.tagName !== 'SCRIPT' && el.tagName !== 'TEMPLATE');
      const mit = alle.filter(hydriert).length;
      // Die Grenze: das erste unhydrierte Element, das selbst keinen
      // hydrierten Nachfahren hat (Vorfahren sind wegen der Nachordnung noch
      // offen), und das letzte hydrierte davor.
      const grenze = ohne.find((el) => ![...el.querySelectorAll('*')].some(hydriert));
      const index = grenze ? alle.indexOf(grenze) : -1;
      const letzteHydrierte = index > 0 ? alle.slice(0, index).filter(hydriert).slice(-3).map(pfad) : [];
      const danach = index >= 0 ? alle.slice(index, index + 6).map((el) => beschreibe(el) + (hydriert(el) ? ' (h)' : '')) : [];
      window.__grenze = { grenze: grenze ? pfad(grenze) : null, letzteHydrierte, danach, geschwisterDerGrenze: grenze && grenze.parentElement ? [...grenze.parentElement.childNodes].slice(0, 12).map((n) => beschreibe(n) + (n.nodeType === 1 && hydriert(n) ? ' (h)' : '')) : [] };
      const erste = ohne.slice(0, 4).map((el) => ({
        pfad: pfad(el),
        vorigesGeschwister: el.previousSibling ? beschreibe(el.previousSibling) + (el.previousSibling.nodeType === 1 && hydriert(el.previousSibling) ? ' (hydriert)' : '') : null,
      }));
      const kopfOhne = document.head ? [...document.head.children].filter((el) => !hydriert(el)).map(beschreibe).slice(0, 12) : [];
      window.__fehlerstelle = { zeit: Math.round(performance.now()), readyState: document.readyState, elemente: alle.length, hydriert: mit, grenze: window.__grenze, ersteUnhydrierte: erste.slice(0, 1), kopfUnhydriert: kopfOhne.slice(0, 3) };
    } catch (f) { window.__fehlerstelle = { fehler: String(f) }; }
  };
  const pruefen = (args) => { const m = args && args[0]; if (typeof m === 'string' && m.indexOf('#418') >= 0 && !window.__fehlerstelle) erfassen(); };
  // React legt zu jedem gemeldeten Fehler { value, source: fiber, stack } in
  // eine WeakMap (createCapturedValueAtFiber). Next verwirft den
  // Komponentenstapel später — hier wird er abgegriffen, sobald der Schlüssel
  // der #418-Fehler ist. Bis dahin nur ein Typvergleich je Aufruf.
  const setzen = WeakMap.prototype.set;
  const name = (x) => !x ? '?' : typeof x.type === 'string' ? x.type : (x.type && (x.type.displayName || x.type.name)) || ('tag' + x.tag);
  const kls = (x) => { const c = x && x.pendingProps && typeof x.pendingProps.className === 'string' ? x.pendingProps.className : ''; return c ? '.' + c.split(/\\s+/).slice(0, 3).join('.') : ''; };
  WeakMap.prototype.set = function (k, v) {
    if (k instanceof E && v && v.source && typeof k.message === 'string' && k.message.indexOf('#418') >= 0 && !window.__fiberstelle) {
      try {
        const f = v.source;
        const kette = [];
        for (let x = f, i = 0; x && i < 30; x = x.return, i++) kette.push(name(x) + kls(x) + ' [tag ' + x.tag + (x.key ? ', key ' + String(x.key).slice(0, 24) : '') + ']');
        let eltern = f.return;
        while (eltern && eltern.tag !== 5 && eltern.tag !== 3 && eltern.tag !== 27) eltern = eltern.return;
        const geschwister = [];
        for (let s = f.return && f.return.child, i = 0; s && i < 20; s = s.sibling, i++) geschwister.push(name(s) + kls(s) + ' [tag ' + s.tag + ']');
        const domKinder = eltern && eltern.stateNode && eltern.stateNode.childNodes ? [...eltern.stateNode.childNodes].slice(0, 20).map(beschreibe) : [];
        // Was der Fiber als Kinder bekommt — nur die Form, kein Inhalt.
        const form = (c, tiefe) => {
          if (tiefe > 2) return '…';
          if (c === null || c === undefined) return String(c);
          if (Array.isArray(c)) return '[' + c.slice(0, 5).map((x) => form(x, tiefe + 1)).join(', ') + ']';
          if (typeof c !== 'object') return typeof c;
          const art = c.$$typeof ? String(c.$$typeof.description || c.$$typeof) : 'objekt';
          if (art === 'react.lazy') {
            const p = c._payload;
            return 'lazy{status=' + (p && p.status) + ', payload=' + (p && typeof p.then === 'function' ? 'thenable' : typeof p) + '}';
          }
          if (art === 'react.transitional.element' || art === 'react.element') {
            const t = c.type;
            const typ = typeof t === 'string' ? t : t && t.$$typeof ? String(t.$$typeof.description) + (t._payload ? '{status=' + t._payload.status + '}' : '') : t && (t.displayName || t.name) || typeof t;
            return '<' + typ + '>';
          }
          if (typeof c.then === 'function') return 'thenable{status=' + c.status + '}';
          return art;
        };
        window.__fiberstelle = {
          kinderForm: f.pendingProps && typeof f.pendingProps === 'object' ? form(f.pendingProps.children, 0) : null,
          fiberFlags: f.flags,
          fiberHatAlternate: Boolean(f.alternate),
          fiber: name(f) + kls(f) + ' [tag ' + f.tag + ']',
          props: f.pendingProps && typeof f.pendingProps === 'object' ? Object.keys(f.pendingProps).slice(0, 12) : typeof f.pendingProps,
          kette,
          fiberGeschwister: geschwister,
          hostEltern: eltern ? name(eltern) + kls(eltern) : null,
          domKinderDesHostElterns: domKinder,
          komponentenstapel: String(v.stack || '').split('\\n').map((z) => z.trim()).filter(Boolean).slice(0, 30),
        };
      } catch (fehler) { window.__fiberstelle = { fehler: String(fehler) }; }
    }
    return setzen.call(this, k, v);
  };
  window.Error = new Proxy(E, {
    apply(t, th, args) { pruefen(args); return Reflect.apply(t, th, args); },
    construct(t, args, nt) { pruefen(args); return Reflect.construct(t, args, nt); },
  });
})();`;

/** Jeden Dokumentaufruf einer Seite nach seinem Ende auswerten. */
function beobachten(page: Page, versuch: number, kontext: number) {
  const pageerrors: string[] = [];
  page.on('pageerror', (e) => {
    if (/418|hydrat/i.test(e.message)) pageerrors.push(sicher(page.url()));
  });
  /**
   * `--klartext`: Gegen den Entwicklungsbau nennt React die Abweichung samt
   * Komponentenpfad. Die Meldung kann Seitentext enthalten — sie geht deshalb
   * nur ins Terminal, gekürzt, und nie in eine Datei.
   */
  if (argv.includes('--klartext')) {
    page.on('console', (m) => {
      if (m.type() === 'error' && /hydrat|didn't match/i.test(m.text())) {
        pageerrors.push(sicher(page.url()));
        console.log(`\n----- Klartext (Versuch ${versuch}) -----\n${m.text().slice(0, 4000)}\n-----`);
      }
    });
  }
  return async () => {
    try {
      const z = await page.evaluate(() => {
        const w = window as unknown as { __sonde?: Record<string, unknown> };
        const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
        return {
          sonde: w.__sonde ?? null,
          art: nav?.type ?? null,
          stelle: (window as unknown as { __fehlerstelle?: unknown }).__fehlerstelle
            ? {
                dom: (window as unknown as { __fehlerstelle?: unknown }).__fehlerstelle,
                fiber: (window as unknown as { __fiberstelle?: unknown }).__fiberstelle ?? null,
              }
            : null,
        };
      });
      if (z.stelle) {
        stellen.push({ versuch, stelle: z.stelle });
        console.log(`\n----- Fehlerstelle (Versuch ${versuch}) -----\n${JSON.stringify(z.stelle, null, 1).slice(0, 3000)}\n-----`);
      }
      const s = z.sonde as { preloadGesehen: boolean; preloadWeg: number | null; fehler: { zeit: number; readyState: string }[]; dcl: number | null; load: number | null } | null;
      const fehler = s?.fehler?.[0] ?? null;
      ladevorgaenge.push({
        modus,
        versuch,
        kontext,
        pfad: sicher(page.url()),
        navigationsart: z.art,
        fehler418: Boolean(fehler) || pageerrors.includes(sicher(page.url())),
        fehlerReadyState: fehler?.readyState ?? null,
        fehlerZeit: fehler?.zeit ?? null,
        dcl: s?.dcl ?? null,
        load: s?.load ?? null,
        preloadGesehen: s?.preloadGesehen ?? false,
        preloadWeg: s?.preloadWeg ?? null,
      });
    } catch {
      // Seite mitten im Wechsel — dieser Aufruf wird beim nächsten erfasst.
    }
    return pageerrors;
  };
}

async function zielPfad(browser: Browser): Promise<string> {
  const { context } = await neuerKontext(browser);
  const page = await context.newPage();
  await anmelden(page);
  await page.waitForLoadState('load');
  try {
    if (zielArt === 'vertrag') {
      const r = (await page.evaluate(async () => (await fetch('/api/contracts?pageSize=1')).json())) as {
        data: { contracts?: { id: string }[] } | { id: string }[];
      };
      const liste = Array.isArray(r.data) ? r.data : (r.data.contracts ?? []);
      return `/admin/vertraege/${liste[0]!.id}`;
    }
    await page.goto('/portal/einsaetze');
    const href = await page.locator('a[href^="/portal/einsaetze/"]').first().getAttribute('href');
    return href!;
  } finally {
    await context.close();
  }
}

async function anmelden(page: Page): Promise<void> {
  const { email, password } = ACCOUNTS[konto];
  await page.goto('/auth/anmelden');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[autocomplete="current-password"]').fill(password);
  await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
  await page.waitForURL(landung, { timeout: grenzeMs });
}

/** Warten, bis die Seite fertig hydriert hat — ohne feste Zeit. */
async function ruhig(page: Page): Promise<void> {
  await page.waitForLoadState('load');
  await page.evaluate(() => new Promise<void>((f) => requestIdleCallback(() => f(), { timeout: 5_000 })));
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ channel: 'chromium' });
  const pfad = await zielPfad(browser);
  console.log(`\n  Modus ${modus} · Ziel ${sicher(pfad)} · ${anzahl} Versuche\n`);

  // Für die Kontrollgruppe einmal anmelden und den Zustand mitnehmen.
  let zustand: Awaited<ReturnType<BrowserContext['storageState']>> | undefined;
  if (modus.startsWith('state')) {
    const { context } = await neuerKontext(browser);
    const p = await context.newPage();
    await anmelden(p);
    await ruhig(p);
    zustand = await context.storageState();
    await context.close();
  }

  let treffer = 0;
  for (let v = 1; v <= anzahl; v++) {
    const { context, id } = await neuerKontext(browser, zustand);
    const page = await context.newPage();
    if (argv.includes('--debugger')) await debuggerAnhaengen(context, page, v);
    if (argv.includes('--fehlerstelle')) await page.addInitScript(FEHLERSTELLE);
    const auswerten = beobachten(page, v, id);
    try {
      switch (modus) {
        // D1 + C1: wie die Reihe — Maske, sofort danach goto
        case 'login-goto':
          await anmelden(page);
          await page.goto(pfad);
          await ruhig(page);
          break;
        // D1, aber goto erst, wenn die Landeseite ruhig ist
        case 'login-ruhig-goto':
          await anmelden(page);
          await ruhig(page);
          await page.goto(pfad);
          await ruhig(page);
          break;
        // D2 + C1: Kontrollgruppe wie die isolierte Messung
        case 'state-goto':
          await page.goto(pfad);
          await ruhig(page);
          break;
        // D2, erst Landeseite, dann sofort goto (ohne Anmeldung)
        case 'state-landung-goto':
          await page.goto(landeseite);
          await page.goto(pfad);
          await ruhig(page);
          break;
        // Wie oben, aber die Landeseite erst ganz zur Ruhe kommen lassen:
        // trennt „warmer Speicher" von „laufendes Vordokument".
        case 'state-landung-ruhig-goto':
          await page.goto(landeseite);
          await ruhig(page);
          await page.goto(pfad);
          await ruhig(page);
          break;
        // Wie state-landung-goto, aber ohne HTTP-Speicher (CDP): jeder Chunk
        // kommt über das Netz — trennt „warm" von „Vordokument".
        case 'state-landung-goto-ohnespeicher': {
          const cdp = await context.newCDPSession(page);
          await cdp.send('Network.enable');
          await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
          await page.goto(landeseite);
          await page.goto(pfad);
          await ruhig(page);
          break;
        }
        // Warm ohne Vordokument: Landeseite in einer ANDEREN Seite desselben
        // Kontexts laden (füllt den Speicher), dann das Ziel in frischer Seite.
        case 'state-warm-neueseite': {
          const vor = await context.newPage();
          await vor.goto(konto === 'admin' ? '/admin' : '/portal');
          await ruhig(vor);
          await vor.close();
          await page.goto(pfad);
          await ruhig(page);
          break;
        }
        /*
          Deterministischer Versuch: der seiteneigene Chunk
          (`app/…/page-*.js`) kommt `--verzoegerung` ms später. Trifft die
          Hydration dann auf eine noch nicht aufgelöste Client-Referenz, muss
          der Fehler jedes Mal kommen — wenn die Erklärung stimmt.
        */
        case 'state-seitenchunk-verzoegert': {
          const ms = Number.parseInt(wert('--verzoegerung') ?? '1500', 10);
          await page.route(/\/_next\/static\/chunks\/app\/.*\/page-[0-9a-f]+\.js$/, async (route) => {
            await new Promise((f) => setTimeout(f, ms));
            await route.continue();
          });
          await page.goto(pfad);
          await ruhig(page);
          break;
        }
        /*
          Warmer Speicher für die Skripte, langsam fliessendes Dokument: Die
          Skripte laufen sofort aus dem Speicher, die RSC-Blöcke im HTML kommen
          erst mit dem Dokument. React beginnt zu rendern, bevor die Zeile für
          den Seiteninhalt da ist.
        */
        case 'state-warm-drossel': {
          await page.goto(pfad);
          await ruhig(page);
          const cdp = await context.newCDPSession(page);
          await cdp.send('Network.enable');
          await cdp.send('Network.emulateNetworkConditions', {
            offline: false,
            latency: 20,
            downloadThroughput: Number.parseInt(wert('--kbps') ?? '40', 10) * 1024,
            uploadThroughput: 512 * 1024,
          });
          await page.goto(landeseite);
          await page.goto(pfad);
          await ruhig(page);
          break;
        }
        /*
          Der entscheidende Versuch: Die Fehlergrenze des Segments
          (`app/…/error-*.js`) kommt später. Das `LayoutRouter`-Element unter
          `<main>` trägt sie als Prop `error` — bis ihr Chunk da ist, ist das
          ganze Element in Flight blockiert und kommt als `lazy` an.
        */
        case 'state-fehlerchunk-verzoegert': {
          const ms = Number.parseInt(wert('--verzoegerung') ?? '800', 10);
          await page.route(/\/_next\/static\/chunks\/app\/.*\/error-[0-9a-f]+\.js$/, async (route) => {
            await new Promise((f) => setTimeout(f, ms));
            await route.continue();
          });
          await page.goto(pfad);
          await ruhig(page);
          break;
        }
        default:
          throw new Error(`Unbekannter Modus ${modus}`);
      }
    } catch (fehler) {
      console.log(`   Versuch ${v}: ${(fehler as Error).message.split('\n')[0]}`);
    }
    const fehlerSeiten = await auswerten();
    if (fehlerSeiten.length > 0) {
      treffer += 1;
      console.log(`   Versuch ${v}: #418 auf ${fehlerSeiten.join(', ')}`);
    }
    await context.close();
  }
  await browser.close();

  const zeilen = ladevorgaenge.filter((l) => l.pfad === sicher(pfad));
  const tafel = {
    mitPreload418: zeilen.filter((l) => l.preloadGesehen && l.fehler418).length,
    mitPreloadSauber: zeilen.filter((l) => l.preloadGesehen && !l.fehler418).length,
    ohnePreload418: zeilen.filter((l) => !l.preloadGesehen && l.fehler418).length,
    ohnePreloadSauber: zeilen.filter((l) => !l.preloadGesehen && !l.fehler418).length,
  };
  console.log(`\n  Versuche mit #418: ${treffer} von ${anzahl}`);
  console.log('  Kontingenz am Ziel (Preload beim Parsen gesehen × #418):', tafel);

  mkdirSync('hydrationsbefunde', { recursive: true });
  const datei = join('hydrationsbefunde', `achsen-${modus}-${Date.now()}.json`);
  writeFileSync(datei, JSON.stringify({ modus, ziel: sicher(pfad), anzahl, treffer, tafel, ladevorgaenge, stellen }, null, 2), 'utf8');
  console.log(`  Befunde: ${datei}\n`);
}

main().catch((fehler) => {
  console.error(fehler);
  process.exit(1);
});
