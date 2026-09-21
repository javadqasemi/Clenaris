import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Der Anfragekontext — damit eine Protokollzeile mehr ist als eine Insel.
 *
 * ---------------------------------------------------------------------------
 *  Das Problem, das er löst
 * ---------------------------------------------------------------------------
 *
 * Bis Wave 5 stand in jeder Protokollzeile ein Bereich, eine Meldung und ein
 * paar Felder. Was fehlte, war die Klammer: *Welche Zeilen gehören zu
 * derselben Anfrage?* Unter Last liegen die Zeilen zweier gleichzeitiger
 * Anfragen verschränkt im Protokoll, und keine von ihnen sagt, zu welcher sie
 * gehört.
 *
 * Damit war die häufigste Frage im Betrieb nicht beantwortbar. Jemand meldet
 * „bei mir kam ein Fehler, so gegen halb drei" — und man hat den Fehler im
 * Protokoll, aber nicht, was davor geschah.
 *
 * Jetzt trägt jede Antwort `X-Request-Id`, jede Protokollzeile derselben
 * Anfrage dieselbe Kennung, und die Fehlerantwort nennt sie. Die Meldung
 * lautet dann „Fehler, Kennung 7f3a…" und die Suche im Protokoll ist ein
 * Filter.
 *
 * ---------------------------------------------------------------------------
 *  Warum AsyncLocalStorage und keine Weitergabe von Hand
 * ---------------------------------------------------------------------------
 *
 * Die Alternative wäre, die Kennung durch jede Funktion zu reichen — von der
 * Route über den Dienst bis in die Hilfsfunktion, die im Fehlerfall etwas
 * protokolliert. Das sind hunderte Signaturen, und die eine, die es vergisst,
 * ist genau die, in der der Fehler auftritt.
 *
 * `AsyncLocalStorage` hält den Wert über `await`-Grenzen hinweg, ohne dass
 * jemand ihn weiterreichen muss. Der Preis ist ein Modul, das nur unter Node
 * läuft — nicht in der Middleware, die auf Edge läuft. Das ist hinnehmbar:
 * Die Middleware ist ein Vorfilter (siehe `CLAUDE.md`), und die Kennung
 * entsteht im Handler, durch den jede Anfrage ohnehin läuft.
 *
 * ---------------------------------------------------------------------------
 *  Woher die Kennung kommt
 * ---------------------------------------------------------------------------
 *
 * Aus dem CSPRNG, nicht aus einem Zähler und nicht aus der Zeit. Eine
 * fortlaufende Nummer verriete, wie viele Anfragen die Anwendung bekommt —
 * eine Angabe, die niemand in einer Antwortkopfzeile braucht und die bei einem
 * Konkurrenten in einem Bericht landet.
 *
 * **Eine mitgeschickte Kennung wird nicht übernommen.** Ein vorgelagerter
 * Proxy darf `X-Request-Id` setzen, und viele tun es; hier wird sie trotzdem
 * neu erzeugt. Der Grund ist derselbe wie bei `X-Forwarded-For`: Was von
 * aussen kommt, ist eine Behauptung. Eine übernommene Kennung liesse jemanden
 * beliebig viele Protokollzeilen unter einer Kennung seiner Wahl ablegen —
 * etwa unter der einer echten Anfrage, die er stören will.
 */

export interface AnfrageKontext {
  /** Die Kennung, die auch in der Antwort steht. */
  requestId: string;
  /**
   * Die **Vorlage** des Pfads, nicht der Pfad selbst: `/api/jobs/:id`, nicht
   * `/api/jobs/clx…`. Der Unterschied entscheidet über die Brauchbarkeit der
   * Kennzahlen — siehe `metrics.ts`.
   */
  route: string;
  method: string;
  startedAt: number;
}

const speicher = new AsyncLocalStorage<AnfrageKontext>();

export function neueRequestId(): string {
  return randomUUID();
}

/** Den Kontext für die Dauer einer Anfrage setzen. */
export function mitAnfrageKontext<T>(kontext: AnfrageKontext, fn: () => Promise<T>): Promise<T> {
  return speicher.run(kontext, fn);
}

/**
 * Der Kontext der laufenden Anfrage — oder `undefined`.
 *
 * `undefined` ist der Normalfall ausserhalb einer Anfrage: im nächtlichen
 * Lauf, in einem Skript, beim Start. Deshalb wirft diese Funktion nicht; ein
 * Logger, der ausserhalb einer Anfrage nicht mehr schreibt, wäre schlechter
 * als einer ohne Kennung.
 */
export function anfrageKontext(): AnfrageKontext | undefined {
  return speicher.getStore();
}

export function aktuelleRequestId(): string | undefined {
  return speicher.getStore()?.requestId;
}

/**
 * Aus einem Pfad und den Routenparametern eine Vorlage machen.
 *
 * `/api/jobs/clx123/team` mit `{ id: 'clx123' }` wird zu `/api/jobs/:id/team`.
 *
 * **Warum das mehr ist als Kosmetik.** Kennzahlen je *Pfad* wären Kennzahlen
 * je Datensatz: Bei zehntausend Einsätzen entstünden zehntausend Reihen, die
 * Registrierung wüchse unbegrenzt, und keine einzige Reihe hätte genug
 * Beobachtungen für eine Aussage. Das ist der klassische Fehler bei
 * Kennzahlen, und er fällt erst im Betrieb auf — als Speicherverbrauch, der
 * mit den Daten wächst.
 *
 * Ersetzt wird über den **Wert**, nicht über die Position: Ein Parameter kann
 * an jeder Stelle stehen, und die Reihenfolge in `params` ist nicht die im
 * Pfad. Nur Werte ab drei Zeichen — ein einzeichiger Wert käme sonst in jedem
 * zweiten Pfadsegment vor.
 */
export function routenVorlage(pfad: string, params: Record<string, unknown>): string {
  let vorlage = pfad;

  for (const [name, wert] of Object.entries(params)) {
    if (typeof wert !== 'string' || wert.length < 3) continue;
    vorlage = vorlage.split(`/${wert}`).join(`/:${name}`);
  }

  return vorlage;
}
