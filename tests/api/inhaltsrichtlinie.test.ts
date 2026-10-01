import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as nextKonstanten from 'next/constants';

import konfiguration from '../../next.config';
import { inhaltsrichtlinie } from '../../src/lib/security/inhaltsrichtlinie';
import { get, requireServer } from '../helpers/client';

/**
 * Inhaltsrichtlinie ohne `'unsafe-eval'` (2026-09-30).
 *
 * Bis hierher sah keine Prüfung in die `Content-Security-Policy` hinein; die
 * Betriebsüberwachung (`ops/security-monitor/security_check.sh`) stellt nur
 * fest, dass der Kopf da ist und `frame-ancestors` trägt. Die Richtlinie
 * stand als Zeichenkette in `next.config.ts` und trug `'unsafe-eval'` — gegen
 * `docs/SECURITY_STANDARD.md` (C6), der es ausdrücklich verbietet — und
 * dreizehn Quelleneinträge für Dienste, die der Browser in dieser Anwendung
 * nie anspricht (Stripe.js, Google-Maps-Bibliothek, Supabase Realtime, Google
 * Fonts, eingebettete Google-Inhalte).
 *
 * Zwei Ebenen, wie bei den Rechenkernen:
 *
 *  • **Der Baustein** (`src/lib/security/inhaltsrichtlinie.ts`) und seine
 *    Verdrahtung in `next.config.ts` — direkt importiert, ohne Server. Die
 *    Konfiguration wird dabei in jeder Phase aufgerufen, die Next kennt, weil
 *    genau die Phase entscheidet, ob `'unsafe-eval'` dabei ist.
 *  • **Der ausgelieferte Kopf** am laufenden Produktionsbau — auf einer Seite,
 *    einer API-Antwort, einer Datei aus `/_next/static` und dem Worker von
 *    PDF.js. Der Worker steht ausdrücklich in der Liste: Er bekommt die
 *    Richtlinie seiner eigenen Antwort, und in ihm übersetzt PDF.js sein
 *    WebAssembly.
 *
 * Ob der Browser die Richtlinie auch so *durchsetzt*, wie sie hier steht —
 * `eval` verweigert, WebAssembly übersetzt —, prüft
 * `tests/e2e/inhaltsrichtlinie.browser.spec.ts` in allen drei Engines.
 *
 * Gegen den alten Stand scheitert jede Ebene: Den Baustein gab es nicht,
 * `next.config.ts` exportierte ein festes Objekt mit `'unsafe-eval'`, und der
 * ausgelieferte Kopf trug es auf jeder Antwort.
 */

/**
 * Eine Richtlinie in ihre Anweisungen zerlegen.
 *
 * Doppelte Anweisungen sind ein Fehler, keine Formsache: Der Browser beachtet
 * nur die erste, eine zweite `script-src` wäre also still wirkungslos — und
 * wer sie liest, hielte sie für gültig.
 */
function zerlegen(richtlinie: string): Map<string, string[]> {
  const anweisungen = new Map<string, string[]>();
  for (const teil of richtlinie.split(';')) {
    const [name, ...quellen] = teil.trim().split(/\s+/);
    if (!name) continue;
    assert.ok(!anweisungen.has(name), `Anweisung ${name} steht doppelt — der Browser beachtet nur die erste`);
    anweisungen.set(name, quellen);
  }
  return anweisungen;
}

/** Schlüsselwörter (`'self'`, `'none'` …) und reine Schemata (`data:`, `blob:`) sind keine Fremdquellen. */
const istFremdquelle = (quelle: string) => !quelle.startsWith("'") && !/^[a-z][a-z0-9+.-]*:$/.test(quelle);

const PRODUKTION = inhaltsrichtlinie({ entwicklung: false });
const ENTWICKLUNG = inhaltsrichtlinie({ entwicklung: true });

/** Alle Phasen, in denen Next die Konfiguration lädt — aus Next selbst, nicht abgeschrieben. */
const PHASEN = Object.entries(nextKonstanten)
  .filter(([name, wert]) => name.startsWith('PHASE_') && typeof wert === 'string')
  .map(([, wert]) => wert as string);

type Kopfregel = { source: string; headers: { key: string; value: string }[] };

async function kopfregeln(phase: string): Promise<Kopfregel[]> {
  const konfig = konfiguration(phase);
  assert.equal(typeof konfig.headers, 'function', `${phase}: headers() fehlt`);
  return (await konfig.headers!()) as Kopfregel[];
}

describe('Inhaltsrichtlinie — der Baustein', () => {
  it('der Produktionsbau erlaubt kein unsafe-eval, aber WebAssembly', () => {
    const anweisungen = zerlegen(PRODUKTION);

    // Nirgends — auch nicht über `default-src`, auf das eine fehlende
    // Anweisung zurückfiele.
    assert.ok(!PRODUKTION.includes("'unsafe-eval'"), `'unsafe-eval' in der Produktionsrichtlinie: ${PRODUKTION}`);

    const skripte = anweisungen.get('script-src');
    assert.ok(skripte, 'script-src fehlt — dann gälte default-src, und niemand hätte das entschieden');
    assert.ok(skripte.includes("'wasm-unsafe-eval'"), 'ohne wasm-unsafe-eval übersetzt PDF.js sein WebAssembly nicht');
    assert.ok(skripte.includes("'self'"));

    // Worker (PDF.js) fallen auf `script-src` zurück, solange weder
    // `worker-src` noch `child-src` gesetzt ist. Ein eigener Eintrag dort
    // müsste die WebAssembly-Frage für den Worker neu beantworten.
    assert.equal(anweisungen.has('worker-src'), false);
    assert.equal(anweisungen.has('child-src'), false);

    // Die übrigen Härtungen stehen unverändert.
    assert.deepEqual(anweisungen.get('default-src'), ["'self'"]);
    assert.deepEqual(anweisungen.get('object-src'), ["'none'"]);
    assert.deepEqual(anweisungen.get('base-uri'), ["'self'"]);
    assert.deepEqual(anweisungen.get('form-action'), ["'self'"]);
    assert.deepEqual(anweisungen.get('frame-ancestors'), ["'self'"]);
    assert.equal(anweisungen.has('upgrade-insecure-requests'), false, 'bricht WebKit gegen http-Prüfserver (siehe Baustein)');
  });

  it('keine ungenutzten Fremdquellen', () => {
    /**
     * Jede Fremdquelle einzeln, mit ihrem Verbraucher. Eine neue Quelle
     * ändert diese Liste — und braucht dabei ihre Begründung im Baustein
     * (SECURITY_STANDARD C6). Das ist gewollt: Eine Quelle, die „vorsorglich"
     * dasteht, bleibt stehen, wenn ihr Verbraucher längst weg ist.
     */
    const erwartet: Record<string, string[]> = {
      // Google Analytics 4 / Tag Manager und Meta-Pixel, beide erst nach Einwilligung (`analytics.tsx`).
      'script-src': ['https://www.googletagmanager.com', 'https://connect.facebook.net'],
      // Bilder aus dem Objektspeicher; Messpixel von Google Analytics.
      'img-src': ['https://*.supabase.co', 'https://www.google-analytics.com'],
      // Direkter Upload an die signierte Adresse (`src/lib/upload.ts`); Messdaten von Google Analytics.
      'connect-src': ['https://*.supabase.co', 'https://www.google-analytics.com'],
    };

    const tatsaechlich: Record<string, string[]> = {};
    for (const [name, quellen] of zerlegen(PRODUKTION)) {
      const fremd = quellen.filter(istFremdquelle);
      if (fremd.length) tatsaechlich[name] = fremd;
    }
    assert.deepEqual(tatsaechlich, erwartet);

    /**
     * Und ausdrücklich die zehn entfernten Quellen (dreizehn Einträge über
     * alle Anweisungen) — in keiner Anweisung, damit eine Wiederaufnahme an
     * ihrem Namen scheitert und nicht nur an einer Zählung.
     * Belegt per Suche über `src/` am 2026-09-30: kein `@stripe/stripe-js`,
     * keine Karten-Bibliothek, kein Supabase-Klient im Browser, Schriften über
     * `next/font` selbst ausgeliefert, kein eingebetteter Google-Rahmen.
     */
    const entfernt = [
      'https://js.stripe.com',
      'https://hooks.stripe.com',
      'https://api.stripe.com',
      'https://maps.googleapis.com',
      'https://maps.gstatic.com',
      'https://*.googleapis.com',
      'https://fonts.googleapis.com',
      'https://fonts.gstatic.com',
      'https://www.google.com',
      'wss://*.supabase.co',
    ];
    for (const quelle of entfernt) {
      for (const [name, quellen] of zerlegen(PRODUKTION)) {
        assert.ok(!quellen.includes(quelle), `${quelle} steht wieder in ${name}`);
      }
    }

    // Der Druckrahmen des PDF-Viewers ist eine Objekt-URL; `'self'` deckt sie
    // nicht zuverlässig ab (Chromium vergleicht das Schema).
    assert.deepEqual(zerlegen(PRODUKTION).get('frame-src'), ["'self'", 'blob:']);
  });

  it('nur der Entwicklungsserver behält unsafe-eval', async () => {
    assert.ok(PHASEN.includes(nextKonstanten.PHASE_DEVELOPMENT_SERVER));
    assert.ok(PHASEN.includes(nextKonstanten.PHASE_PRODUCTION_BUILD), 'die Bauphase schreibt die Kopfzeilen fest');
    assert.ok(PHASEN.length >= 4, `zu wenige Phasen gefunden: ${PHASEN.join(', ')}`);

    // Der Baustein: Entwicklung = Produktion + genau 'unsafe-eval', sonst nichts.
    const entwicklung = zerlegen(ENTWICKLUNG);
    assert.ok(entwicklung.get('script-src')?.includes("'unsafe-eval'"), 'next dev braucht unsafe-eval');
    entwicklung.set('script-src', entwicklung.get('script-src')!.filter((q) => q !== "'unsafe-eval'"));
    assert.deepEqual(entwicklung, zerlegen(PRODUKTION));

    // Die Verdrahtung: jede Phase, wie Next sie übergibt.
    const uebrigeJePhase = new Map<string, string>();
    for (const phase of PHASEN) {
      const regeln = await kopfregeln(phase);

      // Genau eine Regel setzt die Richtlinie, und sie gilt für jeden Pfad.
      const mitRichtlinie = regeln.filter((r) => r.headers.some((k) => k.key.toLowerCase() === 'content-security-policy'));
      assert.deepEqual(mitRichtlinie.map((r) => r.source), ['/:path*'], `${phase}: Richtlinie nicht genau einmal für jeden Pfad`);

      const richtlinie = mitRichtlinie[0]!.headers.find((k) => k.key === 'Content-Security-Policy')!.value;
      const istEntwicklungsserver = phase === nextKonstanten.PHASE_DEVELOPMENT_SERVER;
      assert.equal(richtlinie, istEntwicklungsserver ? ENTWICKLUNG : PRODUKTION, `${phase}: falsche Richtlinie`);
      assert.equal(richtlinie.includes("'unsafe-eval'"), istEntwicklungsserver, `${phase}: unsafe-eval`);

      uebrigeJePhase.set(
        phase,
        JSON.stringify(regeln.map((r) => ({ ...r, headers: r.headers.filter((k) => k.key !== 'Content-Security-Policy') }))),
      );
    }

    // Alles andere hängt nicht von der Phase ab — ein Artefakt für jede Umgebung (V2-1).
    assert.equal(new Set(uebrigeJePhase.values()).size, 1, 'eine andere Kopfzeile als die Richtlinie hängt von der Phase ab');
  });
});

describe('Inhaltsrichtlinie — am laufenden Server', () => {
  before(async () => {
    await requireServer();
  });

  it('dieselbe Richtlinie auf Seite, API und statischer Datei', async () => {
    const seite = await get<string>('/');
    assert.equal(seite.status, 200, `Startseite: HTTP ${seite.status}`);

    const api = await get('/api/health');
    assert.equal(api.status, 200, `Health: HTTP ${api.status}`);

    // Ein Bündel, das die Seite wirklich lädt — nicht ein geratener Pfad.
    const buendel = seite.text.match(/\/_next\/static\/[^"'\s<>]+\.js/)?.[0];
    assert.ok(buendel, 'die Startseite verweist auf kein Bündel unter /_next/static');
    const statisch = await get(buendel);
    assert.equal(statisch.status, 200, `${buendel}: HTTP ${statisch.status}`);

    // Der Worker von PDF.js — die Version aus der Datei, die das Kopierskript
    // neben die Laufzeitdateien legt (`scripts/copy-pdfjs-assets.ts`).
    const version = await get<string>('/pdfjs/VERSION');
    assert.equal(version.status, 200, `/pdfjs/VERSION: HTTP ${version.status}`);
    const workerPfad = `/pdfjs/${version.text.trim()}/pdf.worker.min.mjs`;
    const worker = await get(workerPfad);
    assert.equal(worker.status, 200, `${workerPfad}: HTTP ${worker.status}`);

    for (const [ort, antwort] of [
      ['Seite /', seite],
      ['API /api/health', api],
      [`statisch ${buendel}`, statisch],
      [`Worker ${workerPfad}`, worker],
    ] as const) {
      const kopf = antwort.headers.get('content-security-policy');
      // Gleichheit statt Teilprüfung: Zwei gesetzte Köpfe kämen hier
      // zusammengefügt an und fielen genauso auf wie eine abweichende Fassung.
      assert.equal(kopf, PRODUKTION, `${ort}: ausgelieferte Richtlinie weicht vom Baustein ab`);
      assert.ok(!kopf!.includes("'unsafe-eval'"), `${ort}: unsafe-eval ausgeliefert`);
      assert.ok(kopf!.includes("'wasm-unsafe-eval'"), `${ort}: wasm-unsafe-eval fehlt`);
    }
  });
});
