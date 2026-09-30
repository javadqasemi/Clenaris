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
 *  • **Ein `blob:`-Rahmen lädt.** Der PDF-Viewer druckt über einen Rahmen mit
 *    einer `blob:`-Adresse, die `'self'` nicht zuverlässig abdeckt
 *    (`frame-src 'self' blob:`). Belegt ist damit **nur** `frame-src` für
 *    `blob:` — die Voraussetzung des Druckwegs, nicht der Druckweg selbst.
 *    Der Rahmen hier trägt ein kleines HTML-Dokument; der echte Druckrahmen
 *    trägt ein PDF (`application/pdf`, `pdf-viewer-inner.tsx`, `drucken`).
 *    Ein `blob:`-Dokument erbt die Richtlinie der Seite samt
 *    `object-src 'none'`, und ob der PDF-Darsteller des Browsers darin
 *    erscheinen darf, ist je Engine verschieden und hier nicht geprüft.
 *    Ein PDF-Rahmen in diesem Fall wäre kein ehrlicher Ersatz: Ein Verstoss
 *    im Rahmen fiele in *dessen* Dokument an, nicht in die Liste dieser
 *    Seite, und ob die drei Prüfbrowser überhaupt einen PDF-Darsteller
 *    mitbringen, ist nicht gemessen — wo keiner ist, hiesse „kein Verstoss"
 *    nur „nichts dargestellt", und der Fall wäre grün, ohne etwas zu
 *    belegen. Dieser Nachweis braucht einen Browser mit echtem
 *    PDF-Darsteller und den Druckdialog und bleibt offen (EXTERNER NACHWEIS
 *    ERFORDERLICH).
 *  • **Die Seite selbst kommt ohne einen einzigen Verstoss aus** — gezählt
 *    über `securitypolicyviolation` ab dem ersten Byte, nicht über die
 *    Konsole. Das ist der Nachweis, dass die ausgelieferten Bündel
 *    tatsächlich keine Auswertung brauchen.
 *
 * ---------------------------------------------------------------------------
 *  Warum die Prüfung erst in einer eigenen Aufgabe der Ereignisschleife beginnt
 * ---------------------------------------------------------------------------
 *
 * Playwright wertet jeden Aufruf über das Steuerprotokoll des Browsers aus —
 * `page.evaluate` ebenso wie `page.addScriptTag` —, und zwar mit
 * `this.global.eval(ausdruck)` im Hauptbereich der Seite
 * (`utilityScript.evaluate` in `playwright-core`). Auf einer Seite ohne
 * `'unsafe-eval'` gelingt das nur, weil die Engine das Erzeugen von Code aus
 * Text für die Dauer dieses einen Protokollaufrufs ausdrücklich erlaubt: der
 * V8-Inspector ebenso wie `InjectedScriptBase` in JavaScriptCore („Temporarily
 * enable allow evals for inspector"). Die ganze übrige Browserreihe lebt
 * davon, und Playwrights eigenes `waitForFunction` rechnet damit — es merkt
 * sich die ausgewertete Funktion, weil `eval` nur im ersten, synchronen
 * Durchlauf gelingt. Für Firefox ist der Weg nicht nachgelesen; die
 * Verschiebung unten wirkt dort genauso, falls es dieselbe Ausnahme kennt,
 * und schadet nicht, falls nicht.
 *
 * Diese Ausnahme trifft auch das eingesetzte Skript. `addScriptTag({ content })`
 * hängt das `<script>` *innerhalb* einer solchen Auswertung an
 * (`document.head.appendChild` in `addScriptContent`), und ein eingefügtes
 * klassisches Inline-Skript läuft synchron während `appendChild`. Alles, was
 * es vor seinem ersten echten Warten tut, liegt also noch im Fenster der
 * Ausnahme: `eval('1 + 1')` lieferte dort 2 und keinen Verstoss, und der Fall
 * bewiese nichts. Die erste Fassung dieses Falls stand genau so da — die
 * Auswertung vor dem ersten `await` — und wäre in Chromium und WebKit rot
 * geworden, ohne dass die Richtlinie falsch gewesen wäre (aus dem Quelltext
 * hergeleitet, nicht im Browser gemessen).
 *
 * Deshalb beginnt die Prüfung mit `await pause(0)`. Ein `setTimeout` ist eine
 * neue Aufgabe der Ereignisschleife, und die beginnt erst, wenn der
 * Protokollaufruf zurückgekehrt und die Ausnahme wieder aufgehoben ist.
 * `queueMicrotask` oder ein blosses `await` auf eine erfüllte Zusage reichten
 * nicht: Mikroaufgaben können noch abgearbeitet werden, bevor der
 * Protokollaufruf endet. Ab dieser Aufgabe trifft die Richtlinie das Skript
 * so wie jedes Skript der Anwendung. Die Zusicherungen auf `EvalError` und
 * auf den einen Verstoss sind zugleich der Nachweis, dass die Verschiebung
 * wirkt: Fiele sie weg, lieferte `eval` wieder 2, und der Fall würde rot.
 *
 * Das `<script>` bleibt trotzdem der richtige Träger und nicht ein
 * `page.evaluate`, das seinerseits ein `setTimeout` stellt: Ob es überhaupt
 * läuft, entscheidet `'unsafe-inline'` (das Next für seine Inline-Nutzlast
 * ohnehin braucht). Die Prüfung von Inline-Skripten gilt auch für eine
 * Einfügung über das Steuerprotokoll — genau deshalb fängt Playwright eine
 * verweigerte Einfügung eigens als CSP-Fehler ab (`_raceWithCSPError`).
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
 * Die eigentliche Prüfung — läuft **im Browser, als Inline-Skript**, und
 * beginnt erst in einer eigenen Aufgabe der Ereignisschleife (beides im
 * Kopfkommentar begründet). Sie wirft nie: Jeder Schritt hält sein Ergebnis
 * fest, damit ein Fehlschlag sagt, welcher Schritt es war.
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

  /*
   * Die Zusage wird *synchron* abgelegt, noch während `appendChild`: Das
   * `page.evaluate`, das sie abholt, folgt unmittelbar auf `addScriptTag` und
   * fände sonst nichts vor.
   */
  fenster.__inhaltsrichtlinie = (async (): Promise<Befund> => {
    /*
     * Zuerst aus dem Protokollaufruf heraus, in dem `addScriptTag` dieses
     * Skript synchron ausführt — dort erlaubt die Engine `eval` für
     * Playwright, und jede Prüfung davor wäre wertlos (Kopfkommentar).
     * `setTimeout`, nicht `queueMicrotask`: Mikroaufgaben können noch
     * innerhalb des Protokollaufrufs laufen.
     */
    await pause(0);

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

    // Die Voraussetzung des Druckwegs: ein Rahmen mit einer Objekt-URL
    // (`frame-src blob:`). Bewusst HTML und kein PDF — was das belegt und was
    // nicht, steht im Kopfkommentar.
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
  expect(befund!.rahmen.inhalt, `${browserName}: der blob:-Rahmen wurde verweigert (frame-src blob:)`).toBe('Druckrahmen');

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
