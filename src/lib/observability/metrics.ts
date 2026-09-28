/**
 * Kennzahlen des laufenden Prozesses — im Prozess, ohne Anbieter.
 *
 * ---------------------------------------------------------------------------
 *  Was das ist und was es nicht ist
 * ---------------------------------------------------------------------------
 *
 * Eine Registrierung im Arbeitsspeicher: je Route und Methode die Zahl der
 * Anfragen, die Verteilung auf Statusklassen und die Dauer. Mehr nicht.
 *
 * **Kein Anbieter, keine Ausleitung, keine Zeitreihe.** Das ist eine
 * Entscheidung und kein Zwischenstand. Ein Kennzahlendienst — Prometheus,
 * Datadog, Grafana Cloud — ist eine Betriebsentscheidung mit Kosten,
 * Datenschutzfragen und einem zweiten System, das laufen muss. Was der Code
 * beitragen kann, ist die **Erhebung** an der richtigen Stelle und eine
 * Ausgabe in einem Format, das ein solcher Dienst lesen könnte. Beides steht
 * hier; die Entscheidung bleibt offen.
 *
 * ---------------------------------------------------------------------------
 *  Die Grenzen, die das ehrlich machen
 * ---------------------------------------------------------------------------
 *
 * **Die Zahlen gelten je Prozess.** Läuft die Anwendung in zwei Instanzen,
 * sieht jede nur ihre eigenen Anfragen. Das ist keine Nachlässigkeit, sondern
 * die Folge davon, keinen Sammler zu betreiben — und es ist genau der Grund,
 * warum die Ausgabe `prozessStartzeit` und `prozessId` mitliefert: Wer zwei
 * Antworten vergleicht, soll sehen, ob sie aus demselben Prozess stammen.
 *
 * **Die Zahlen überleben keinen Neustart.** Jede Auslieferung setzt sie auf
 * null. Für die Frage „was ist gerade langsam" reicht das; für „war das
 * letzten Monat auch so" nicht. Diese zweite Frage beantwortet nur ein
 * Sammler, und den gibt es hier bewusst nicht.
 *
 * ---------------------------------------------------------------------------
 *  Warum Klassen statt einzelner Dauern
 * ---------------------------------------------------------------------------
 *
 * Gespeichert werden Summe, Anzahl, Maximum und die Zahl der Beobachtungen je
 * Zeitklasse — nicht die einzelnen Messwerte. Eine Liste aller Dauern wäre
 * genauer und wüchse unbegrenzt; nach einem Tag unter Last wäre sie der
 * grösste Posten im Speicher.
 *
 * Aus den Klassen lässt sich ein Quantil abschätzen, und eine Abschätzung ist
 * genau das, was hier gebraucht wird: Die Frage lautet „liegt der Grossteil
 * unter einer halben Sekunde", nicht „wie lange dauerte die 847. Anfrage".
 */

/**
 * Obergrenzen in Millisekunden. Die letzte Klasse ist offen.
 *
 * Die Werte sind an der Anwendung ausgerichtet und nicht an einer Norm: 5 ms
 * ist ein Zwischenspeichertreffer, 50 ms eine einfache Abfrage, 250 ms eine
 * Listenseite mit Verknüpfungen, 1 s die Schwelle, ab der ein Mensch wartet,
 * 5 s ein PDF-Aufbau. Darüber stimmt etwas nicht.
 */
export const DAUER_KLASSEN = [5, 25, 50, 100, 250, 500, 1000, 2500, 5000] as const;

export interface RouteZahlen {
  route: string;
  method: string;
  anfragen: number;
  /** Nach Statusklasse: 2xx, 3xx, 4xx, 5xx. */
  status: Record<'2xx' | '3xx' | '4xx' | '5xx', number>;
  dauerSummeMs: number;
  dauerMaxMs: number;
  /** Beobachtungen je Klasse, plus ein letzter Eintrag für „darüber". */
  klassen: number[];
}

/**
 * Die Obergrenze der Registrierung.
 *
 * Ohne sie wäre eine fehlerhafte Vorlagenbildung — ein Parameter, der nicht
 * ersetzt wird — ein unbegrenztes Wachstum. Die Anwendung hat 405 Endpunkte;
 * 500 Reihen lassen Luft und decken jede Methode je Route ab. Wird die Grenze
 * erreicht, wird nichts mehr aufgenommen und `ueberlauf` gezählt: Die Ausgabe
 * sagt dann, dass sie unvollständig ist, statt es zu verschweigen.
 */
const MAX_REIHEN = 500;

const reihen = new Map<string, RouteZahlen>();
let ueberlauf = 0;
let prozessStart = Date.now();

function leer(route: string, method: string): RouteZahlen {
  return {
    route,
    method,
    anfragen: 0,
    status: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 },
    dauerSummeMs: 0,
    dauerMaxMs: 0,
    klassen: new Array(DAUER_KLASSEN.length + 1).fill(0),
  };
}

function klasseVon(dauerMs: number): number {
  for (let i = 0; i < DAUER_KLASSEN.length; i++) {
    if (dauerMs <= DAUER_KLASSEN[i]) return i;
  }
  return DAUER_KLASSEN.length;
}

function statusKlasse(status: number): keyof RouteZahlen['status'] {
  if (status >= 500) return '5xx';
  if (status >= 400) return '4xx';
  if (status >= 300) return '3xx';
  return '2xx';
}

/**
 * Eine abgeschlossene Anfrage aufnehmen.
 *
 * Wirft nie. Eine Kennzahlenerhebung, die eine Anfrage scheitern lassen kann,
 * ist selbst ein Ausfallgrund — dieselbe Überlegung wie beim Prüfprotokoll
 * (`lib/audit.ts`) und beim Sicherheitsstrom.
 */
export function beobachteAnfrage(params: {
  route: string;
  method: string;
  status: number;
  dauerMs: number;
}): void {
  try {
    const schluessel = `${params.method} ${params.route}`;
    let zeile = reihen.get(schluessel);

    if (!zeile) {
      if (reihen.size >= MAX_REIHEN) {
        ueberlauf += 1;
        return;
      }
      zeile = leer(params.route, params.method);
      reihen.set(schluessel, zeile);
    }

    zeile.anfragen += 1;
    zeile.status[statusKlasse(params.status)] += 1;
    zeile.dauerSummeMs += params.dauerMs;
    if (params.dauerMs > zeile.dauerMaxMs) zeile.dauerMaxMs = params.dauerMs;
    zeile.klassen[klasseVon(params.dauerMs)] += 1;
  } catch {
    // Kennzahlen dürfen nichts umwerfen.
  }
}

/**
 * Ein Quantil aus den Klassen abschätzen.
 *
 * Zurückgegeben wird die **Obergrenze der Klasse**, in der das Quantil liegt —
 * also ein Wert, der die Wahrheit nie unterschätzt. Das ist die richtige
 * Richtung für einen Wert, nach dem jemand entscheidet: „p95 unter 250 ms"
 * darf nicht in Wahrheit 400 ms heissen.
 *
 * Liegt das Quantil in der offenen Klasse, kommt `null` — es gibt dort keine
 * Obergrenze, und eine erfundene wäre schlimmer als die Auskunft „darüber".
 */
export function quantil(zeile: RouteZahlen, anteil: number): number | null {
  const ziel = zeile.anfragen * anteil;
  let summe = 0;

  for (let i = 0; i < zeile.klassen.length; i++) {
    summe += zeile.klassen[i];
    if (summe >= ziel) {
      return i < DAUER_KLASSEN.length ? DAUER_KLASSEN[i] : null;
    }
  }
  return null;
}

export interface KennzahlenAusgabe {
  prozessId: number;
  prozessStartzeit: string;
  laufzeitSekunden: number;
  /** Wie viele Reihen nicht aufgenommen wurden, weil die Grenze erreicht ist. */
  ueberlauf: number;
  reihen: (RouteZahlen & {
    dauerMittelMs: number;
    p50Ms: number | null;
    p95Ms: number | null;
  })[];
}

export function kennzahlen(): KennzahlenAusgabe {
  return {
    prozessId: process.pid,
    prozessStartzeit: new Date(prozessStart).toISOString(),
    laufzeitSekunden: Math.round((Date.now() - prozessStart) / 1000),
    ueberlauf,
    reihen: [...reihen.values()]
      // Nach Anfragen absteigend: Wer die Ausgabe öffnet, sucht meist die
      // meistgenutzte oder die langsamste Route, nicht die alphabetisch erste.
      .sort((a, b) => b.anfragen - a.anfragen)
      .map((z) => ({
        ...z,
        dauerMittelMs: z.anfragen === 0 ? 0 : Math.round((z.dauerSummeMs / z.anfragen) * 10) / 10,
        p50Ms: quantil(z, 0.5),
        p95Ms: quantil(z, 0.95),
      })),
  };
}

/** Nur für Prüfungen und einen bewussten Neubeginn. */
export function kennzahlenZuruecksetzen(): void {
  reihen.clear();
  ueberlauf = 0;
  prozessStart = Date.now();
}
