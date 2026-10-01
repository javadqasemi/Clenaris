import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { freemem } from 'node:os';
import { basename, join } from 'node:path';

import type { Browser, BrowserContext, ConsoleMessage, Page, Request, Response, TestInfo } from '@playwright/test';

/**
 * Beweissicherung für Laufzeitfehler im Browser — vor allem für
 * Hydrationsfehler.
 *
 * ---------------------------------------------------------------------------
 *  Warum es das gibt
 * ---------------------------------------------------------------------------
 *
 * Die Browserreihe hat über mehrere Waves hinweg gelegentlich 19/20 gemeldet,
 * jedes Mal an einer anderen Stelle, mit derselben Meldung:
 *
 *     pageerror: Minified React error #418  (args[]=HTML)
 *
 * Was in den Berichten stand, war der Testname und diese eine Zeile. Was
 * fehlte, war alles, womit sich die Ursache hätte bestimmen lassen: auf
 * welcher Adresse es passierte, was der Browser sonst noch meldete, wie der
 * Baum in diesem Moment aussah, welche Antwort gerade eingetroffen war. Ein
 * Fehler, der sich nur alle paar Läufe zeigt, ist ohne Beweissicherung im
 * Moment des Auftretens praktisch nicht zu fassen — man kann ihn nicht
 * herbeirufen, also muss der Lauf selbst mitschreiben.
 *
 * Diese Wache hängt deshalb an **jedem** Fall, nicht nur an denen, die die
 * Konsole ausdrücklich prüfen. Sie ist damit zugleich die Verschärfung, die
 * das Zuverlässigkeitstor verlangt: Ein Hydrationsfehler lässt den Fall
 * fehlschlagen, auch wenn der Fall selbst gar nicht auf die Konsole schaut.
 *
 * Seit 2026-10-01 steht hier ein zweites, stilleres Werkzeug derselben Art:
 * der Lebenslauf von Browser, Kontext und Seiten (`lebenslaufMitschreiben`,
 * RC-21). Er bewertet nichts, er schreibt nur mit — für den Fehler, der nicht
 * im Fall, sondern beim Abbau danach auftrat.
 *
 * ---------------------------------------------------------------------------
 *  Was **nicht** in die Artefakte kommt
 * ---------------------------------------------------------------------------
 *
 * Ein DOM-Abzug der Unterzeichnungsseite enthält den rohen Zugang aus dem
 * Fragment, Kundennamen und Adressen aus dem Demobestand. `test-results/`
 * wird nicht verfolgt, aber ein Artefakt wandert erfahrungsgemäss in einen
 * Fehlerbericht. Deshalb läuft **jeder** Text durch `redigieren()`, bevor er
 * geschrieben wird: 64-stellige Hexwerte (die Tokenform dieser Anwendung),
 * `#t=`-Fragmente, `token`/`secret`/`password`-Parameter, JWT-förmige
 * Zeichenketten und E-Mail-Adressen. Der Rest — Elementnamen, Klassen,
 * Struktur — ist genau das, was man zur Ursachenbestimmung braucht.
 */

/**
 * Wohin die Beweise gehen — **ausserhalb** von `test-results/`.
 *
 * Playwright leert sein Ausgabeverzeichnis zu Beginn **jedes** Laufs. Genau
 * daran ist der erste eingefangene Restbefund verlorengegangen: Die Datei
 * entstand im vierten Lauf einer Stressreihe und war nach dem fünften weg.
 * Ein Beweis, den der nächste Lauf löscht, ist bei einem Fehler, der sich alle
 * paar hundert Aufrufe zeigt, wertlos.
 *
 * Das Verzeichnis steht in `.gitignore`: Die Inhalte sind redigiert, aber ein
 * DOM-Abzug des Demobestands gehört trotzdem nicht ins Repository.
 */
const BEFUNDVERZEICHNIS = join(process.cwd(), 'hydrationsbefunde');

// ---------------------------------------------------------------------------
//  Erkennung
// ---------------------------------------------------------------------------

/**
 * Muster, die einen React-Hydrationsfehler bezeichnen — minifiziert wie im
 * Produktionsbau und im Klartext wie im Entwicklungsbau.
 *
 * Die Nummern sind die von React vergebenen Fehlerkennungen:
 *   418  Hydration failed … server rendered HTML didn't match the client
 *   419  The server could not finish this Suspense boundary
 *   421  This Suspense boundary received an update before it finished hydrating
 *   422  There was an error while hydrating this Suspense boundary
 *   423  There was an error while hydrating (ganzer Baum verworfen)
 *   425  Text content does not match server-rendered HTML
 *
 * 419 und 421 stehen bewusst mit in der Liste: Sie sind keine
 * Hydrationsabweichung im engeren Sinn, aber sie treten aus derselben Ursache
 * auf — Daten, die zur Unzeit eintreffen — und ihr Symptom ist dasselbe
 * verworfene Teilbaumstück.
 */
const HYDRATION_MUSTER: RegExp[] = [
  /Minified React error #(418|419|421|422|423|425)\b/,
  /Hydration failed because/i,
  /server rendered HTML didn't match the client/i,
  /Text content does not match server-rendered HTML/i,
  /There was an error while hydrating/i,
  /hydration-mismatch/i,
];

export const istHydrationsfehler = (text: string): boolean =>
  HYDRATION_MUSTER.some((muster) => muster.test(text));

// ---------------------------------------------------------------------------
//  Redigieren
// ---------------------------------------------------------------------------

const GEHEIM: Array<[RegExp, string]> = [
  // Die Tokenform dieser Anwendung: 64 Hexzeichen (SHA-256-Breite).
  [/\b[0-9a-f]{64}\b/gi, '‹token-64hex›'],
  // Fragment und Parameter, über die ein roher Zugang gereicht wird.
  [/([#&?]t=)[^&"'\s<>]+/gi, '$1‹redigiert›'],
  [/((?:token|secret|password|passwort|code|kennwort)["'\s:=]+)[^&"'\s<>,}]+/gi, '$1‹redigiert›'],
  // JWT-förmig (Zugangs- und Erneuerungstoken stehen in Cookies, können aber
  // über eine Fehlermeldung in den Baum geraten).
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '‹jwt›'],
  // E-Mail-Adressen aus dem Demobestand.
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '‹e-mail›'],
  // Lange Base64-Datenadressen (gezeichnete Unterschriften) blähen den Abzug
  // auf und sagen nichts über den Baum aus.
  [/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]{40,}/gi, 'data:image/‹gekürzt›'],
];

export function redigieren(text: string): string {
  return GEHEIM.reduce((wert, [muster, ersatz]) => wert.replace(muster, ersatz), text);
}

// ---------------------------------------------------------------------------
//  Befunde
// ---------------------------------------------------------------------------

export interface Befund {
  art: 'pageerror' | 'console.error' | 'requestfailed';
  text: string;
  /** Adresse der Seite im Moment der Meldung. */
  adresse: string;
  /** Herkunft im ausgelieferten Bündel, sofern der Browser sie nennt. */
  ort?: string;
  stapel?: string;
  hydration: boolean;
  zeitpunkt: string;
}

export interface Umgebungsabzug {
  adresse: string;
  titel: string;
  /** `document.body.outerHTML`, redigiert und gekürzt. */
  dom: string;
  /** Klassen auf `<html>` — das Farbschema sitzt dort und ist ein häufiger Verdächtiger. */
  htmlKlassen: string;
  /**
   * Wie weit das **Dokument** war, als es knallte.
   *
   * `loading` heisst: Der Browser hat noch nicht alles geparst. Das ist der
   * entscheidende Zusammenhang bei dieser Fehlerklasse — Next legt die
   * RSC-Nutzlast als Folge von `__next_f.push`-Skripten *hinter* das Bündel,
   * das die Hydration startet. Wer nur den Fehler sieht, hält ihn für einen
   * Renderfehler; wer diesen Zustand dazu sieht, erkennt einen Wettlauf.
   */
  dokumentzustand: DocumentReadyState;
  /** Zahl der bis dahin eingetroffenen RSC-Nutzlastblöcke. */
  nutzlastbloecke: number;
  /** Wie weit React gekommen ist: Zahl der bereits eingehängten Reaktionswurzeln. */
  reactWurzeln: number;
  bildschirmfoto: string | null;
  /**
   * Die Veränderungen am DOM seit dem ersten Skript, in ihrer Reihenfolge —
   * aus `MUTATIONS_BEOBACHTER`. Der Endzustand zeigt nur Folgen, die
   * Reihenfolge zeigt die Ursache (§13.1 in `docs/HYDRATION.md`).
   */
  mutationen: unknown[];
  /** Die Kinder von `<head>` im Fehlermoment, je als leere Hülle (Tag + Attribute). */
  kopf: string[];
}

export interface Diagnose {
  befunde: Befund[];
  /** Antworten ≥ 400 und gescheiterte Anfragen, für den Zusammenhang. */
  misslungen: string[];
  /** Wurde ein Hydrationsfehler gesehen? */
  hydration(): boolean;
  /**
   * Auf die Lesevorgänge warten, die diese Wache selbst noch offen hat
   * (Dokumentkörper, siehe `ausstehend` unten) — höchstens `hoechstensMs`.
   * Liefert, wie viele offen waren und ob sie in der Frist fertig wurden.
   */
  ausstehendeAbwarten(hoechstensMs: number): Promise<{ offen: number; abgeschlossen: boolean }>;
  /** Alles Gesammelte auswerten, Artefakte schreiben, Fall bewerten. */
  auswerten(testInfo: TestInfo): Promise<void>;
}

// ---------------------------------------------------------------------------
//  Wache
// ---------------------------------------------------------------------------

/**
 * An den **Kontext** gehängt, nicht an eine Seite: Ein zweiter Tab ist eine
 * zweite Seite, und die Sperrfälle arbeiten mit zweien. Ein Hydrationsfehler
 * im zweiten Tab ist derselbe Fehler.
 */
export function diagnoseAnhaengen(context: BrowserContext, testInfo: TestInfo): Diagnose {
  const befunde: Befund[] = [];
  const misslungen: string[] = [];
  const abzuege: Array<Promise<Umgebungsabzug | null>> = [];
  /**
   * Körperlesungen, die diese Wache angestossen hat und die noch laufen
   * (RC-21, 2026-10-01).
   *
   * Jede Dokumentantwort löst unten ein `antwort.text()` aus — ein
   * Protokollaufruf an den Browser, von dem der Fall nichts weiss und auf den
   * bisher niemand wartete. Endet ein Fall unmittelbar nach einer Navigation
   * (`abmelden.spec.ts` endet mit dem Sprung auf die Startseite), läuft dieser
   * Aufruf womöglich noch, während Playwright den Kontext schliesst. Er selbst
   * kann den Fall nicht rot machen — seine Ablehnung wird gefangen —, aber er
   * ist Verkehr auf einem Ziel, das gerade abgebaut wird, und genau beim
   * Abbau scheiterte RC-20 einmal. Ob er beteiligt war, ist nicht belegt;
   * deshalb wird er vor dem Abbau abgewartet (begrenzt) und seine Zahl im
   * Lebenslauf (`rc21-<pid>.jsonl`) festgehalten — der nächste rote Lauf sagt
   * dann, ob einer offen war.
   */
  const ausstehend = new Set<Promise<unknown>>();
  let letztesDokument: Promise<{ adresse: string; html: string } | null> = Promise.resolve(null);
  let dokumentBeimFehler: Promise<{ adresse: string; html: string } | null> | null = null;

  const aufnehmen = (page: Page, art: Befund['art'], text: string, ort?: string, stapel?: string) => {
    const roh = redigieren(text);
    const treffer = istHydrationsfehler(roh);
    befunde.push({
      art,
      text: roh,
      adresse: sichereAdresse(page),
      ort: ort ? redigieren(ort) : undefined,
      stapel: stapel ? redigieren(stapel).split('\n').slice(0, 12).join('\n') : undefined,
      hydration: treffer,
      zeitpunkt: new Date().toISOString(),
    });

    // Der Abzug muss **jetzt** entstehen, nicht am Ende des Falls: Bis dahin
    // hat React den verworfenen Teilbaum längst neu aufgebaut und der
    // Unterschied ist weg.
    if (treffer) {
      abzuege.push(umgebungAbziehen(page, testInfo, befunde.length));
      // Ebenso das Dokument: Bis zum Ende des Falls lädt die Seite oft noch
      // mehrmals neu, und das „letzte" HTML gehört dann zu einem anderen
      // Aufruf mit anderem Datenstand. Am 2026-09-23 zeigte das DOM des
      // Fehlers „Freigeben", das mitgeschriebene HTML schon „Übernehmen" —
      // zwei Zustände, die sich nicht gegenüberstellen liessen.
      if (!dokumentBeimFehler) dokumentBeimFehler = letztesDokument;
    }
  };

  const seiteBeobachten = (page: Page) => {
    page.on('console', (nachricht: ConsoleMessage) => {
      if (nachricht.type() !== 'error' && nachricht.type() !== 'warning') return;
      const text = nachricht.text();
      // Warnungen interessieren nur, wenn sie von der Hydration handeln —
      // sonst wäre der Strom voller Rauschen aus Bibliotheken.
      if (nachricht.type() === 'warning' && !istHydrationsfehler(text)) return;
      const ort = nachricht.location();
      aufnehmen(page, 'console.error', text, ort.url ? `${ort.url}:${ort.lineNumber}:${ort.columnNumber}` : undefined);
    });

    page.on('pageerror', (fehler: Error) => {
      aufnehmen(page, 'pageerror', fehler.message, undefined, fehler.stack);
    });

    page.on('requestfailed', (anfrage: Request) => {
      const grund = anfrage.failure()?.errorText ?? 'unbekannt';
      // Abgebrochene Navigationen und vom Test selbst beendete Anfragen sind
      // kein Befund — sie entstehen beim Schliessen eines Tabs.
      if (/ERR_ABORTED|net::ERR_ABORTED/.test(grund)) return;
      misslungen.push(redigieren(`${anfrage.method()} ${anfrage.url()} → ${grund}`));
    });

    page.on('response', (antwort: Response) => {
      if (antwort.status() >= 400) misslungen.push(redigieren(`${antwort.status()} ${antwort.url()}`));

      /**
       * Das **ausgelieferte** HTML mitschreiben.
       *
       * Ohne es lässt sich nach einem Hydrationsfehler nicht mehr feststellen,
       * ob das DOM verändert wurde oder ob der Client etwas anderes gerendert
       * hat — und genau diese Unterscheidung war in Wave 9.1 der Wendepunkt
       * der Untersuchung. Ein späterer Abruf derselben Adresse taugt nicht:
       * Er liefert einen neuen Aufruf mit neuen Daten.
       *
       * Behalten wird nur die jeweils letzte Dokumentantwort je Seite; sie
       * wird erst beim Schreiben eines Befunds angefasst.
       */
      if (antwort.request().resourceType() !== 'document') return;
      const lesung = antwort
        .text()
        .then((text) => ({ adresse: antwort.url(), html: text }))
        .catch(() => null);
      ausstehend.add(lesung);
      // `lesung` lehnt nie ab (oben gefangen), also auch dieses `finally` nicht.
      void lesung.finally(() => ausstehend.delete(lesung));
      letztesDokument = lesung;
    });
  };

  for (const page of context.pages()) seiteBeobachten(page);
  context.on('page', seiteBeobachten);

  return {
    befunde,
    misslungen,
    hydration: () => befunde.some((b) => b.hydration),
    async ausstehendeAbwarten(hoechstensMs) {
      const offen = ausstehend.size;
      if (offen === 0) return { offen, abgeschlossen: true };
      // Begrenzt: Ein Lesevorgang, der nie zurückkommt, darf den Abbau nicht
      // aufhalten. Die Frist verändert keinen Befund — sie entscheidet nur,
      // ob der Kontext ohne offenen Verkehr der Wache geschlossen wird.
      let uhr: ReturnType<typeof setTimeout> | undefined;
      const abgeschlossen = await Promise.race([
        Promise.allSettled([...ausstehend]).then(() => true),
        new Promise<boolean>((auf) => {
          uhr = setTimeout(() => auf(false), hoechstensMs);
        }),
      ]);
      clearTimeout(uhr);
      return { offen, abgeschlossen };
    },
    async auswerten(info: TestInfo) {
      const treffer = befunde.filter((b) => b.hydration);
      if (treffer.length === 0) return;

      const gesammelt = (await Promise.all(abzuege)).filter((a): a is Umgebungsabzug => a !== null);
      const dokument = await (dokumentBeimFehler ?? letztesDokument);
      const bericht = {
        fall: info.title,
        datei: info.file.replace(/\\/g, '/').split('/').slice(-1)[0],
        projekt: info.project.name,
        wiederholung: info.retry,
        zeitpunkt: new Date().toISOString(),
        hydrationsbefunde: treffer,
        alleBefunde: befunde,
        misslungeneAntworten: misslungen.slice(0, 50),
        umgebung: gesammelt,
        ausgeliefertesHtml: dokument
          ? {
              adresse: redigieren(dokument.adresse),
              html: kuerzen(redigieren(dokument.html)),
            }
          : null,
      };

      mkdirSync(BEFUNDVERZEICHNIS, { recursive: true });
      const datei = join(BEFUNDVERZEICHNIS, `${dateiname(info.title)}-${Date.now()}.json`);
      writeFileSync(datei, JSON.stringify(bericht, null, 2), 'utf8');
      await info.attach('hydrationsbefund', { path: datei, contentType: 'application/json' });

      const zeilen = treffer.map((b) => `  • [${b.art}] ${b.adresse}\n    ${b.text}`);
      const orte = gesammelt.map(
        (a) =>
          `  • ${a.adresse}\n    readyState=${a.dokumentzustand} · RSC-Blöcke=${a.nutzlastbloecke} · Reaktionswurzeln=${a.reactWurzeln}`,
      );
      throw new Error(
        [
          `React-Hydrationsfehler im Browser (${treffer.length}).`,
          '',
          ...zeilen,
          '',
          'Umgebung im Moment des Fehlers:',
          ...orte,
          '',
          `Vollständige Beweise: ${datei}`,
          '',
          'Nicht wegretryen und nicht filtern: Der Baum wird dabei verworfen und neu',
          'aufgebaut. Für die unminifizierte Meldung samt Gegenüberstellung den',
          'Diagnoseserver fahren — `npm run diagnose:server`, dann `npm run e2e:diagnose`.',
        ].join('\n'),
      );
    },
  };
}

// ---------------------------------------------------------------------------
//  Lebenslauf von Browser, Kontext und Seiten (RC-21)
// ---------------------------------------------------------------------------

/**
 * Wann Browser, Kontext und Seiten eines Falls zu Ende gingen — mit
 * Zeitstempel, je Arbeiterprozess in `test-results/rc21-<pid>.jsonl`
 * (RC-21, 2026-10-01).
 *
 * **Der Befund.** In Stresslauf 4 von 5 auf `acae4f1` scheiterte
 * `abmelden.spec.ts` einmal mit „browserContext.close: Target page, context
 * or browser has been closed" — nicht im Fall (der lief in 3.7 s durch),
 * sondern beim Schliessen des Kontexts danach, und ohne den Zusatz „while
 * running route callback". 30 getrennte Nachstellungen waren grün. Die
 * Meldung passt zu einem Browser, dessen Verbindung beim Schliessen schon weg
 * war (Playwright wirft sie aus `Target.disposeBrowserContext`) — belegt ist
 * das nicht, denn der rote Lauf hinterliess nur diese eine Zeile.
 *
 * **Was der nächste rote Lauf hier hinterlässt.** Die Reihenfolge, die die
 * Frage entscheidet: `fall.ende` (Status, offene Seiten, ob der Browser noch
 * verbunden war, wie viele Körperlesungen der Wache offen waren),
 * `fixture.abgebaut` (unser Teil des Abbaus ist durch — danach schliesst
 * Playwright den Kontext), dann `page.close`, `context.close`,
 * `browser.disconnected`, `page.crash` und `arbeiter.ende`, jeweils mit
 * Zeit und freiem Arbeitsspeicher der Maschine.
 *
 *  • `browser.disconnected` vor oder während des Schliessens: Der Browser
 *    (oder die Verbindung zu ihm) war weg — dann gehört die Untersuchung zum
 *    Browserprozess und zur Speicherlage, nicht zum Fall.
 *  • `page.crash`: Der Renderer ist abgestürzt.
 *  • Keines davon, nur `fixture.abgebaut` und danach der Fehler: Der Kontext
 *    wurde auf der Seite von Playwright entsorgt, ohne dass der Browser
 *    wegbrach — dann ist der Abbau selbst (Spur, Routen, offene Aufrufe) der
 *    Verdächtige.
 *
 * **Warum eine eigene Datei je Prozess und `appendFileSync`.** Mehrere
 * Arbeiter (Playwright startet nach einem Fehlschlag einen neuen) schreiben
 * nie in dieselbe Datei; und eine synchron geschriebene Zeile ist auch dann
 * auf der Platte, wenn der Prozess unmittelbar danach endet — genau der Fall,
 * der hier interessiert. `test-results/`, weil `e2e-stress.ts` und der
 * Release-Prüfweg dieses Verzeichnis eines roten Laufs sichern (RC-20); in
 * `hydrationsbefunde/` zählte die Stressreihe jede Datei als
 * Hydrationsbefund.
 *
 * **Was hier nie geschieht:** Diese Mitschrift lässt keinen Fall scheitern
 * und keinen grün werden. Jeder Schreibfehler wird verschluckt — ein
 * Protokoll, das selbst einen Fall rot färbt, wäre ein zweiter Befund, den
 * man dann wieder untersuchen müsste.
 */
export interface Lebenslauf {
  /** Der Fall ist durch (vor unserem Abbau): Status und Lage festhalten. */
  fallEnde(daten?: Record<string, unknown>): void;
  /** Unser Teil des Abbaus ist durch — danach schliesst Playwright den Kontext. */
  abgebaut(): void;
}

const MIB = 1024 * 1024;

/** Browser, an denen `disconnected` schon hängt — einer je Arbeiter, nicht einer je Fall. */
const beobachteteBrowser = new WeakSet<Browser>();
/** Der zuletzt begonnene Fall dieses Arbeiters — für Ereignisse, die nach seinem Ende eintreffen. */
let letzterFall: Record<string, unknown> = {};
let arbeiterEndeBeobachtet = false;

function lebenslaufZeile(datei: string, eintrag: Record<string, unknown>): void {
  try {
    appendFileSync(
      datei,
      `${JSON.stringify({ zeit: new Date().toISOString(), pid: process.pid, freiMb: Math.round(freemem() / MIB), ...eintrag })}\n`,
      'utf8',
    );
  } catch {
    // Siehe oben: Die Mitschrift darf nie selbst zum Befund werden.
  }
}

export function lebenslaufMitschreiben(context: BrowserContext, testInfo: TestInfo): Lebenslauf {
  const datei = join(testInfo.project.outputDir, `rc21-${process.pid}.jsonl`);
  const fall = {
    fall: testInfo.title,
    datei: basename(testInfo.file),
    projekt: testInfo.project.name,
    wiederholung: testInfo.retry,
    arbeiter: testInfo.workerIndex,
  };
  const beginn = Date.now();
  const schreiben = (ereignis: string, daten: Record<string, unknown> = {}) =>
    lebenslaufZeile(datei, { ereignis, ...fall, seitFallbeginnMs: Date.now() - beginn, ...daten });

  try {
    mkdirSync(testInfo.project.outputDir, { recursive: true });
    letzterFall = fall;
    const browser = context.browser();

    if (browser && !beobachteteBrowser.has(browser)) {
      beobachteteBrowser.add(browser);
      const engine = browser.browserType().name();
      lebenslaufZeile(datei, { ereignis: 'browser.beobachtet', ...fall, engine, version: browser.version() });
      // Absichtlich `letzterFall` zum Zeitpunkt des Ereignisses, nicht `fall`:
      // Die Verbindung kann nach dem Ende dieses Falls abreissen, und dann
      // gehört das Ereignis zu dem Fall, der gerade lief oder abgebaut wurde.
      browser.on('disconnected', () => lebenslaufZeile(datei, { ereignis: 'browser.disconnected', ...letzterFall, engine }));
    }
    if (!arbeiterEndeBeobachtet) {
      arbeiterEndeBeobachtet = true;
      process.once('exit', (code) => lebenslaufZeile(datei, { ereignis: 'arbeiter.ende', ...letzterFall, code }));
    }

    schreiben('fall.beginn', { browserVerbunden: browser?.isConnected() ?? null });

    let seiten = 0;
    const seiteBeobachten = (page: Page) => {
      const seite = ++seiten;
      page.on('crash', () => schreiben('page.crash', { seite, adresse: sichereAdresse(page) }));
      page.on('close', () => schreiben('page.close', { seite, adresse: sichereAdresse(page) }));
    };
    for (const page of context.pages()) seiteBeobachten(page);
    context.on('page', seiteBeobachten);
    context.on('close', () => schreiben('context.close', { browserVerbunden: browser?.isConnected() ?? null }));

    return {
      fallEnde(daten = {}) {
        schreiben('fall.ende', {
          status: testInfo.status ?? null,
          fehler: testInfo.errors.length,
          dauerMs: Date.now() - beginn,
          offeneSeiten: context.pages().length,
          browserVerbunden: browser?.isConnected() ?? null,
          rssMb: Math.round(process.memoryUsage().rss / MIB),
          ...daten,
        });
      },
      abgebaut() {
        schreiben('fixture.abgebaut', { browserVerbunden: browser?.isConnected() ?? null });
      },
    };
  } catch (fehler) {
    // Auch ein Fehler beim Anhängen bleibt ein Eintrag, kein Fehlschlag.
    schreiben('lebenslauf.fehler', { meldung: redigieren(String((fehler as Error)?.message ?? fehler)) });
    return { fallEnde: () => undefined, abgebaut: () => undefined };
  }
}

// ---------------------------------------------------------------------------
//  Hilfen
// ---------------------------------------------------------------------------

/** Eine geschlossene Seite hat keine Adresse mehr — das darf nicht werfen. */
function sichereAdresse(page: Page): string {
  try {
    return redigieren(page.url());
  } catch {
    return '‹Seite geschlossen›';
  }
}

/** Nur das, was ein Dateiname verträgt — Fallnamen enthalten Umlaute und Kommas. */
function dateiname(titel: string): string {
  return titel
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
    .toLowerCase();
}

/** Grenze für den DOM-Abzug: gross genug für den Rahmen, klein genug für eine Datei. */
const DOM_GRENZE = 400_000;

/**
 * Das ausgelieferte HTML ist auf diesen Seiten gut eine halbe Million Zeichen
 * gross — der grösste Teil davon ist die RSC-Nutzlast in `__next_f.push`. Für
 * die Gegenüberstellung zählt der Anfang, also der Rahmen und der Seiteninhalt.
 */
const HTML_GRENZE = 700_000;

const kuerzen = (text: string): string =>
  text.length > HTML_GRENZE ? `${text.slice(0, HTML_GRENZE)}\n‹gekürzt bei ${HTML_GRENZE} Zeichen›` : text;

async function umgebungAbziehen(
  page: Page,
  testInfo: TestInfo,
  laufendeNummer: number,
): Promise<Umgebungsabzug | null> {
  try {
    const abzug = await page.evaluate(() => ({
      adresse: window.location.href,
      titel: document.title,
      dom: document.body?.outerHTML ?? '',
      htmlKlassen: document.documentElement.className,
      dokumentzustand: document.readyState,
      // Nexts RSC-Nutzlast kommt als Folge von `__next_f.push`-Skripten an.
      // Ihre Zahl im Fehlermoment sagt, ob die Hydration auf unvollständige
      // Daten getroffen ist.
      nutzlastbloecke: (window as unknown as { __next_f?: unknown[] }).__next_f?.length ?? -1,
      // React hängt `__reactContainer$…` an das **Wurzelelement** der
      // Hydration — bei Next ist das `document` bzw. `<body>`, nicht ein
      // Nachfahre. Geprüft werden deshalb beide.
      reactWurzeln: [document.documentElement, document.body].filter((el) =>
        el ? Object.keys(el).some((schluessel) => schluessel.startsWith('__reactContainer$')) : false,
      ).length,
      // Vollständig, nicht die ersten paar hundert: Die Einträge des Parsers
      // allein füllen 400, und der Hydrationsfehler stand dahinter.
      mutationen: ((window as unknown as { __hydrationsMutationen?: unknown[] }).__hydrationsMutationen ?? []).slice(0, 6000),
      // `<head>` ohne Skriptinhalte — der Abzug des DOM umfasst nur `<body>`,
      // und nach dem Fehler entfernt React dort Knoten.
      kopf: document.head
        ? [...document.head.children].map((el) => {
            const kopie = el.cloneNode(false) as Element;
            return kopie.outerHTML.slice(0, 200);
          })
        : [],
    }));

    let bildschirmfoto: string | null = null;
    try {
      mkdirSync(BEFUNDVERZEICHNIS, { recursive: true });
      const ziel = join(BEFUNDVERZEICHNIS, `${dateiname(testInfo.title)}-${laufendeNummer}-${Date.now()}.png`);
      await page.screenshot({ path: ziel, fullPage: false, timeout: 5_000 });
      bildschirmfoto = ziel;
    } catch {
      // Ein Bildschirmfoto ist die Zugabe, kein Beweis — wenn die Seite
      // gerade navigiert, fehlt es eben.
    }

    const dom = redigieren(abzug.dom);
    return {
      adresse: redigieren(abzug.adresse),
      titel: redigieren(abzug.titel),
      dom: dom.length > DOM_GRENZE ? `${dom.slice(0, DOM_GRENZE)}\n‹gekürzt bei ${DOM_GRENZE} Zeichen›` : dom,
      htmlKlassen: abzug.htmlKlassen,
      dokumentzustand: abzug.dokumentzustand,
      nutzlastbloecke: abzug.nutzlastbloecke,
      reactWurzeln: abzug.reactWurzeln,
      bildschirmfoto,
      mutationen: abzug.mutationen,
      kopf: abzug.kopf.map((zeile) => redigieren(zeile)),
    };
  } catch {
    // Die Seite kann in genau diesem Moment navigieren oder schliessen.
    return null;
  }
}
