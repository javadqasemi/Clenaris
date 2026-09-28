import { expect, type BrowserContext, type Page, type Request, type Response } from '@playwright/test';

import { ACCOUNTS } from '../../helpers/accounts';

/**
 * Werkzeuge, die jeder Browserfall braucht: Konsole überwachen, Netzverkehr
 * protokollieren, anmelden, Tokenhygiene nachweisen.
 */

// ---------------------------------------------------------------------------
//  Konsole und Seitenfehler
// ---------------------------------------------------------------------------

export interface Konsolenwache {
  /** Alles, was als Fehler gilt: `console.error`, `pageerror`, unbehandelte Zusage. */
  fehler: string[];
  /**
   * Eine erwartete Meldung abholen: entfernt die passenden Einträge und gibt
   * ihre Zahl zurück.
   *
   * Damit wird aus Lärm eine Zusicherung. Ein abgelehntes Passwort erzeugt in
   * Chromium zwangsläufig eine rote Konsolenzeile — sie pauschal zu erlauben
   * hiesse, jeden 401 dieses Falls zu übersehen. Wer sie hier abholt, behauptet
   * dagegen: „genau diese Meldung erwarte ich, und zwar jetzt".
   */
  erwartet(muster: RegExp): number;
  /** Prüft und wirft mit vollständiger Liste. */
  keineFehler(): void;
}

/**
 * Konsolenfehler sind Testfehler (§ 27).
 *
 * **Warum kein pauschales Ignorieren.** Eine Anwendung, die im Betrieb rote
 * Meldungen erzeugt, hat einen Fehler — nur einen, der niemandem auffällt.
 * Deshalb ist die Vorgabe null Toleranz, und jede Ausnahme muss einzeln,
 * benannt und begründet übergeben werden.
 *
 * Die einzige Ausnahme, die diese Reihe tatsächlich braucht, betrifft die
 * Sperrfälle: Chromium schreibt jede Antwort ≥ 400 als
 * „Failed to load resource" in die Konsole. Ein 423 während einer Übergabe
 * *ist* dort das erwartete Ergebnis — der Fall prüft ihn zusätzlich am
 * Statuscode, nicht an der Konsolenzeile.
 */
export function konsoleUeberwachen(page: Page, erlaubt: RegExp[] = []): Konsolenwache {
  const fehler: string[] = [];

  /**
   * Chromiums Meldung „Failed to load resource: … 404" nennt die Adresse
   * nicht — man weiss also, dass etwas fehlt, aber nicht was. Deshalb werden
   * misslungene Antworten mitgeschrieben und der Fehlermeldung angehängt.
   */
  const misslungen: string[] = [];
  page.on('response', (antwort) => {
    if (antwort.status() >= 400) misslungen.push(`${antwort.status()} ${antwort.url()}`);
  });

  const erlaubtIst = (text: string) => [...erlaubt, ...IMMER_ERLAUBT].some((muster) => muster.test(text));

  page.on('console', (nachricht) => {
    if (nachricht.type() !== 'error') return;
    const text = nachricht.text();
    if (!erlaubtIst(text)) fehler.push(`console.error: ${text}`);
  });

  page.on('pageerror', (error) => {
    const text = error.message;
    if (!erlaubtIst(text)) fehler.push(`pageerror: ${text}`);
  });

  return {
    fehler,
    erwartet(muster) {
      let entfernt = 0;
      for (let i = fehler.length - 1; i >= 0; i--) {
        if (muster.test(fehler[i]!)) {
          fehler.splice(i, 1);
          entfernt += 1;
        }
      }
      return entfernt;
    },
    keineFehler() {
      const antworten = misslungen.length
        ? `\n\n  Misslungene Antworten dieser Seite:\n  - ${misslungen.join('\n  - ')}`
        : '';
      expect(fehler, `Unerwartete Browserfehler:\n  - ${fehler.join('\n  - ')}${antworten}`).toEqual([]);
    },
  };
}

/** Der 4xx/5xx-Lärm, den Chromium selbst schreibt — nur mit erwartetem Status. */
export const ressourcenfehler = (status: number) =>
  new RegExp(`Failed to load resource.*status of ${status}`);

/**
 * Hier steht bewusst **nichts**.
 *
 * Es wäre bequem gewesen, den 404 des fehlenden Favicons pauschal zu erlauben
 * — aber Chromiums Konsolenzeile nennt die Adresse gar nicht („Failed to load
 * resource: the server responded with a status of 404"). Ein Muster dagegen
 * hätte jeden anderen 404 gleich mit durchgelassen, und genau die will diese
 * Reihe sehen. Die Ursache wird deshalb im Testrahmen behandelt, nicht die
 * Meldung gefiltert: `tests/e2e/helpers/basis.ts` beantwortet `/favicon.ico`
 * selbst.
 */
const IMMER_ERLAUBT: RegExp[] = [];

// ---------------------------------------------------------------------------
//  Netzverkehr
// ---------------------------------------------------------------------------

export interface Netzeintrag {
  url: string;
  methode: string;
  status: number | null;
  typ: string;
}

export interface Netzwache {
  eintraege: Netzeintrag[];
  /** Alle Einträge, deren Adresse das Muster erfüllt. */
  treffer(muster: RegExp): Netzeintrag[];
  /** Adressen, die nicht zum eigenen Ursprung gehören. */
  fremdeUrspruenge(basis: string): string[];
}

/**
 * Am **Kontext** angehängt, nicht an der Seite: Der Worker von PDF.js ist ein
 * eigener Ausführungskontext, und ein zweiter Tab ist eine zweite Seite.
 * Beides soll im selben Protokoll landen.
 */
export function netzUeberwachen(context: BrowserContext): Netzwache {
  const eintraege: Netzeintrag[] = [];

  context.on('request', (anfrage: Request) => {
    eintraege.push({ url: anfrage.url(), methode: anfrage.method(), status: null, typ: anfrage.resourceType() });
  });

  context.on('response', (antwort: Response) => {
    const url = antwort.url();
    // Den offenen Eintrag derselben Adresse nachtragen, sonst einen neuen.
    const offen = [...eintraege].reverse().find((e) => e.url === url && e.status === null);
    if (offen) offen.status = antwort.status();
    else eintraege.push({ url, methode: antwort.request().method(), status: antwort.status(), typ: antwort.request().resourceType() });
  });

  return {
    eintraege,
    treffer: (muster) => eintraege.filter((e) => muster.test(e.url)),
    fremdeUrspruenge(basis) {
      const eigener = new URL(basis).origin;
      return [
        ...new Set(
          eintraege
            .map((e) => e.url)
            .filter((url) => /^https?:/.test(url))
            .filter((url) => new URL(url).origin !== eigener),
        ),
      ];
    },
  };
}

// ---------------------------------------------------------------------------
//  Anmeldung über die Maske
// ---------------------------------------------------------------------------

/**
 * Anmelden, wie ein Mensch es täte — über `/auth/anmelden`.
 *
 * Nicht über ein vorbereitetes `storageState`: Die Gerätesperre hängt an der
 * Rotationsfamilie der Sitzung, und ein wiederverwendeter Cookie-Vorrat wäre
 * über mehrere Fälle hinweg dieselbe Familie. Jeder Fall meldet sich frisch an
 * und bekommt damit genau das, was § 32 meint — ein eigenes Gerät.
 */
export async function imBrowserAnmelden(
  page: Page,
  konto: keyof typeof ACCOUNTS,
  erwartetesZiel: RegExp,
  /** Rücksprungziel wie nach einer abgelaufenen Sitzung (`?weiter=`), sonst die Startseite der Rolle. */
  weiter?: string,
): Promise<void> {
  const { email, password } = ACCOUNTS[konto];
  await page.goto(weiter ? `/auth/anmelden?weiter=${encodeURIComponent(weiter)}` : '/auth/anmelden');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[autocomplete="current-password"]').fill(password);
  await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
  await page.waitForURL(erwartetesZiel, { timeout: 30_000 });
}

// ---------------------------------------------------------------------------
//  Endpunkte aus der Seite heraus anfragen
// ---------------------------------------------------------------------------

/**
 * Einen Endpunkt mit den **echten** Cookies des Browsers anfragen und den
 * Statuscode zurückgeben.
 *
 * **Warum nicht `context.request`.** Die Anmeldecookies dieser Anwendung sind
 * `Secure`. Chromium behandelt `127.0.0.1` als vertrauenswürdigen Ursprung und
 * schickt sie auch über `http` — Playwrights `APIRequestContext` ist dagegen
 * ein eigener HTTP-Stapel in Node und filtert `Secure`-Cookies nach Schema.
 * Eine Anfrage von dort käme unangemeldet an und ergäbe 401 statt 423; der
 * Fall hätte dann bewiesen, dass eine Sperre greift, die gar nicht geprüft
 * wurde. Gemessen und deshalb hier festgehalten.
 *
 * `redirect: 'manual'` ist ebenfalls Absicht: Eine Umleitung *ist* hier oft
 * das Ergebnis, und würde `fetch` ihr folgen, sähe der Fall eine 200. Eine
 * undurchsichtige Umleitung meldet dieser Helfer als `302`.
 */
export async function statusAusSeite(
  page: Page,
  pfad: string,
  methode: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET',
): Promise<number> {
  return page.evaluate(
    async ([adresse, verb]) => {
      const antwort = await fetch(adresse!, {
        method: verb,
        credentials: 'same-origin',
        redirect: 'manual',
        headers: { Accept: 'application/json' },
      });
      return antwort.type === 'opaqueredirect' ? 302 : antwort.status;
    },
    [pfad, methode],
  );
}

// ---------------------------------------------------------------------------
//  Tokenhygiene (§ 29)
// ---------------------------------------------------------------------------

/**
 * Der rohe Zugang darf nach dem Tausch nirgends mehr auftauchen.
 *
 * Geprüft werden alle Orte, die ein Browser überhaupt anbietet: die sichtbare
 * Adresse, das ausgelieferte HTML, jede protokollierte Anfrageadresse (also
 * auch die der PDF-Bytes und aller Hilfsdateien) und der Verlauf. Der
 * `POST`-Körper des Tauschs ist die eine erlaubte Ausnahme — er trägt ihn
 * genau einmal, und das ist der Sinn der Übung.
 *
 * Der Tokenwert selbst wird nie ausgegeben; Meldungen nennen nur den Ort.
 */
export async function tokenNirgendsSichtbar(
  page: Page,
  netz: Netzwache,
  token: string,
): Promise<void> {
  expect(page.url(), 'Der rohe Zugang steht noch in der sichtbaren Adresse.').not.toContain(token);

  const html = await page.content();
  expect(html.includes(token), 'Der rohe Zugang steht im ausgelieferten HTML.').toBe(false);

  const inAdressen = netz.eintraege.filter((e) => e.url.includes(token)).map((e) => `${e.methode} …`);
  expect(inAdressen, 'Der rohe Zugang steht in einer Anfrageadresse.').toEqual([]);

  const imVerlauf = await page.evaluate(() => ({
    href: window.location.href,
    hash: window.location.hash,
    referrer: document.referrer,
  }));
  expect(imVerlauf.href.includes(token), 'Der rohe Zugang steht in location.href.').toBe(false);
  expect(imVerlauf.hash.includes(token), 'Der rohe Zugang steht im Fragment.').toBe(false);
  expect(imVerlauf.referrer.includes(token), 'Der rohe Zugang steht im Referrer.').toBe(false);
}

// ---------------------------------------------------------------------------
//  Unterschrift zeichnen
// ---------------------------------------------------------------------------

/**
 * Auf dem Unterschriftenfeld **tatsächlich zeichnen** — mit der Maus des
 * Browsers, nicht mit einem eingesetzten `imageDataUrl`.
 *
 * `SignaturePad` hört auf Pointer-Events (`pointerdown`/`pointermove`/
 * `pointerup`). Playwrights Maus erzeugt in Chromium echte Eingabeereignisse
 * über das CDP-Protokoll, aus denen der Browser selbst Pointer-Events ableitet
 * — nicht synthetische `dispatchEvent`-Aufrufe. Damit ist der Weg vom
 * Zeigegerät bis zum PNG derselbe wie bei einem Menschen.
 *
 * Ein einzelner Klick genügt nicht: `move()` setzt `hasStrokes`, und erst
 * `pointerup` ruft `toDataURL()`. Gezeichnet wird deshalb ein Zug mit mehreren
 * Zwischenschritten.
 */
export async function unterschriftZeichnen(page: Page): Promise<void> {
  const feld = page.getByRole('img', { name: /Unterschriftenfeld/ });
  await expect(feld).toBeVisible();
  const box = await feld.boundingBox();
  expect(box, 'Das Unterschriftenfeld hat keine Ausdehnung.').not.toBeNull();

  const { x, y, width, height } = box!;
  const links = x + width * 0.2;
  const rechts = x + width * 0.8;
  const mitte = y + height * 0.55;

  await page.mouse.move(links, mitte);
  await page.mouse.down();
  for (let schritt = 1; schritt <= 12; schritt++) {
    const anteil = schritt / 12;
    await page.mouse.move(
      links + (rechts - links) * anteil,
      mitte - Math.sin(anteil * Math.PI) * height * 0.3,
      { steps: 3 },
    );
  }
  await page.mouse.up();
}

/**
 * Dasselbe mit dem Finger — über die Touchscreen-Schnittstelle.
 *
 * **Was das beweist und was nicht.** Playwright erzeugt hier echte
 * `Input.dispatchTouchEvent`-Kommandos über CDP; Chromium leitet daraus
 * Touch- *und* Pointer-Events ab, wie bei einer Berührung des Bildschirms.
 * Was damit **nicht** bewiesen ist: das Verhalten eines physischen
 * Digitizers — Druck, Radius, Vorhersage, Zusammenfassen mehrerer Bewegungen.
 * Diese Reihe behauptet das auch nirgends.
 */
export async function unterschriftTippen(page: Page): Promise<void> {
  const feld = page.getByRole('img', { name: /Unterschriftenfeld/ });
  await expect(feld).toBeVisible();
  const box = await feld.boundingBox();
  expect(box, 'Das Unterschriftenfeld hat keine Ausdehnung.').not.toBeNull();

  const { x, y, width, height } = box!;
  const punkte: Array<[number, number]> = [];
  for (let schritt = 0; schritt <= 12; schritt++) {
    const anteil = schritt / 12;
    punkte.push([
      x + width * (0.2 + 0.6 * anteil),
      y + height * 0.55 - Math.sin(anteil * Math.PI) * height * 0.3,
    ]);
  }

  const cdp = await page.context().newCDPSession(page);
  const senden = (typ: 'touchStart' | 'touchMove' | 'touchEnd', punkt?: [number, number]) =>
    cdp.send('Input.dispatchTouchEvent', {
      type: typ,
      touchPoints: punkt ? [{ x: punkt[0], y: punkt[1] }] : [],
    });

  await senden('touchStart', punkte[0]);
  for (const punkt of punkte.slice(1)) await senden('touchMove', punkt);
  await senden('touchEnd');
  await cdp.detach();
}
