import { test as basis } from '@playwright/test';

import { resetRateLimits } from '../../helpers/rate-limit';
import { diagnoseAnhaengen, lebenslaufMitschreiben } from './diagnose';
import { MUTATIONS_BEOBACHTER } from './mutations-beobachter';

/**
 * Der gemeinsame Testrahmen der Browser-Reihe.
 *
 * **Was er tut und warum ausgerechnet das.** Vor jedem Fall werden die
 * Rate-Limit-Zähler des Testservers geleert — dieselbe Massnahme, die
 * `loginAll()` in der HTTP-Reihe je Datei ergreift, hier nur feiner.
 *
 * Der Grund ist eine harte Grenze: Die Anmeldung erlaubt acht Versuche je
 * fünf Minuten und Adresse, und weil vor dem Testserver kein Proxy steht
 * (`TRUSTED_PROXY_MODE=NONE`), teilen sich **alle** Aufrufer den Schlüssel
 * „unbekannt". Diese Reihe meldet sich aber bewusst in fast jedem Fall neu an,
 * weil die Gerätesperre an der Rotationsfamilie hängt und eine
 * wiederverwendete Sitzung genau diese Aussage zerstörte. Ohne das Leeren
 * liefe der neunte Fall in einen 429 und man suchte den Fehler im Produkt.
 *
 * Die Limits selbst bleiben unverändert; ihre Semantik prüft weiterhin
 * `tests/api/rate-limit.test.ts` gegen die echten Werte.
 *
 * Das ist zugleich die Zusicherung aus § 4: Jeder Fall beginnt mit vollem
 * Kontingent und setzt keinen anderen voraus.
 */
export const test = basis.extend({
  /**
   * `/favicon.ico` selbst beantworten.
   *
   * Seit die Reihe den vollen Chromium fährt (statt der Headless-Shell, die
   * den PDF-Fehler nicht sehen konnte), fordert der Browser je Ursprung ein
   * Favicon an. Die Anwendung hat keines hinterlegt, Next antwortet 404, und
   * Chromium schreibt eine rote Konsolenzeile — in **jedem** Fall.
   *
   * Sie über ein Muster zu erlauben ginge nicht, ohne jeden anderen 404
   * mitzuerlauben: Die Meldung nennt die Adresse nicht. Also wird die Ursache
   * behandelt statt die Meldung gefiltert.
   *
   * Seit 2026-09-28 hat die Anwendung ein Symbol (`src/app/icon.svg`, als
   * `<link rel="icon">` ausgeliefert) — der offene Punkt ist damit erledigt.
   * Die Antwort hier bleibt: Nicht jede Engine verzichtet bei gesetztem
   * Symbol auf die Probe nach `/favicon.ico`, und eine `.ico`-Datei gibt es
   * bewusst nicht.
   */
  context: async ({ context }, use, testInfo) => {
    /**
     * Lebenslauf von Browser, Kontext und Seiten (RC-21) — als Erstes, damit
     * auch ein Ereignis während des Aufbaus dieses Rahmens mitgeschrieben
     * wird. Immer an, billig (eine Zeile je Ereignis) und ohne Einfluss auf
     * das Ergebnis eines Falls; Begründung bei `lebenslaufMitschreiben`.
     */
    const lebenslauf = lebenslaufMitschreiben(context, testInfo);

    await context.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }));

    /**
     * Die Hydrationswache hängt an **jedem** Fall.
     *
     * Vorher fiel ein Hydrationsfehler nur dort auf, wo ein Fall ausdrücklich
     * `konsole.keineFehler()` aufrief — also in etwa der Hälfte. Genau das war
     * der Grund, warum der Befund über Waves hinweg „mal hier, mal dort"
     * aussah: Er trat vermutlich häufiger auf, als die Reihe ihn meldete.
     *
     * Ab hier ist ein React-Hydrationsfehler in jedem Fall ein Fehlschlag, und
     * die Beweise dazu liegen als Artefakt vor, statt als eine Zeile im
     * Terminal zu verschwinden.
     */
    const diagnose = diagnoseAnhaengen(context, testInfo);
    /**
     * Die Reihenfolge der DOM-Veränderungen ab dem ersten Skript — **nur auf
     * Anforderung** (`E2E_MUTATIONEN=1`).
     *
     * Gemessen am 2026-09-23: mit dem Beobachter an jedem Fall 5 von 5 Läufen
     * rot, ohne ihn 3 von 5 (dieselbe Quote wie im Audit). Eine Tendenz, kein
     * Beweis — aber der Beobachter arbeitet bei jeder Einfügung des Parsers
     * und verschiebt damit das Zeitfenster, in dem der Fehler entsteht. Für
     * die Untersuchung ist das erwünscht (mehr Treffer), für die
     * Freigabeprüfung darf es das Ergebnis nicht färben — die Reihe soll das
     * Produkt messen, nicht das Messgerät.
     */
    if (process.env.E2E_MUTATIONEN === '1') await context.addInitScript(MUTATIONS_BEOBACHTER);

    // `use` ist hier Playwrights Übergabefunktion für eine Testvorrichtung,
    // kein React-Hook. Die Regel erkennt nur den Namen und liegt deshalb falsch.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    await use(context);

    /**
     * Offene Körperlesungen der Wache abwarten, höchstens zwei Sekunden
     * (RC-21). Sie gehören nicht zum Fall, sondern zu diesem Rahmen, und
     * sollen nicht mehr unterwegs sein, wenn Playwright gleich danach den
     * Kontext schliesst. Kein Wiederholen, kein Filtern: Was die Frist
     * überschreitet, bleibt offen und steht als `koerperAbgewartet: false` im
     * Lebenslauf. Zwei Sekunden, weil die Lesung eines bereits geladenen
     * Dokuments Millisekunden braucht — wer länger braucht, ist der Befund.
     */
    const koerper = await diagnose.ausstehendeAbwarten(2_000);
    lebenslauf.fallEnde({ offeneKoerper: koerper.offen, koerperAbgewartet: koerper.abgeschlossen });
    try {
      await diagnose.auswerten(testInfo);
    } finally {
      lebenslauf.abgebaut();
    }
  },
});

test.beforeEach(async () => {
  resetRateLimits();
});

export { expect } from '@playwright/test';
