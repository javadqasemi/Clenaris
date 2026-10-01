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
 *    schmale Ausnahme für PDF.js (JPEG 2000, JBIG2, Farbprofile und die
 *    PostScript-Funktionen eines Dokuments, die PDF.js zur Laufzeit selbst in
 *    WebAssembly übersetzt). Ältere Engines kannten sie nicht und hätten
 *    WebAssembly zusammen mit `eval` abgewiesen; dann fiele PDF.js still auf
 *    seine langsameren Ersatzwege in JavaScript zurück.
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
 *  Warum die Prüfung erst auf ein Startsignal beginnt
 * ---------------------------------------------------------------------------
 *
 * Die Prüfung wird mit `page.addScriptTag` eingesetzt, aber sie *beginnt*
 * dabei nicht. Das Skript legt nur die Zusage ab und wartet auf eine
 * Nachricht (`postMessage`), die der Fall erst schickt, wenn `addScriptTag`
 * zurückgekehrt ist. Dafür gibt es zwei Gründe, und jeder allein hätte den
 * Fall unbrauchbar gemacht.
 *
 * **1. Die Auswertungsausnahme des Steuerprotokolls.** Playwright wertet
 * jeden Aufruf über das Steuerprotokoll des Browsers im Hauptbereich der
 * Seite aus — `page.evaluate` ebenso wie `page.addScriptTag`. Auf einer Seite
 * ohne `'unsafe-eval'` gelingt das nur, weil jede Engine die Richtlinie für
 * die Dauer dieses einen Protokollaufrufs ausdrücklich aussetzt: der
 * V8-Inspector, `InjectedScriptBase` in JavaScriptCore („Temporarily enable
 * allow evals for inspector") und Juggler in Firefox, der jeden
 * Funktionsaufruf mit `bypassCSP: true` über `executeInGlobalWithBindings`
 * ausführt (`content/Runtime.js` im `omni.ja` von firefox-1543: „so
 * bypassCSP scopes the call"). Die ganze übrige Browserreihe lebt davon, und
 * Playwrights eigenes `waitForFunction` rechnet damit — es merkt sich die
 * ausgewertete Funktion, weil `eval` nur im ersten, synchronen Durchlauf
 * gelingt.
 *
 * Diese Ausnahme träfe auch das eingesetzte Skript. `addScriptTag({ content })`
 * hängt das `<script>` *innerhalb* einer solchen Auswertung an
 * (`document.head.appendChild` in `addScriptContent`), und ein eingefügtes
 * klassisches Inline-Skript läuft synchron während `appendChild`. Was es dort
 * sofort täte, läge noch im Fenster der Ausnahme: `eval('1 + 1')` lieferte 2
 * und keinen Verstoss, und der Fall bewiese nichts. Die erste Fassung dieses
 * Falls stand genau so da — die Auswertung vor dem ersten `await`.
 *
 * **2. Playwrights CSP-Wettlauf in `addScriptTag`.** `addScriptTag` läuft in
 * `_raceWithCSPError` (`playwright-core`, `lib/coreBundle.js`): Erscheint,
 * solange der Aufruf läuft, auf der Seite eine Konsolenmeldung vom Typ
 * `error`, deren Text „Content-Security-Policy" oder „Content Security
 * Policy" enthält, wirft `addScriptTag` mit genau diesem Text — so erkennt
 * Playwright ein verweigertes Inline-Skript. Für Firefox
 * (`cspErrorsAsynchronousForInlineScripts`) wartet es nach dem Einfügen sogar
 * eigens einen zweiten Protokollaufruf ab (`context.evaluate(() => true)`),
 * weil Firefox CSP-Meldungen erst nachträglich schreibt. Die zweite Fassung
 * dieses Falls begann mit `await pause(0)`: Das hob Grund 1 auf, nicht aber
 * Grund 2. Ein Zeitgeber über null Millisekunden läuft im Inhaltsprozess
 * lange vor der Antwort auf jenen zweiten Aufruf; die verweigerte Auswertung
 * hätte ihre Meldung („Content-Security-Policy: The page’s settings blocked
 * a JavaScript eval …") mitten in den Wettlauf geschrieben, und
 * `addScriptTag` wäre in Firefox an genau der Meldung gescheitert, die der
 * Fall erwartet. Die Meldungen von Chromium und WebKit enthalten ebenfalls
 * „Content Security Policy"; dort hielt nur die Reihenfolge der
 * Protokollnachrichten den Fall grün — die Antwort auf das Einfügen verliess
 * den Inhaltsprozess vor der Meldung. Ein Zufall der Reihenfolge ist kein
 * Entwurf. (Beides aus dem Quelltext hergeleitet, nicht im Browser gemessen.)
 *
 * **Das Startsignal löst beides.** Es wird erst geschickt, nachdem
 * `addScriptTag` zurückgekehrt ist — der Wettlauf ist dann entschieden und
 * sein Zuhörer entfernt. Und `postMessage` liefert das `message`-Ereignis nie
 * sofort, sondern stellt es als eigene Aufgabe in die Ereignisschleife; die
 * beginnt erst, wenn der Protokollaufruf, der die Nachricht abschickt,
 * zurückgekehrt und seine Ausnahme aufgehoben ist. Ein `dispatchEvent` oder
 * `queueMicrotask` an derselben Stelle reichte nicht: Beide liefen noch
 * innerhalb dieses Protokollaufrufs. Ab dem `message`-Ereignis trifft die
 * Richtlinie das Skript so wie jedes Skript der Anwendung. Die Zusicherungen
 * auf `EvalError` und auf den einen Verstoss sind zugleich der Nachweis, dass
 * die Verschiebung wirkt: Fiele sie weg, lieferte `eval` wieder 2, und der
 * Fall würde rot.
 *
 * Das `<script>` bleibt trotzdem der richtige Träger und nicht ein
 * `page.evaluate`, das seinerseits einen Zeitgeber stellt: Ob es überhaupt
 * läuft, entscheidet `'unsafe-inline'` (das Next für seine Inline-Nutzlast
 * ohnehin braucht). Die Prüfung von Inline-Skripten gilt auch für eine
 * Einfügung über das Steuerprotokoll — genau dafür gibt es den Wettlauf aus
 * Grund 2. `page.evaluate` schickt danach nur das Startsignal und holt das
 * Ergebnis ab; was die Richtlinie betrifft, wertet es nicht aus.
 *
 * ---------------------------------------------------------------------------
 *  Verstösse und Konsole
 * ---------------------------------------------------------------------------
 *
 * Verstösse werden im Browser gezählt (`securitypolicyviolation`), weil das
 * Ereignis Anweisung und Quelle in fester Form nennt und hier den Schritt
 * trägt, in dem es eintraf. Die Konsolenzeile ist je Engine anders formuliert
 * und sagt nicht, welcher Schritt sie auslöste.
 *
 * Die Konsole wird trotzdem genau geprüft, nicht nur nach oben begrenzt —
 * aber **je Engine nach Messung**, nicht nach Annahme. Die erste Fassung
 * erwartete in allen drei Engines genau eine Meldung zur verweigerten
 * Auswertung (Chromium über `Log.entryAdded`, WebKit über
 * `Console.messageAdded`, Firefox über den Konsolendienst, dessen Kategorie
 * `CSP` Juggler nicht ausfiltert). Gemessen am 2026-10-01 im ersten vollen
 * Lauf gegen den Produktionsbau (Playwright 1.63, `chromium-1243`,
 * `firefox-1543`, WebKit des Pakets): Firefox meldet sie, Chromium und WebKit
 * reichen für die in `try`/`catch` abgefangene Auswertung **keine**
 * Konsolenmeldung an Playwright weiter — der Verstoss selbst kam in allen
 * drei Engines genau einmal als `securitypolicyviolation` an, `eval` warf in
 * allen drei einen `EvalError`. Deshalb steht die erwartete Zahl je Engine in
 * `EVAL_MELDUNGEN_JE_ENGINE`, namentlich und mit diesem Messstand, statt
 * einer pauschalen Lockerung („höchstens eine") für alle: Ändert eine Engine
 * ihr Verhalten, fällt das hier auf — in beide Richtungen. Und `keineFehler()`
 * bleibt scharf: Jede *andere* Fehlermeldung, auch eine anders formulierte
 * CSP-Zeile in Chromium oder WebKit, lässt den Fall scheitern.
 *
 * **Diagnosemodus** (`E2E_DIAGNOSE=1`, `next dev` auf Port 3002): Der
 * Entwicklungsserver trägt `'unsafe-eval'` absichtlich (Begründung in
 * `next.config.ts`). Dort wird deshalb das Gegenteil erwartet — `eval`
 * läuft, kein Verstoss, keine Meldung —, statt den Fall zu überspringen: Er
 * prüft auch dann, dass die Richtlinie der Phase entspricht.
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
 * Wie viele Konsolenmeldungen die verweigerte, in `try`/`catch` abgefangene
 * Auswertung je Engine an Playwright weiterreicht — gemessen am 2026-10-01
 * gegen den Produktionsbau (Kopfkommentar, „Verstösse und Konsole"). Eine
 * Engine, die hier fehlt, wird mit 1 erwartet; eine neue Engine muss gemessen
 * und eingetragen werden, statt still durchzugehen.
 */
const EVAL_MELDUNGEN_JE_ENGINE: Record<string, number> = { chromium: 0, firefox: 1, webkit: 0 };

/**
 * Die Nachricht, auf die das eingesetzte Skript wartet, bevor es prüft
 * (Kopfkommentar). Ein eigener Name statt eines leeren Signals, damit keine
 * andere Nachricht der Seite die Prüfung auslöst.
 */
const STARTSIGNAL = 'clenaris:inhaltsrichtlinie:pruefen';

/**
 * Die eine Konsolenmeldung, die die verweigerte Auswertung auslösen darf —
 * je Engine anders formuliert. Die Wortlaute stammen aus den Browsern, die
 * Playwright 1.63 festlegt (`browsers.json`: chromium-1243, firefox-1543,
 * webkit-2359), gelesen aus den installierten Dateien (`chrome.dll`,
 * `csp.properties` im `omni.ja`, `WebCore.dll`):
 *
 *  • Chromium: „Evaluating a string as JavaScript violates the following
 *    Content Security Policy directive because 'unsafe-eval' …". Die ältere
 *    Fassung „Refused to evaluate a string as JavaScript" führt diese Version
 *    nicht mehr — die erste Fassung dieses Musters kannte nur sie, verfehlte
 *    die Meldung in Chromium, und `keineFehler()` wäre an ihr gescheitert.
 *  • WebKit: „Refused to execute a script because 'unsafe-eval' …" (Konsole)
 *    und „Refused to evaluate a string as JavaScript because 'unsafe-eval' …"
 *    (Text des `EvalError`).
 *  • Firefox: „Content-Security-Policy: The page’s settings blocked a
 *    JavaScript eval …" (`CSPEvalScriptViolation`).
 *
 * Bewusst so eng, dass eine Meldung über **WebAssembly** nicht darunter
 * fällt: „Compiling or instantiating a WebAssembly module violates …"
 * (Chromium), „Refused to create a WebAssembly object …" (WebKit) und
 * „blocked WebAssembly" (Firefox) passen auf keine der Alternativen — und
 * genau diese Meldungen wären der Befund.
 */
const EVAL_VERWEIGERT = new RegExp(
  [
    'Evaluating a string as JavaScript violates the following Content Security Policy directive',
    "Refused to execute a script because 'unsafe-eval'",
    "Refused to evaluate a string as JavaScript because 'unsafe-eval'",
    'blocked a JavaScript eval',
  ].join('|'),
);

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
 * beginnt erst auf das Startsignal (beides im Kopfkommentar begründet). Sie
 * wirft nie: Jeder Schritt hält sein Ergebnis fest, damit ein Fehlschlag sagt,
 * welcher Schritt es war. Abgelehnt wird die Zusage nur, wenn das
 * Startsignal ausbleibt — dann gibt es keinen Schritt, dem man den
 * Fehlschlag zuschreiben könnte, und eine klare Meldung ist besser als ein
 * Fall, der stumm bis zur Zeitgrenze hängt.
 */
function pruefungImBrowser(modul: number[], startsignal: string): void {
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

  /**
   * Die Schritte selbst. Aufgerufen wird das erst im `message`-Ereignis des
   * Startsignals; die Auswertung ist dort das Erste, was geschieht, und läuft
   * damit in einer eigenen Aufgabe der Ereignisschleife — ausserhalb jedes
   * Protokollaufrufs und nach dem CSP-Wettlauf von `addScriptTag`.
   */
  const pruefen = async (): Promise<Befund> => {
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
  };

  /*
   * Die Zusage wird *synchron* abgelegt, noch während `appendChild`: Das
   * `page.evaluate`, das sie abholt, folgt kurz auf `addScriptTag` und fände
   * sonst nichts vor.
   *
   * Das Startsignal wird allein an seinem Inhalt erkannt. Der eigene Name
   * verhindert, dass eine andere Nachricht der Seite die Prüfung zu früh
   * auslöst — womöglich doch noch innerhalb des Wettlaufs. Absender und
   * Ursprung zusätzlich zu vergleichen brächte hier keine Sicherheit (auf der
   * Prüfseite schickt niemand Fremdes), wohl aber ein Risiko: In Firefox
   * schickt Juggler die Nachricht aus einer Auswertung über die
   * Debugger-Schnittstelle, und ob `source` dort genau dieses Fenster ist,
   * ist nicht gemessen. Ein Vergleich, der dort fehlschlüge, liesse die
   * Prüfung nie beginnen.
   */
  fenster.__inhaltsrichtlinie = new Promise<Befund>((fertig, abbrechen) => {
    const ausgeblieben = setTimeout(() => {
      window.removeEventListener('message', starten);
      abbrechen(new Error('Das Startsignal der Inhaltsrichtlinien-Prüfung traf nie ein.'));
    }, 10_000);
    function starten(ereignis: MessageEvent) {
      if (ereignis.data !== startsignal) return;
      window.removeEventListener('message', starten);
      clearTimeout(ausgeblieben);
      fertig(pruefen());
    }
    window.addEventListener('message', starten);
  });
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

  // — Die Prüfung als gewöhnliches Inline-Skript einsetzen. Sie prüft dabei
  //   noch nichts, sondern wartet auf das Startsignal.
  await page.addScriptTag({
    content: `(${pruefungImBrowser.toString()})(${JSON.stringify(WASM_MODUL)}, ${JSON.stringify(STARTSIGNAL)});`,
  });

  // — Erst jetzt beginnen lassen: Der CSP-Wettlauf von `addScriptTag` ist
  //   entschieden, und das `message`-Ereignis ist eine eigene Aufgabe nach
  //   diesem Protokollaufruf (Kopfkommentar).
  await page.evaluate((signal) => window.postMessage(signal, location.origin), STARTSIGNAL);
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

  // — Konsole: die gemessene Zahl von Meldungen zur verweigerten Auswertung
  //   je Engine (im Diagnosemodus keine), sonst nichts. Warum je Engine und
  //   nicht „höchstens eine", steht im Kopfkommentar.
  const evalMeldungen = konsole.erwartet(EVAL_VERWEIGERT);
  const erwarteteMeldungen = ENTWICKLUNGSSERVER ? 0 : (EVAL_MELDUNGEN_JE_ENGINE[browserName] ?? 1);
  expect(
    evalMeldungen,
    `${browserName}: die Zahl der Konsolenmeldungen zur verweigerten Auswertung weicht von der Messung ab`,
  ).toBe(erwarteteMeldungen);
  konsole.keineFehler();
});
