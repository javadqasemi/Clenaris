import { test, expect } from './helpers/basis';
import { anfragenVerfolgen, konsoleUeberwachen } from './helpers/browser';

/**
 * Die Inhaltsrichtlinie im Browser — in **allen drei** Engines (2026-09-30).
 *
 * `tests/api/inhaltsrichtlinie.test.ts` prüft, welche Richtlinie ausgeliefert
 * wird. Ob der Browser sie so *durchsetzt*, wie sie dort steht, ist eine
 * zweite Aussage, und nur ein Browser kann sie belegen:
 *
 *  • **`eval` wird verweigert.** Seit `'unsafe-eval'` fehlt, darf kein Text
 *    mehr zu Skript werden. Das ist der eigentliche Gewinn — und er ist nur
 *    einer, wenn jede Engine ihn einlöst.
 *  • **WebAssembly übersetzt trotzdem.** `'wasm-unsafe-eval'` ist die
 *    schmale Ausnahme für PDF.js (JPEG 2000, JBIG2, Farbprofile). Ältere
 *    Engines kannten sie nicht und hätten WebAssembly zusammen mit `eval`
 *    abgewiesen; dann fiele PDF.js still auf seine langsamen Ersatzdekoder
 *    zurück.
 *  • **Der Druckrahmen lädt.** Der PDF-Viewer druckt über einen Rahmen mit
 *    einer `blob:`-Adresse, die `'self'` nicht zuverlässig abdeckt
 *    (`frame-src 'self' blob:`). Geprüft wird das Laden des Rahmens, nicht
 *    der Druckdialog.
 *  • **Die Seite selbst kommt ohne einen einzigen Verstoss aus** — gezählt
 *    über `securitypolicyviolation` ab dem ersten Byte, nicht über die
 *    Konsole. Das ist der Nachweis, dass die ausgelieferten Bündel
 *    tatsächlich keine Auswertung brauchen.
 *
 * ---------------------------------------------------------------------------
 *  Warum die Prüfung als Inline-Skript läuft und nicht über `page.evaluate`
 * ---------------------------------------------------------------------------
 *
 * `page.evaluate` wertet über das Steuerprotokoll des Browsers aus, und das
 * steht ausserhalb der Richtlinie — je nach Engine liefe `eval` dort durch,
 * und der Fall bewiese nichts. Deshalb setzt der Fall ein gewöhnliches
 * `<script>` in die Seite (`page.addScriptTag({ content })`), das die
 * Richtlinie genau so trifft wie jedes Skript der Anwendung; erlaubt ist es
 * über `'unsafe-inline'`, das Next für seine Inline-Nutzlast ohnehin braucht.
 * `page.evaluate` holt danach nur noch das Ergebnis ab — lesen, nicht
 * auswerten.
 *
 * Verstösse werden aus demselben Grund im Browser gezählt
 * (`securitypolicyviolation`) und nicht allein an der Konsole: Firefox reicht
 * CSP-Meldungen nicht zuverlässig als Konsolenfehler an Playwright weiter.
 * Die Konsole wird trotzdem geprüft — dort ist genau die eine erwartete
 * Meldung erlaubt, und nur sie.
 *
 * **Diagnosemodus** (`E2E_DIAGNOSE=1`, `next dev` auf Port 3002): Der
 * Entwicklungsserver trägt `'unsafe-eval'` absichtlich (Begründung in
 * `next.config.ts`). Dort wird deshalb das Gegenteil erwartet — `eval`
 * läuft, kein Verstoss —, statt den Fall zu überspringen: Er prüft auch dann,
 * dass die Richtlinie der Phase entspricht.
 */

/**
 * Ein gültiges WebAssembly-Modul mit einer Funktion `antwort`, die 42 liefert:
 * Kopf, Typ `() -> i32`, eine Funktion, ihr Export, ihr Rumpf (`i32.const 42`).
 * Klein genug, um es zu lesen, aber mit Ausführung — ein leeres Modul bewiese
 * nur das Übersetzen, nicht dass danach auch etwas läuft.
 */
const WASM_MODUL = [
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f,
  0x03, 0x02, 0x01, 0x00,
  0x07, 0x0b, 0x01, 0x07, 0x61, 0x6e, 0x74, 0x77, 0x6f, 0x72, 0x74, 0x00, 0x00,
  0x0a, 0x06, 0x01, 0x04, 0x00, 0x41, 0x2a, 0x0b,
];

const ENTWICKLUNGSSERVER = process.env.E2E_DIAGNOSE === '1';

/**
 * Die eine Konsolenmeldung, die die verweigerte Auswertung auslösen darf —
 * je Engine anders formuliert. Bewusst so eng, dass eine Meldung über
 * **WebAssembly** nicht darunter fällt: Chromium nennt auch dort
 * `'unsafe-eval'` („Refused to compile or instantiate WebAssembly module
 * because …"), und genau diese Meldung wäre der Befund.
 */
const EVAL_VERWEIGERT =
  /Refused to evaluate a string as JavaScript|Refused to execute a script because 'unsafe-eval'|blocked a JavaScript eval|resource at eval\b/;

/** Der Schritt, in dem ein Verstoss eintraf — `laden` ist alles vor der Prüfung. */
type Schritt = 'laden' | 'eval' | 'wasm' | 'rahmen' | 'ende';

interface Verstoss {
  anweisung: string;
  quelle: string;
  schritt: Schritt;
}

interface Befund {
  eval: { ausgefuehrt: boolean; wert: unknown; fehler: string | null };
  wasm: { antwort: number | null; fehler: string | null };
  rahmen: { inhalt: string | null };
}

type Fenster = Window & {
  __cspVerstoesse?: Verstoss[];
  __cspSchritt?: Schritt;
  __inhaltsrichtlinie?: Promise<Befund>;
};

/**
 * Verstösse ab dem ersten Byte mitschreiben, jeder mit dem Schritt, in dem er
 * eintraf. Läuft als Initialskript vor jedem Skript der Seite; es wertet
 * nichts aus, es hört nur zu.
 */
function verstoesseMitschreiben(): void {
  const fenster = window as Fenster;
  fenster.__cspVerstoesse = [];
  fenster.__cspSchritt = 'laden';
  document.addEventListener('securitypolicyviolation', (ereignis) => {
    fenster.__cspVerstoesse!.push({
      anweisung: ereignis.effectiveDirective || ereignis.violatedDirective,
      quelle: ereignis.blockedURI,
      schritt: fenster.__cspSchritt ?? 'laden',
    });
  });
}

/**
 * Die eigentliche Prüfung — läuft **im Browser, als Inline-Skript** (siehe
 * Kopfkommentar). Sie wirft nie: Jeder Schritt hält sein Ergebnis fest, damit
 * ein Fehlschlag sagt, welcher Schritt es war.
 */
function pruefungImBrowser(modul: number[]): void {
  const fenster = window as Fenster;
  const pause = (ms: number) => new Promise<void>((weiter) => setTimeout(weiter, ms));

  /**
   * Name des Fehlers, ohne `instanceof Error`: Die Prüfung stammt aus einem
   * anderen Bereich als der Fehler, sobald eine Engine ihn in einem eigenen
   * Realm erzeugt (gemessen mit `node:vm`: `instanceof` lieferte `false`, und
   * der Fall hätte „EvalError: …" statt „EvalError" verglichen). Der Name
   * selbst ist über alle Realms derselbe.
   */
  const fehlername = (fehler: unknown) => {
    const name = (fehler as { name?: unknown } | null)?.name;
    return typeof name === 'string' ? name : String(fehler);
  };
  const fehlertext = (fehler: unknown) => {
    const text = (fehler as { message?: unknown } | null)?.message;
    return `${fehlername(fehler)}: ${typeof text === 'string' ? text : String(fehler)}`;
  };

  /**
   * Einen Schritt abschliessen. Verstösse werden als Aufgabe *nachgereicht*;
   * ohne dieses Warten liefe der Verstoss der Auswertung womöglich erst im
   * WebAssembly-Schritt ein und würde dem falschen zugeschrieben. Gewartet
   * wird, bis einer eingetroffen ist, höchstens aber eine Sekunde — im
   * Diagnosemodus kommt keiner, und das ist dort richtig.
   */
  const schrittAbschliessen = async (vorher: number) => {
    const ende = Date.now() + 1_000;
    while ((fenster.__cspVerstoesse?.length ?? 0) === vorher && Date.now() < ende) await pause(20);
    await pause(50);
  };

  fenster.__inhaltsrichtlinie = (async (): Promise<Befund> => {
    const befund: Befund = {
      eval: { ausgefuehrt: false, wert: null, fehler: null },
      wasm: { antwort: null, fehler: null },
      rahmen: { inhalt: null },
    };

    fenster.__cspSchritt = 'eval';
    let vorher = fenster.__cspVerstoesse?.length ?? 0;
    try {
      befund.eval.wert = eval('1 + 1');
      befund.eval.ausgefuehrt = true;
    } catch (fehler) {
      befund.eval.fehler = fehlername(fehler);
    }
    await schrittAbschliessen(vorher);

    fenster.__cspSchritt = 'wasm';
    vorher = fenster.__cspVerstoesse?.length ?? 0;
    try {
      const { instance } = await WebAssembly.instantiate(new Uint8Array(modul));
      befund.wasm.antwort = (instance.exports.antwort as () => number)();
    } catch (fehler) {
      befund.wasm.fehler = fehlertext(fehler);
    }
    await schrittAbschliessen(vorher);

    // Der Druckweg des PDF-Viewers: ein Rahmen mit einer Objekt-URL.
    fenster.__cspSchritt = 'rahmen';
    vorher = fenster.__cspVerstoesse?.length ?? 0;
    const adresse = URL.createObjectURL(
      new Blob(['<!doctype html><title>Druck</title><p id="inhalt">Druckrahmen</p>'], { type: 'text/html' }),
    );
    befund.rahmen.inhalt = await new Promise<string | null>((fertig) => {
      const rahmen = document.createElement('iframe');
      rahmen.setAttribute('aria-hidden', 'true');
      rahmen.style.position = 'fixed';
      rahmen.style.width = '0';
      rahmen.style.height = '0';
      rahmen.style.border = '0';
      const grenze = setTimeout(() => fertig(null), 5_000);
      rahmen.onload = () => {
        clearTimeout(grenze);
        // Verweigert, zeigt der Rahmen eine Fehlerseite fremden Ursprungs:
        // `contentDocument` ist dann `null` oder leer.
        fertig(rahmen.contentDocument?.getElementById('inhalt')?.textContent ?? null);
        rahmen.remove();
        URL.revokeObjectURL(adresse);
      };
      rahmen.src = adresse;
      document.body.appendChild(rahmen);
    });
    await schrittAbschliessen(vorher);

    fenster.__cspSchritt = 'ende';
    return befund;
  })();
}

test('eval wird verweigert, WebAssembly kompiliert', async ({ page, browserName }) => {
  const konsole = konsoleUeberwachen(page);
  const anfragen = anfragenVerfolgen(page);
  await page.addInitScript(verstoesseMitschreiben);

  const antwort = await page.goto('/');
  expect(antwort?.status()).toBe(200);
  const richtlinie = antwort?.headers()['content-security-policy'] ?? '';
  expect(richtlinie, 'ohne Richtlinie bewiese dieser Fall nichts').toContain("'wasm-unsafe-eval'");
  expect(richtlinie.includes("'unsafe-eval'"), `${browserName}: unsafe-eval in der ausgelieferten Richtlinie`).toBe(
    ENTWICKLUNGSSERVER,
  );
  await anfragen.ruhig();

  const verstoesse = () => page.evaluate(() => (window as Fenster).__cspVerstoesse ?? null);

  // — Die Seite selbst: geladen, hydriert, ruhig — und kein einziger Verstoss.
  expect(await verstoesse(), `${browserName}: die Seite verletzt die Richtlinie schon beim Laden`).toEqual([]);

  // — Die Prüfung als gewöhnliches Inline-Skript einsetzen.
  await page.addScriptTag({ content: `(${pruefungImBrowser.toString()})(${JSON.stringify(WASM_MODUL)});` });
  const befund = await page.evaluate(() => (window as Fenster).__inhaltsrichtlinie ?? null);
  expect(befund, `${browserName}: das Inline-Skript lief nicht — fehlt 'unsafe-inline'?`).not.toBeNull();

  if (ENTWICKLUNGSSERVER) {
    expect(befund!.eval).toEqual({ ausgefuehrt: true, wert: 2, fehler: null });
  } else {
    expect(befund!.eval, `${browserName}: eval lief trotz der Richtlinie`).toEqual({
      ausgefuehrt: false,
      wert: null,
      fehler: 'EvalError',
    });
  }
  expect(befund!.wasm, `${browserName}: WebAssembly wurde nicht übersetzt oder lief nicht`).toEqual({
    antwort: 42,
    fehler: null,
  });
  expect(befund!.rahmen.inhalt, `${browserName}: der blob:-Rahmen (Druckweg) wurde verweigert`).toBe('Druckrahmen');

  /**
   * — Genau ein Verstoss, im Auswertungsschritt, gegen `script-src`, Quelle
   * `eval` (so nennt CSP 3 die verweigerte Auswertung; WebAssembly hiesse
   * `wasm-eval`). Jeder Schritt hat auf nachgereichte Verstösse gewartet,
   * bevor der nächste begann — ein Verstoss aus dem WebAssembly- oder
   * Rahmenschritt stünde also mit seinem eigenen Schritt hier und fiele auf.
   */
  const erwartet: Verstoss[] = ENTWICKLUNGSSERVER ? [] : [{ anweisung: 'script-src', quelle: 'eval', schritt: 'eval' }];
  expect(await verstoesse(), `${browserName}: andere oder weitere Verstösse als die verweigerte Auswertung`).toEqual(
    erwartet,
  );

  // — Konsole: höchstens die eine Meldung zur Auswertung (Firefox meldet sie
  //   Playwright nicht als Fehler), sonst nichts.
  const evalMeldungen = konsole.erwartet(EVAL_VERWEIGERT);
  expect(evalMeldungen, `${browserName}: die Auswertungsmeldung erschien mehr als einmal`).toBeLessThanOrEqual(
    erwartet.length,
  );
  konsole.keineFehler();
});
