import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineConfig } from '@playwright/test';

import { DIAGNOSE_CACHE_DIR, DIAGNOSE_PORT } from './scripts/diagnose-umgebung';

/**
 * Browser-Prüfungen (Gate 4D.1).
 *
 * ---------------------------------------------------------------------------
 *  Warum es diese zweite Prüfebene überhaupt gibt
 * ---------------------------------------------------------------------------
 *
 * Die Prüfungen unter `tests/api` und `tests/pages` fahren die Anwendung
 * über echtes HTTP an. Das ist die richtige Ebene für Berechtigungen,
 * Statuscodes und ausgeliefertes HTML — und sie bleibt unverändert bestehen.
 * Drei Dinge kann sie aber grundsätzlich nicht beobachten:
 *
 *  • **Ob PDF.js im Browser tatsächlich rendert.** Dass Worker und wasm aus
 *    dem eigenen Ursprung ausgeliefert werden, ist über HTTP geprüft; dass
 *    die CSP den Worker dann auch startet, ist eine Aussage über eine
 *    Browser-Laufzeit. Bis hierher war sie *konfigurativ* begründet, nicht
 *    empirisch belegt.
 *  • **Ob eine gezeichnete Unterschrift entsteht.** Ein `imageDataUrl` im
 *    Anfragekörper beweist, dass der Server ein PNG annimmt. Er beweist
 *    nicht, dass die Pointer-Events des Unterschriftenfelds im Browser eine
 *    Zeichnung erzeugen.
 *  • **Ob die Gerätesperre den Browser wirklich einschliesst.** Der
 *    HTTP-Test zeigt 423 auf einem Cookie-Kopf. Im Browser gibt es
 *    ausserdem Zurück-Taste, zweiten Tab, Neuladen, geschlossenen Tab und
 *    Verlauf — Wege, die eine Sperre umgehen könnten, ohne dass ein
 *    einziger Statuscode falsch wäre.
 *
 * Diese Ebene ergänzt also, sie ersetzt nichts.
 *
 * ---------------------------------------------------------------------------
 *  Warum Playwright und warum nur eine Plattform
 * ---------------------------------------------------------------------------
 *
 * Vor Gate 4D.1 gab es im Repository keinerlei Browser-Harness — kein
 * Playwright, kein Cypress, kein Selenium, keine CI-Browserstufe. Die Wahl war
 * also frei, und sie fiel auf Playwright, weil es als einziges der drei alle
 * vier Dinge mitbringt, die diese Reihe braucht: echte Pointer-Ereignisse auf
 * einem Canvas (`mouse.move/down/up`), mehrere `BrowserContext` nebeneinander
 * (zweites Gerät) mit mehreren Seiten *im selben* Kontext (zweiter Tab),
 * Zugriff auf Netzwerkantworten samt Status, und ein eigener Cookie-Speicher
 * je Kontext. Eine zweite Plattform daneben gäbe es nicht — zwei Harnesse
 * bedeuten zwei Wahrheiten darüber, was „grün" heisst.
 *
 * Version fest verdrahtet (`--save-exact`): Ein Browsertest, der nach einem
 * Nebenversionssprung anders ausgeht, prüft die Anwendung nicht mehr.
 *
 * ---------------------------------------------------------------------------
 *  Umgebung
 * ---------------------------------------------------------------------------
 *
 * Gefahren wird gegen **dieselbe** Umgebung wie die bestehende Reihe:
 * `scripts/test-server.ts` auf Port 3001, gegen die Testdatenbank, mit
 * `TRUSTED_PROXY_MODE=NONE` und dateibasierten Rate-Limit-Zählern. Kein
 * eigener Serverstart, keine zweite Datenbank, keine zweite Seed-Strategie —
 * was die HTTP-Reihe sieht, sieht der Browser auch.
 *
 * `reuseExistingServer` ist bewusst **immer** an: Läuft bereits ein
 * Testserver (der übliche Fall beim Arbeiten), wird er verwendet; sonst
 * startet Playwright ihn und wartet auf `/api/auth/session` statt auf eine
 * geratene Anzahl Sekunden.
 *
 * `CLENARIS_TEST_CACHE_DIR` steht hier ausdrücklich auf demselben Wert, den
 * `test-server.ts` und `tests/helpers/rate-limit.ts` als Vorgabe verwenden.
 * Das ist kein Doppel, sondern die Bedingung dafür, dass ein *bereits
 * laufender* Server und dieser Prozess denselben Postausgang meinen.
 */

/**
 * Diagnosemodus (`E2E_DIAGNOSE=1`).
 *
 * Dieselben Fälle, aber gegen den **Entwicklungsbau** auf Port 3002
 * (`scripts/diagnose-server.ts`). Der einzige Unterschied, auf den es ankommt:
 * React meldet dort Hydrationsabweichungen im Klartext, mit der
 * Gegenüberstellung von Server- und Client-Baum, statt als
 * „Minified React error #418".
 *
 * **Das ist eine Untersuchung, keine Auslieferungsprüfung.** Der normale Lauf
 * (`npm run e2e`) bleibt unverändert der Produktionsbau — ein Befund von hier
 * wird dort nachgewiesen, nicht umgekehrt. Deshalb steht der Modus hinter
 * einer Variablen und nicht hinter einem zweiten Projekt: Wer `npm run e2e`
 * ruft, soll unter keinen Umständen versehentlich den Entwicklungsbau prüfen.
 */
const diagnose = process.env.E2E_DIAGNOSE === '1';

const port = process.env.E2E_PORT?.trim() || (diagnose ? DIAGNOSE_PORT : '3001');
const baseURL = `http://127.0.0.1:${port}`;
/** HTTPS-Vorschaltung für WebKit (`scripts/test-https-vorschaltung.ts`, Begründung beim Projekt). */
const httpsPort = process.env.E2E_HTTPS_PORT?.trim() || '3443';
const httpsBaseURL = `https://127.0.0.1:${httpsPort}`;

/** Derselbe Vorgabewert wie in `scripts/test-server.ts` und `tests/helpers/rate-limit.ts`. */
const cacheDir =
  process.env.CLENARIS_TEST_CACHE_DIR?.trim() ||
  (diagnose ? DIAGNOSE_CACHE_DIR : join(tmpdir(), 'clenaris-tests', 'cache'));

// Die Helfer aus `tests/helpers` lesen beides beim Laden des Moduls — auch im
// Worker-Prozess, der diese Datei erneut auswertet.
process.env.TEST_BASE_URL = baseURL;
process.env.CLENARIS_TEST_CACHE_DIR = cacheDir;

/** Was ausser Chromium auch Firefox und WebKit fahren (Begründung beim Projekt). */
const MEHRERE_ENGINES = [
  '**/*.browser.spec.ts',
  '**/offerte-rabatt.spec.ts',
  '**/scan.spec.ts',
  '**/sitzung-tabs.spec.ts',
  '**/sitzung-leerlauf.spec.ts',
];

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',

  /**
   * Nacheinander, aus demselben Grund wie `--test-concurrency=1` in der
   * HTTP-Reihe: Alle Dateien teilen sich eine Datenbank und dieselben fünf
   * Demokonten. Dazu kommt hier das Anmeldelimit — acht Versuche je fünf
   * Minuten und Adresse, und ohne Proxy-Modus teilen sich alle Aufrufer eine
   * Adresse. Nebenläufigkeit wäre nicht schneller, sondern unzuverlässig.
   */
  fullyParallel: false,
  workers: 1,

  /**
   * Kein Wiederholen. Ein Browsertest, der erst im zweiten Anlauf grün wird,
   * hat etwas gefunden — das soll man sehen und nicht wegretryen.
   */
  retries: 0,
  forbidOnly: true,
  /**
   * Im Diagnosemodus baut `next dev` jede Seite beim ersten Aufruf — der
   * erste Fall je Route braucht dadurch ein Vielfaches. Die Grenze wird nur
   * dort angehoben; für die Auslieferungsprüfung bleibt sie scharf, weil eine
   * grosszügige Zeitgrenze dort genau die Langsamkeit verdeckt, die man sehen
   * will.
   */
  timeout: diagnose ? 300_000 : 90_000,
  expect: { timeout: diagnose ? 30_000 : 15_000 },

  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  outputDir: 'test-results',

  globalSetup: './tests/e2e/helpers/global-setup.ts',

  use: {
    baseURL,
    /**
     * Spuren, Bildschirmfotos und Video **nur bei Fehlschlag**, und alle drei
     * landen in `test-results/`, das nicht verfolgt wird. Der Grund ist nicht
     * Sparsamkeit: Eine Spur der Unterzeichnungsseite enthält den rohen
     * Zugangstoken aus dem Fragment und Kundennamen aus dem Demobestand. Als
     * Repository-Artefakt wäre das ein Geheimnis, das den Umweg über einen
     * Testlauf genommen hat.
     */
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: diagnose ? 30_000 : 15_000,
    navigationTimeout: diagnose ? 120_000 : 30_000,
    locale: 'de-CH',
    timezoneId: 'Europe/Zurich',
  },

  projects: [
    {
      name: 'chromium',
      // `*.webkit.spec.ts` gehört allein dem WebKit-Auftrag: Die Fälle laufen
      // über die HTTPS-Vorschaltung und prüfen genau das (W-02).
      testIgnore: '**/*.webkit.spec.ts',
      use: {
        browserName: 'chromium',
        /**
         * **Der volle Chromium-Bau, nicht die Headless-Shell.**
         *
         * Playwrights Vorgabe ist `headless_shell` — ein abgespeckter Bau ohne
         * Erweiterungen und ohne PDF-Plugin. Genau dieser Unterschied hat einen
         * Fehler durchgelassen, der jede PDF-Anzeige des Produkts in jedem
         * echten Chrome und Edge zerstörte: Trifft `application/pdf` auf eine
         * `Content-Disposition`, übernimmt Chromiums Plugin-Interceptor den
         * Datenstrom und beantwortet den `fetch()` des Viewers mit einem leeren
         * 204 (die Messung steht in `src/lib/api/binary-response.ts`). Die
         * Headless-Shell kennt den Interceptor nicht und lieferte brav 200 —
         * zwanzig grüne Browsertests über einem Produkt, das im Browser nicht
         * funktionierte.
         *
         * Nachgemessen am 2026-09-20 gegen dieselbe Antwort:
         *
         * ```
         *   headless_shell            → 200, 3449 Bytes   (blind)
         *   channel chromium, kopflos → 204, 0 Bytes      (sieht den Fehler)
         *   channel chromium, sichtbar→ 204, 0 Bytes
         * ```
         *
         * Der Kanal bleibt kopflos und damit CI-tauglich; er ist nur der
         * *vollständige* Browser statt der Attrappe. Wer ihn zurückstellt,
         * nimmt der Reihe die Fähigkeit, diese Klasse von Fehlern zu sehen.
         */
        channel: 'chromium',
        viewport: { width: 1366, height: 900 },
        deviceScaleFactor: 1,
      },
    },
    /**
     * **Firefox und WebKit — für die browserübergreifenden Fälle
     * (`*.browser.spec.ts`).** Seit 2026-09-28.
     *
     * Anlass war ein Fehler, den Chromium nicht zeigen kann: Bilder der
     * Website, die in Firefox erst nach mehrmaligem Neuladen erschienen. Eine
     * Reihe, die nur eine Engine fährt, erklärt ein Produkt für gesund, das in
     * einem Viertel der Browser der Kundschaft kaputt ist.
     *
     * Bewusst nicht die ganze Reihe in drei Engines: Die Gate-Fälle prüfen
     * Signaturkern, Gerätesperre und PDF-Plugin — Aussagen über die Anwendung,
     * nicht über die Engine, und die PDF-Fälle hängen ausdrücklich an Chromiums
     * Plugin (siehe oben). Die öffentlichen Seiten und die Bausteine, die sich
     * je Engine unterscheiden können (Bilder, Auswahlfelder, Scrollsperre),
     * stehen in `*.browser.spec.ts` und laufen überall. Chromium fährt sie mit,
     * weil sein Projekt jede Datei nimmt.
     *
     * Dazu drei Dateien mit ihrem alten Namen (`MEHRERE_ENGINES`): Der
     * Rabattfehler der Offertenmaske war ein Scrollsperren-Fehler — genau die
     * Art, die je Engine anders ausfällt —, der Scanner hat in Firefox und
     * Safari keinen `BarcodeDetector` und lebt dort vom Eingabeweg, und die
     * Sitzungsabstimmung zwischen Tabs hängt an `BroadcastChannel` und
     * `storage`-Ereignissen. Umbenannt wurden sie nicht, weil Pendenzen,
     * Bedrohungsmodell und Prüfmatrix sie unter diesem Namen als Beleg führen.
     * Seit 2026-10-01 kommt `sitzung-leerlauf.spec.ts` dazu, aus demselben
     * Grund wie die Tababstimmung (gemeinsamer Zeitstempel, Abmeldung über
     * `BroadcastChannel`) — und bewusst nicht als `*.browser.spec.ts`: Jeder
     * ihrer Fälle ist angemeldet, und angemeldet fährt WebKit nur die
     * Rauchreihe (siehe unten).
     *
     * **WebKit fährt nur, was ohne Anmeldung im Browser auskommt.** Die
     * Anmeldecookies sind im Produktionsbau `Secure`, der Prüfserver spricht
     * `http://127.0.0.1`. Chromium und Firefox behandeln die Loopback-Adresse
     * als sicheren Ursprung und schicken das Cookie; Playwrights WebKit nicht
     * — nach der Anmeldung leitet jede Seite zurück (gemessen 2026-09-28).
     * `Secure` für die Prüfung abzuschalten hiesse, eine Schutzeinstellung
     * für den Test aufzuweichen. Seit 2026-09-29 spricht WebKit deshalb
     * **HTTPS** über eine Vorschaltung vor demselben Prüfserver
     * (`scripts/test-https-vorschaltung.ts`, selbstsigniert, nur hier mit
     * `ignoreHTTPSErrors`) — wie Safari im Betrieb. Damit fährt WebKit neben
     * den `*.browser.spec.ts` eine kleine angemeldete Rauchreihe
     * (`*.webkit.spec.ts`), nicht die ganze Chromium-Reihe.
     */
    {
      name: 'firefox',
      testMatch: MEHRERE_ENGINES,
      use: { browserName: 'firefox', viewport: { width: 1366, height: 900 }, deviceScaleFactor: 1 },
    },
    {
      name: 'webkit',
      testMatch: ['**/*.browser.spec.ts', '**/*.webkit.spec.ts'],
      use: {
        browserName: 'webkit',
        viewport: { width: 1366, height: 900 },
        deviceScaleFactor: 1,
        baseURL: diagnose ? baseURL : httpsBaseURL,
        ignoreHTTPSErrors: true,
      },
    },
  ],

  webServer: [
    {
      command: diagnose ? 'npm run diagnose:server' : 'npm run test:server',
      url: `${baseURL}/api/auth/session`,
      reuseExistingServer: true,
      timeout: 180_000,
      // Im Diagnosemodus ist die Serverausgabe Teil des Beweismaterials: Next
      // schreibt die Hydrationsgegenüberstellung auch dorthin.
      stdout: diagnose ? 'pipe' : 'ignore',
      stderr: 'pipe',
      env: {
        PORT: port,
        CLENARIS_TEST_CACHE_DIR: cacheDir,
      },
    },
    {
      command: 'npx tsx scripts/test-https-vorschaltung.ts',
      url: `${httpsBaseURL}/api/health`,
      ignoreHTTPSErrors: true,
      reuseExistingServer: true,
      timeout: 60_000,
      stdout: 'ignore',
      stderr: 'pipe',
      env: { E2E_PORT: port, E2E_HTTPS_PORT: httpsPort },
    },
  ],
});
