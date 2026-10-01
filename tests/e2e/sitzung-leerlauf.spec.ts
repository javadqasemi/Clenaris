import type { BrowserContext, Page } from '@playwright/test';

import { test, expect } from './helpers/basis';
import {
  anfragenVerfolgen,
  imBrowserAnmelden,
  konsoleUeberwachen,
  netzUeberwachen,
  ressourcenfehler,
  type Netzwache,
} from './helpers/browser';
import { LEERLAUF_DAUERHAFT_S, LEERLAUF_S, tokenHash } from '../helpers/sitzung';
import { testDb, testDbGrund } from '../helpers/testdb';

/**
 * Leerlauf der Sitzung im Browser (2026-10-01).
 *
 * ---------------------------------------------------------------------------
 *  Was diese Datei beweist, und was daneben schon bewiesen ist
 * ---------------------------------------------------------------------------
 *
 * Der Server beendet eine Sitzung, deren Erneuerungstoken älter ist als das
 * Leerlauffenster — das prüft `tests/api/sitzung-leerlauf.test.ts` über HTTP.
 * Der Aktivitätswächter im Browser (`session-keepalive.tsx`) ist die Anzeige
 * dieser Regel: Er warnt zwei Minuten vor Ablauf, meldet danach selbst ab und
 * folgt dem Server, wenn der eine Erneuerung verweigert. Bis hierher war von
 * all dem im Browser nur die Abstimmung zwischen Tabs geprüft
 * (`sitzung-tabs.spec.ts`: Arbeit im einen Tab hält den anderen, Warnung und
 * „Abmelden" gelten für alle). Ungeprüft war gerade das, wofür es das Fenster
 * gibt: dass eine Person, die **nichts** tut, wirklich abgemeldet wird —
 * mit Grund und Rücksprungziel —, dass eine Eingabe den Ablauf verschiebt
 * statt ihn nur zu verbergen, dass „Angemeldet bleiben" im Browser das lange
 * Fenster bekommt, und dass eine vom Server beendete Sitzung im Browser nicht
 * als scheinbar angemeldete Seite stehen bleibt.
 *
 * ---------------------------------------------------------------------------
 *  Zwei Uhren
 * ---------------------------------------------------------------------------
 *
 * Die Zeit des Browsers läuft über Playwrights Uhr (`context.clock`), wie in
 * `sitzung-tabs.spec.ts`: vorgespult statt abgewartet. Der Server rechnet in
 * echter Zeit weiter — für ihn vergehen während eines Falls nur Sekunden.
 * Daraus folgt die Aufteilung: Was der **Browser** entscheidet (Warnung,
 * eigene Abmeldung), prüft die vorgespulte Uhr. Was der **Server** entscheidet
 * (Ablehnung der Erneuerung), lässt sich mit ihr nicht herbeiführen; dafür
 * wird wie in der HTTP-Reihe der Erneuerungstoken in der Testdatenbank
 * zurückdatiert (`createdAt`), und der Browser trifft beim nächsten
 * vorbeugenden Erneuern auf die echte Ablehnung.
 *
 * Drei Bewegungen der Uhr, und warum jede an ihrer Stelle steht:
 *
 *  • `runFor` lässt jede fällige Zeitschaltung einzeln laufen — der Wächter
 *    prüft alle fünf Sekunden, also genau so, wie er es in Wirklichkeit täte.
 *  • `fastForward` springt und lässt jede Zeitschaltung **höchstens einmal**
 *    laufen (der zugeklappte Rechner). Für sieben Tage ist das der einzige
 *    gangbare Weg — `runFor` müsste 120 960 Prüfungen ausführen. Der Preis:
 *    Der Wächter sieht den Sprung nur in seiner **einen** Prüfung am Ende.
 *    Springt man über das ganze Fenster, meldet er sofort ab und zeigt nie
 *    eine Warnung; der Sprung endet deshalb mitten im Warnfenster.
 *  • `pauseAt` hält die Uhr an und richtet dabei alle Prüftakte auf denselben
 *    Zeitpunkt aus (ein Sprung über einen fälligen Takt setzt ihn auf das
 *    Sprungziel). Das braucht nur der Fall mit zwei Tabs — Begründung dort.
 *
 * ---------------------------------------------------------------------------
 *  Engines
 * ---------------------------------------------------------------------------
 *
 * Chromium und Firefox (`MEHRERE_ENGINES` in `playwright.config.ts`), wie
 * `sitzung-tabs`: Gemeinsamer Zeitstempel und Abmeldung zwischen Tabs hängen
 * an `localStorage`, `storage`-Ereignissen und `BroadcastChannel`, und die
 * verhalten sich je Engine verschieden genug, um beide zu fahren. WebKit
 * nicht: Jeder Fall hier ist angemeldet, und Playwrights WebKit schickt die
 * `Secure`-Cookies des Produktionsbaus nicht über `http://127.0.0.1` (W-02);
 * angemeldet fährt WebKit nur die Rauchreihe über die HTTPS-Vorschaltung.
 */

const MINUTE = 60_000;

/**
 * Das Fenster, wie der Wächter es rechnet: `max(60 s, idleSeconds)`, gewarnt
 * wird `min(2 min, Fenster / 4)` vorher. Die Formel steht hier ein zweites
 * Mal, weil eine Prüfung ihre Erwartung nicht aus dem Code lesen darf, den sie
 * prüft — mit den Vorgaben (15 Minuten) ergibt sie genau die zwei Minuten aus
 * `docs/SITZUNG.md`.
 */
const LEERLAUF_MS = Math.max(MINUTE, LEERLAUF_S * 1000);
const WARNUNG_VORHER_MS = Math.min(2 * MINUTE, Math.floor(LEERLAUF_MS / 4));
const DAUERHAFT_MS = Math.max(MINUTE, LEERLAUF_DAUERHAFT_S * 1000);
const DAUERHAFT_WARNUNG_VORHER_MS = Math.min(2 * MINUTE, Math.floor(DAUERHAFT_MS / 4));

/** Takt des Wächters (`CHECK_EVERY_MS`). */
const TAKT_MS = 5_000;

/**
 * Abstand zur Grenze bei den Fällen mit laufender Uhr. Zwischen dem
 * Anlaufen des Wächters und dem ersten Vorspulen vergehen echte Sekunden
 * (Anmeldung, Warten auf die Seite) — die Uhr läuft dort mit. Zehn Sekunden
 * decken das reichlich und sind klein gegen die zwei Minuten der Warnung.
 */
const SPIELRAUM_MS = 10_000;

/**
 * Der Schlüssel des gemeinsamen Zeitstempels im Browserspeicher
 * (`SPEICHER_SCHLUESSEL` in `session-keepalive.tsx`). Er steht hier als
 * Zeichenkette, weil jene Datei ein Client-Modul ist, das im Prüfprozess
 * nicht geladen werden soll. Ändert sich der Name, scheitert jeder Fall
 * sofort am Anlaufen des Wächters — laut, nicht still.
 */
const AKTIVITAET = 'clenaris.sitzung.letzteAktivitaet';

const WARNUNG = /Sitzung läuft bald ab/;

const db = testDb();

/** Der Zugang zur Testdatenbank — oder ein Fehlschlag, nie ein Überspringen. */
function datenbank(): NonNullable<typeof db> {
  if (!db) throw new Error(`Diese Prüfung braucht die Testdatenbank (${testDbGrund()}).`);
  return db;
}

/** Pfad samt Suchteil der Seite — das, was der Wächter als Rücksprungziel mitgibt. */
function pfadVon(seite: Page): string {
  const adresse = new URL(seite.url());
  return `${adresse.pathname}${adresse.search}`;
}

/** Der gemeinsame Zeitstempel der letzten Aktivität (Browserzeit) — 0, solange kein Wächter lief. */
function letzteAktivitaet(seite: Page): Promise<number> {
  return seite.evaluate((schluessel) => Number(window.localStorage.getItem(schluessel)) || 0, AKTIVITAET);
}

/**
 * Warten, bis der Wächter dieser Seite angelaufen ist.
 *
 * Er schreibt beim Einhängen seinen Startzeitpunkt in den gemeinsamen
 * Speicher. Vorher zu spulen hiesse, Zeit vergehen zu lassen, die niemand
 * misst — die Warnung käme dann scheinbar zu spät, und man suchte den Fehler
 * im Wächter.
 */
async function waechterLaeuft(seite: Page, groesserAls = 0): Promise<void> {
  await expect
    .poll(() => letzteAktivitaet(seite), { message: 'Der Aktivitätswächter ist auf dieser Seite nicht angelaufen.' })
    .toBeGreaterThan(groesserAls);
}

/** Eine Eingabe, wie sie der Wächter zählt — jedes Mal an eine neue Stelle, sonst feuert kein `pointermove`. */
function eingabe(seite: Page, nummer: number): Promise<void> {
  return seite.mouse.move(600 + nummer * 3, 400 + (nummer % 2) * 5);
}

/** Hält der Server die Sitzung dieses Browsers für angemeldet? Gefragt mit den echten Cookies des Browsers. */
function angemeldetLautServer(seite: Page): Promise<boolean> {
  return seite.evaluate(async () => {
    const antwort = await fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' });
    const koerper = (await antwort.json()) as { data?: { authenticated?: boolean } };
    return koerper.data?.authenticated === true;
  });
}

/**
 * Der Erneuerungstoken, den dieser Browser gerade hält — als Zeile der
 * Datenbank, über den Hash, nie über den Rohwert (Vorbild `gate4d-sperre`).
 * Der Rohwert wird nur zurückgegeben, um zu prüfen, dass er **nicht** im
 * Browserspeicher steht; keine Meldung gibt ihn aus.
 */
async function erneuerungstokenDesBrowsers(context: BrowserContext) {
  const keks = (await context.cookies()).find((k) => k.name === 'clenaris_rt' && k.value !== '');
  expect(keks, 'Der Browser hält kein Erneuerungscookie.').toBeDefined();
  const zeile = await datenbank().refreshToken.findUnique({ where: { tokenHash: tokenHash(keks!.value) } });
  expect(zeile, 'Der Erneuerungstoken des Browsers steht nicht in der Datenbank.').not.toBeNull();
  return { zeile: zeile!, roh: keks!.value };
}

/** Noch nicht widerrufene Tokens einer Rotationsfamilie. */
function lebendeTokens(familie: string): Promise<number> {
  return datenbank().refreshToken.count({ where: { family: familie, revokedAt: null } });
}

/** Wiederverwendungsalarme einer Rotationsfamilie (`REFRESH_REUSE_DETECTED`, CRITICAL). */
function wiederverwendungsalarme(familie: string): Promise<number> {
  return datenbank().securityEvent.count({
    where: { kind: 'REFRESH_REUSE_DETECTED', context: { path: ['family'], equals: familie } },
  });
}

/** Sitzungscookies, die der Browser noch hält. */
async function sitzungscookies(context: BrowserContext): Promise<string[]> {
  return (await context.cookies())
    .filter((k) => (k.name === 'clenaris_at' || k.name === 'clenaris_rt') && k.value !== '')
    .map((k) => k.name);
}

const abmeldungen = (netz: Netzwache) => netz.treffer(/\/api\/auth\/logout$/);
const erneuerungen = (netz: Netzwache) => netz.treffer(/\/api\/auth\/refresh$/).filter((e) => e.methode === 'POST');

test.describe('Leerlauf der Sitzung im Browser', () => {
  test('Ohne Eingabe: Warnung zwei Minuten vorher, dann Abmeldung wegen Inaktivität', async ({ context, page }) => {
    await context.clock.install();
    const konsole = konsoleUeberwachen(page);
    const netz = netzUeberwachen(context);
    await imBrowserAnmelden(page, 'admin', /\/admin/);
    await waechterLaeuft(page);
    const verkehr = anfragenVerfolgen(page);
    const hier = pfadVon(page);
    const { zeile, roh } = await erneuerungstokenDesBrowsers(context);

    // Im Browserspeicher steht nur der Zeitstempel — kein Token, keine
    // Kennung (docs/SITZUNG.md). Die Sitzung lebt allein in HttpOnly-Cookies.
    const speicher = await page.evaluate(() => JSON.stringify({ ...window.localStorage, ...window.sessionStorage }));
    expect(speicher.includes(roh), 'Der Erneuerungstoken steht im Browserspeicher.').toBe(false);

    // Kurz vor der Warnung: nichts. Die vorbeugende Erneuerung nach zehn
    // Minuten fällt in diese Spanne — der Wächter erneuert, solange die letzte
    // Aktivität (hier: das Anlaufen nach der Anmeldung) im Fenster liegt — und
    // muss durchgehen; geprüft am Ende des Falls.
    await context.clock.runFor(LEERLAUF_MS - WARNUNG_VORHER_MS - SPIELRAUM_MS);
    await verkehr.ruhig();
    await expect(page.getByRole('dialog'), 'Die Warnung kam vor der Zeit.').toHaveCount(0);
    expect(pfadVon(page)).toBe(hier);

    // Kurz danach: die Warnung — mit dem Hinweis, was gleich geschieht, und
    // mit dem Weg zurück.
    await context.clock.runFor(2 * SPIELRAUM_MS);
    const warnung = page.getByRole('dialog', { name: WARNUNG });
    await expect(warnung).toBeVisible();
    await expect(warnung).toContainText(/abgemeldet/);
    await expect(warnung.getByRole('button', { name: 'Weiterarbeiten' })).toBeVisible();
    expect(abmeldungen(netz), 'Die Warnung hat schon abgemeldet.').toEqual([]);

    // Ohne Antwort: Abmeldung „wegen Inaktivität", mit Rücksprungziel.
    await context.clock.runFor(WARNUNG_VORHER_MS);
    await expect(page).toHaveURL(/\/auth\/anmelden\?.*grund=inaktiv/);
    expect(new URL(page.url()).searchParams.get('weiter'), 'Das Rücksprungziel ging verloren.').toBe(hier);
    await expect(page.getByText(/nach längerer Inaktivität abgemeldet/)).toBeVisible();

    // Die Abmeldung ist eine des Servers, nicht nur eine Weiterleitung im
    // Browser: genau ein Abmeldeaufruf, der Token widerrufen, die Cookies weg.
    expect(abmeldungen(netz), 'Der Wächter hat nicht (oder mehrfach) abgemeldet.').toHaveLength(1);
    expect(await lebendeTokens(zeile.family), 'Die Familie hat nach der Abmeldung noch einen lebenden Token.').toBe(0);
    expect(await sitzungscookies(context), 'Der Browser hält nach der Abmeldung noch Sitzungscookies.').toEqual([]);
    expect(await angemeldetLautServer(page), 'Der Server hält die Sitzung noch für angemeldet.').toBe(false);

    // Und eine geschützte Seite verweigert sich: Die Middleware schickt zur
    // Anmeldung — nicht zur Erneuerung, denn es gibt nichts mehr zu erneuern.
    await page.goto('/admin/kunden');
    await expect(page).toHaveURL(/\/auth\/anmelden\?weiter=%2Fadmin%2Fkunden/);
    expect(erneuerungen(netz).every((e) => e.status === 200), 'Eine Erneuerung im Fenster wurde abgewiesen.').toBe(true);

    konsole.keineFehler();
  });

  test('Eine Eingabe vor der Warnung schiebt den Ablauf hinaus', async ({ context, page }) => {
    const vorEingabe = LEERLAUF_MS - WARNUNG_VORHER_MS - MINUTE;
    // Nur dann beweist der Fall etwas: Zweimal so lange ohne die Eingabe muss
    // über das Fenster hinausreichen, sonst bliebe die Sitzung ohnehin.
    expect(2 * vorEingabe, 'Das Leerlauffenster ist für diesen Fall zu kurz eingestellt.').toBeGreaterThan(LEERLAUF_MS);

    await context.clock.install();
    const konsole = konsoleUeberwachen(page);
    const netz = netzUeberwachen(context);
    await imBrowserAnmelden(page, 'admin', /\/admin/);
    await waechterLaeuft(page);
    const verkehr = anfragenVerfolgen(page);
    const hier = pfadVon(page);

    await context.clock.runFor(vorEingabe);
    await verkehr.ruhig();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // Eine Eingabe — und der Wächter hat sie vermerkt (sonst bewiese der Rest
    // des Falls nur, dass die Uhr nicht lief).
    const davor = await letzteAktivitaet(page);
    await eingabe(page, 1);
    await expect
      .poll(() => letzteAktivitaet(page), { message: 'Die Eingabe wurde nicht als Aktivität vermerkt.' })
      .toBeGreaterThan(davor);

    // Noch einmal so lange: seit der Anmeldung längst über dem Fenster, seit
    // der Eingabe nicht. Ohne die Eingabe stünde hier die Anmeldemaske.
    await context.clock.runFor(vorEingabe);
    await verkehr.ruhig();
    expect(pfadVon(page), 'Die Eingabe hat den Ablauf nicht verschoben.').toBe(hier);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(abmeldungen(netz)).toEqual([]);
    expect(await angemeldetLautServer(page), 'Die Sitzung trägt auf dem Server nicht mehr.').toBe(true);

    // Wer arbeitet, wird vorbeugend erneuert — und keine dieser Erneuerungen
    // wurde abgewiesen.
    const erneuert = erneuerungen(netz);
    expect(erneuert.length, 'Der Wächter hat in über zwanzig Minuten nie erneuert.').toBeGreaterThan(0);
    expect(erneuert.map((e) => e.status)).toEqual(erneuert.map(() => 200));

    // Verschoben, nicht aufgehoben: Gemessen ab der Eingabe kommt die Warnung
    // wieder zur gewohnten Zeit.
    await context.clock.runFor(MINUTE + SPIELRAUM_MS);
    await expect(page.getByRole('dialog', { name: WARNUNG })).toBeVisible();

    konsole.keineFehler();
  });

  test('Angemeldet bleiben: nach zwanzig Minuten keine Warnung, nach knapp sieben Tagen schon', async ({ context, page }) => {
    // Voraussetzungen der Zahlen unten: Das lange Fenster muss weit über
    // zwanzig Minuten liegen, und `fastForward` rechnet in 32-Bit-Ganzzahlen
    // (gut 24 Tage) — ein grösser eingestelltes Fenster liesse den Sprung
    // still falsch rechnen.
    expect(DAUERHAFT_MS, 'Das Fenster für „Angemeldet bleiben" ist kürzer als dieser Fall.').toBeGreaterThan(30 * MINUTE);
    expect(DAUERHAFT_MS, 'Das Fenster für „Angemeldet bleiben" ist zu lang zum Vorspulen.').toBeLessThan(2 ** 31);

    await context.clock.install();
    const konsole = konsoleUeberwachen(page);
    await imBrowserAnmelden(page, 'admin', /\/admin/, { angemeldetBleiben: true });
    await waechterLaeuft(page);
    const verkehr = anfragenVerfolgen(page);
    const hier = pfadVon(page);

    // Die Wahl ist beim Server angekommen: Der Erneuerungscookie hat eine
    // Laufzeit (ohne die Wahl ist er ein Sitzungscookie, `expires` −1).
    const keks = (await context.cookies()).find((k) => k.name === 'clenaris_rt');
    expect(keks?.expires ?? -1, '„Angemeldet bleiben" kam nicht beim Server an.').toBeGreaterThan(Date.now() / 1000 + 24 * 3600);

    // Zwanzig Minuten ohne Eingabe: Ohne die Wahl wäre die Sitzung seit fünf
    // Minuten beendet. Hier: keine Warnung, gleiche Seite.
    await context.clock.runFor(20 * MINUTE);
    await verkehr.ruhig();
    await expect(page.getByRole('dialog'), 'Das kurze Fenster galt trotz „Angemeldet bleiben".').toHaveCount(0);
    expect(pfadVon(page)).toBe(hier);

    /*
      Bis mitten ins Warnfenster des langen Fensters springen. `fastForward`
      lässt den Prüftakt genau einmal laufen, am Ende des Sprungs; das Ziel
      liegt deshalb eine halbe Warnzeit vor Ablauf, gerechnet ab dem
      gemeinsamen Zeitstempel. Ein Sprung über das ganze Fenster zeigte keine
      Warnung, sondern sofort die Anmeldemaske — das wäre ein anderer Fall.
    */
    const untaetig = (await page.evaluate(() => Date.now())) - (await letzteAktivitaet(page));
    await context.clock.fastForward(DAUERHAFT_MS - DAUERHAFT_WARNUNG_VORHER_MS / 2 - untaetig);
    await expect(page.getByRole('dialog', { name: WARNUNG })).toBeVisible();
    expect(pfadVon(page), 'Der Wächter meldete ab, statt zu warnen.').toBe(hier);

    // „Weiterarbeiten" erneuert — der Server kennt nur echte Sekunden und nimmt an.
    await page.getByRole('button', { name: 'Weiterarbeiten' }).click();
    await context.clock.runFor(TAKT_MS + 1_000);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await angemeldetLautServer(page)).toBe(true);

    konsole.keineFehler();
  });

  /**
   * Der Server hat das letzte Wort.
   *
   * Der Browser hält die Person hier für aktiv — jede Minute eine Eingabe,
   * keine Warnung. Auf dem Server aber ist der Erneuerungstoken über das
   * Fenster hinaus alt (zurückdatiert, wie ein Gerät, dessen Uhr nachgeht,
   * oder ein Tab, der lange eingefroren war). Beim vorbeugenden Erneuern nach
   * zehn Minuten weist der Server ab; der Browser muss dem folgen — zur
   * Anmeldung „abgelaufen" —, statt eine Seite stehen zu lassen, die angemeldet
   * aussieht und beim nächsten Klick zerfällt. Und er darf dabei nicht selbst
   * abmelden oder den toten Token ein zweites Mal vorlegen: Beides sähe auf
   * dem Server wie etwas anderes aus (Abmeldung, Wiederverwendungsalarm).
   */
  test('Vom Server wegen Leerlaufs beendete Sitzung: der Browser geht zur Anmeldung', async ({ context, page }) => {
    await context.clock.install();
    const konsole = konsoleUeberwachen(page);
    const netz = netzUeberwachen(context);
    await imBrowserAnmelden(page, 'admin', /\/admin/);
    await waechterLaeuft(page);
    const hier = pfadVon(page);
    const { zeile } = await erneuerungstokenDesBrowsers(context);
    expect(zeile.revokedAt, 'Der Token der frischen Anmeldung ist schon widerrufen.').toBeNull();

    try {
      await datenbank().refreshToken.update({
        where: { id: zeile.id },
        data: { createdAt: new Date(Date.now() - (LEERLAUF_S + 60) * 1000) },
      });

      // Arbeiten, bis der Wächter vorbeugend erneuert (nach zehn Minuten).
      for (let minute = 0; minute < 12 && !/\/auth\/anmelden/.test(page.url()); minute++) {
        await eingabe(page, minute);
        await context.clock.runFor(MINUTE);
      }

      await expect(page).toHaveURL(/\/auth\/anmelden\?.*grund=abgelaufen/);
      expect(new URL(page.url()).searchParams.get('weiter'), 'Das Rücksprungziel ging verloren.').toBe(hier);
      await expect(page.getByText(/Ihre Sitzung ist abgelaufen/)).toBeVisible();

      // Abgewiesen hat der Server, und nur er: jede Erneuerung 401, keine
      // eigene Abmeldung des Browsers.
      const erneuert = erneuerungen(netz);
      expect(erneuert.length, 'Der Wächter hat nie erneuert.').toBeGreaterThan(0);
      expect(erneuert.map((e) => e.status), 'Der Server hat eine eingeschlafene Sitzung erneuert.').toEqual(erneuert.map(() => 401));
      expect(abmeldungen(netz), 'Der Browser hat selbst abgemeldet — er hielt die Person für untätig.').toEqual([]);

      // Auf dem Server: als Leerlauf widerrufen (nicht rotiert), die Familie
      // tot, und kein Alarm — der Browser hat den Token kein zweites Mal
      // vorgelegt, weil die Ablehnung seine Cookies gelöscht hat.
      const nachher = await datenbank().refreshToken.findUniqueOrThrow({ where: { id: zeile.id } });
      expect(nachher.revokedAt, 'Der eingeschlafene Token ist nicht widerrufen.').not.toBeNull();
      expect(nachher.rotatedAt, 'Der Leerlauf wurde als Rotation verbucht.').toBeNull();
      expect(await lebendeTokens(zeile.family)).toBe(0);
      expect(await wiederverwendungsalarme(zeile.family), 'Der Browser hat einen Wiederverwendungsalarm ausgelöst.').toBe(0);
      expect(await sitzungscookies(context), 'Der Browser hält noch Sitzungscookies.').toEqual([]);

      // Der 401 der Erneuerung ist hier das erwartete Ergebnis; Chromium
      // schreibt ihn als Ressourcenfehler in die Konsole. Abgeholt wird nur er.
      konsole.erwartet(ressourcenfehler(401));
      konsole.keineFehler();
    } finally {
      await datenbank().securityEvent.deleteMany({
        where: { kind: 'REFRESH_REUSE_DETECTED', context: { path: ['family'], equals: zeile.family } },
      });
    }
  });

  /**
   * Die automatische Abmeldung in einem Tab nimmt den anderen mit.
   *
   * ---------------------------------------------------------------------------
   *  Warum dieser Fall die Uhr anhält
   * ---------------------------------------------------------------------------
   *
   * Beide Tabs teilen den Zeitstempel der letzten Aktivität; ohne Weiteres
   * erreichen beide das Ende des Fensters im selben Augenblick, und jeder
   * meldet sich mit seinem eigenen Prüftakt selbst ab. Dann wäre nichts
   * darüber bewiesen, ob die Nachricht des einen den anderen erreicht — und
   * genau darauf kommt es an, wenn der andere Tab im Hintergrund liegt und
   * sein Takt gedrosselt ist (Browser drosseln Zeitschaltungen verdeckter
   * Tabs auf einmal je Minute und seltener).
   *
   * Deshalb: Uhr anhalten (`pauseAt` mit einem Sprung über mehr als einen
   * Takt richtet beide Prüftakte auf denselben Zeitpunkt T aus), die letzte
   * Eingabe genau einen halben Takt danach setzen, und bis eine Viertelsekunde
   * hinter das Ende des Fensters spulen. Dort liegt zwischen dem letzten Takt
   * (noch im Fenster) und dem nächsten keiner — keiner der beiden Tabs hat
   * sein Ende gesehen. Dann kehrt die Person in Tab A zurück
   * (`visibilitychange`, der Weg, auf dem der Wächter sofort prüft): Tab A
   * meldet ab „wegen Inaktivität". Tab B kann nur noch der Nachricht folgen —
   * seine Uhr steht, sein nächster Takt kommt nie. Landet er auf der Anmeldung
   * „abgemeldet", hat ihn die Nachricht geholt; ohne sie bliebe er stehen.
   *
   * Das Ereignis `visibilitychange` wird in Tab A ausgelöst, nachdem der Tab
   * nach vorn geholt und als sichtbar bestätigt ist. Kopflos melden die
   * Engines das Zurückkehren nicht verlässlich selbst; ausgelöst wird
   * deshalb dasselbe Ereignis, das ein Browser beim Zurückkehren schickt — der
   * Weg danach (Prüfung, Abmeldung, Nachricht, zweiter Tab) ist ganz der des
   * Produkts.
   *
   * Seiten werden bei angehaltener Uhr keine mehr geladen, ausser den beiden
   * Anmeldemasken am Ende, an denen nur die Adresse geprüft wird.
   */
  test('Automatische Abmeldung in einem Tab nimmt den anderen mit', async ({ context, page }) => {
    await context.clock.install();
    const netz = netzUeberwachen(context);
    const konsoleA = konsoleUeberwachen(page);
    await imBrowserAnmelden(page, 'admin', /\/admin/);
    await waechterLaeuft(page);
    const hier = pfadVon(page);
    const { zeile } = await erneuerungstokenDesBrowsers(context);

    // Ein Merkzeichen im gemeinsamen Speicher, das nur der Wächter von Tab B
    // überschreibt: So steht fest, dass er läuft, bevor die Uhr anhält.
    await page.evaluate((schluessel) => window.localStorage.setItem(schluessel, '1'), AKTIVITAET);
    const tabB = await context.newPage();
    const konsoleB = konsoleUeberwachen(tabB);
    await tabB.goto(hier);
    expect(pfadVon(tabB)).toBe(hier);
    await waechterLaeuft(tabB, 1);
    const verkehrA = anfragenVerfolgen(page);
    const verkehrB = anfragenVerfolgen(tabB);

    // Anhalten und beide Prüftakte auf T ausrichten (Sprung > ein Takt).
    const t = (await page.evaluate(() => Date.now())) + 2 * TAKT_MS;
    await context.clock.pauseAt(t);

    // Die letzte Eingabe — in Tab A, genau einen halben Takt nach T.
    await context.clock.runFor(TAKT_MS / 2);
    await eingabe(page, 1);
    const zuletzt = t + TAKT_MS / 2;
    await expect
      .poll(() => letzteAktivitaet(page), { message: 'Die letzte Eingabe liegt nicht dort, wo der Fall sie braucht.' })
      .toBe(zuletzt);

    /*
      Bis eine Viertelsekunde hinter das Ende des Fensters. Die Takte liegen
      auf T + k·5 s, das Ende auf T + 2,5 s + Fenster; weil das Fenster ganze
      Sekunden misst, liegt der nächste Takt mindestens eine halbe Sekunde
      dahinter. Beide Tabs zeigen die Warnung, keiner hat abgemeldet.
    */
    await context.clock.runFor(LEERLAUF_MS + 250);
    await verkehrA.ruhig();
    await verkehrB.ruhig();
    await expect(page.getByRole('dialog', { name: WARNUNG })).toBeVisible();
    await expect(tabB.getByRole('dialog', { name: WARNUNG })).toBeVisible();
    expect(pfadVon(page), 'Tab A meldete vor der Zeit ab — die Takte liegen nicht, wo der Fall sie annimmt.').toBe(hier);
    expect(pfadVon(tabB), 'Tab B meldete vor der Zeit ab — die Takte liegen nicht, wo der Fall sie annimmt.').toBe(hier);
    expect(abmeldungen(netz)).toEqual([]);

    // Die Person kehrt in Tab A zurück. Meldet die Engine das Zurückholen
    // selbst (echtes `visibilitychange`), ist Tab A womöglich schon auf dem Weg
    // zur Anmeldung, wenn das Ereignis unten ausgelöst werden soll — dann
    // zerfällt der Ausführungskontext, und das ist dasselbe Ergebnis auf
    // demselben Weg. Jeder andere Fehler bleibt einer.
    await page.bringToFront();
    const sichtbar = await page
      .evaluate(() => {
        if (document.visibilityState !== 'visible') return false;
        document.dispatchEvent(new Event('visibilitychange'));
        return true;
      })
      .catch((fehler: unknown) => {
        if (/Execution context was destroyed|navigation/i.test(String(fehler))) return true;
        throw fehler;
      });
    expect(sichtbar, 'Tab A ist nach vorn geholt nicht sichtbar — der Wächter prüft nur sichtbare Tabs.').toBe(true);

    await expect(page).toHaveURL(/\/auth\/anmelden\?.*grund=inaktiv/);
    await expect(tabB, 'Tab B blieb nach der Abmeldung in Tab A angemeldet stehen.').toHaveURL(/\/auth\/anmelden\?.*grund=abgemeldet/);
    expect(new URL(tabB.url()).searchParams.get('weiter'), 'Tab B verlor sein Rücksprungziel.').toBe(hier);

    // Abgemeldet hat genau ein Tab; der andere ist gefolgt, ohne selbst zu
    // rufen. Auf dem Server ist die Sitzung zu Ende.
    expect(abmeldungen(netz), 'Beide Tabs haben abgemeldet — Tab B folgte nicht der Nachricht.').toHaveLength(1);
    expect(await lebendeTokens(zeile.family)).toBe(0);
    expect(await sitzungscookies(context)).toEqual([]);

    konsoleA.keineFehler();
    konsoleB.keineFehler();
  });
});
