/**
 * Die Bedingungssprache der Automatisierungen.
 *
 * ---------------------------------------------------------------------------
 *  Warum sie so klein ist
 * ---------------------------------------------------------------------------
 *
 * Die naheliegende Lösung für „Bedingungen" ist eine Ausdruckssprache —
 * `kunde.typ == "BUSINESS" && betrag > 500`. Das wären ein Parser, ein
 * Auswerter und eine Absicherung gegen alles, was ein Ausdruck sonst noch
 * anrichten kann. Drei Dinge, die falsch sein können, für ein Merkmal, dessen
 * Benutzer in einem Formular aus Feldern auswählen.
 *
 * Deshalb: eine Tabelle aus Feldnamen und Vergleichen, mehr nicht. Alle
 * Bedingungen sind mit **und** verknüpft; ein „oder" gibt es nicht, weil es
 * sich durch zwei Regeln ausdrücken lässt und die Auswertung sonst eine
 * Baumstruktur bräuchte.
 *
 * ---------------------------------------------------------------------------
 *  Wann ausgewertet wird — und warum zweimal
 * ---------------------------------------------------------------------------
 *
 * Beim **Auslösen**, um zu entscheiden, ob überhaupt ein Lauf entsteht. Und
 * noch einmal beim **Ausführen**, gegen den dann aktuellen Zustand.
 *
 * Der zweite Durchgang ist der wichtige. Zwischen Auslöser und Ausführung
 * können Tage liegen (`delayMinutes`), und in dieser Zeit ändert sich die
 * Welt: Die Buchung wird abgesagt, die Offerte abgelehnt, die Rechnung
 * bezahlt. Ohne die zweite Auswertung ginge die Erinnerung an einen Termin
 * hinaus, den es nicht mehr gibt — und das ist der Fehler, den Kundschaft
 * bemerkt und der Betrieb nicht.
 *
 * Aus demselben Grund wird der Zustand beim Ausführen **neu geladen** und
 * nicht als Momentaufnahme gespeichert. Eine gespeicherte Momentaufnahme wäre
 * zusätzlich eine Sammlung von Personendaten in einer Json-Spalte, die niemand
 * aufräumt.
 */

/** Was ein Auslöser über den Vorgang weiss. Flach oder verschachtelt. */
export type Nutzlast = Record<string, unknown>;

/**
 * Die Vergleiche.
 *
 * Bewusst ohne `regex`: Ein vom Benutzer gestellter regulärer Ausdruck ist
 * eine Rechenzeitbombe (katastrophales Backtracking), und der Gewinn wäre
 * gering — wer nach Textteilen sucht, nimmt `contains`.
 */
export interface Vergleich {
  eq?: unknown;
  ne?: unknown;
  in?: unknown[];
  notIn?: unknown[];
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
  /** Teilzeichenkette, Gross- und Kleinschreibung egal. */
  contains?: string;
  /** `true` verlangt einen Wert, `false` verlangt, dass keiner da ist. */
  exists?: boolean;
}

export type Bedingungen = Record<string, unknown>;

const VERGLEICHS_SCHLUESSEL = new Set([
  'eq',
  'ne',
  'in',
  'notIn',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'exists',
]);

/**
 * Einen Wert über einen Punktpfad holen: `kunde.typ`.
 *
 * Gibt `undefined` zurück, wenn der Pfad ins Leere führt — nicht `null`. Der
 * Unterschied zählt: `null` ist ein Wert, den ein Feld tatsächlich haben kann,
 * `undefined` heisst „gibt es nicht". `exists` unterscheidet beides.
 */
export function wertAn(nutzlast: Nutzlast, pfad: string): unknown {
  let aktuell: unknown = nutzlast;

  for (const teil of pfad.split('.')) {
    if (aktuell === null || aktuell === undefined) return undefined;
    if (typeof aktuell !== 'object') return undefined;
    aktuell = (aktuell as Record<string, unknown>)[teil];
  }

  return aktuell;
}

/** Sieht dieser Wert wie ein Vergleichsobjekt aus — oder ist er selbst der Wert? */
function istVergleich(wert: unknown): wert is Vergleich {
  if (wert === null || typeof wert !== 'object' || Array.isArray(wert)) return false;
  const schluessel = Object.keys(wert);
  return schluessel.length > 0 && schluessel.every((k) => VERGLEICHS_SCHLUESSEL.has(k));
}

/**
 * Zwei Werte vergleichen.
 *
 * Über `String(...)` bei ungleichen Typen: Die Bedingungen kommen aus einem
 * Json-Feld, in dem `"5"` und `5` beide vorkommen können — je nachdem, ob ein
 * Formular oder ein Skript sie geschrieben hat. Ein strenger Vergleich liesse
 * eine Regel stillschweigend nie greifen, und das ist der Fehler, den niemand
 * findet: Sie steht in der Liste, ist aktiv und tut nichts.
 */
function gleich(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (typeof a === typeof b) return false;
  return String(a) === String(b);
}

function zahl(wert: unknown): number | null {
  if (typeof wert === 'number') return Number.isFinite(wert) ? wert : null;
  if (typeof wert === 'string' && wert.trim() !== '') {
    const n = Number(wert);
    return Number.isFinite(n) ? n : null;
  }
  if (wert instanceof Date) return wert.getTime();
  return null;
}

function pruefeVergleich(wert: unknown, vergleich: Vergleich): boolean {
  if (vergleich.exists !== undefined) {
    const vorhanden = wert !== undefined && wert !== null && wert !== '';
    if (vorhanden !== vergleich.exists) return false;
  }

  if ('eq' in vergleich && !gleich(wert, vergleich.eq)) return false;
  if ('ne' in vergleich && gleich(wert, vergleich.ne)) return false;

  if (vergleich.in && !vergleich.in.some((k) => gleich(wert, k))) return false;
  if (vergleich.notIn && vergleich.notIn.some((k) => gleich(wert, k))) return false;

  if (vergleich.contains !== undefined) {
    if (typeof wert !== 'string') return false;
    if (!wert.toLowerCase().includes(vergleich.contains.toLowerCase())) return false;
  }

  /**
   * Zahlenvergleiche gegen einen nicht-zahligen Wert ergeben **false**, nicht
   * einen Fehler. Eine Regel „Betrag über 500" auf einem Vorgang ohne Betrag
   * soll nicht greifen — und den Lauf auch nicht scheitern lassen.
   */
  const n = zahl(wert);
  if (vergleich.gt !== undefined && (n === null || !(n > vergleich.gt))) return false;
  if (vergleich.gte !== undefined && (n === null || !(n >= vergleich.gte))) return false;
  if (vergleich.lt !== undefined && (n === null || !(n < vergleich.lt))) return false;
  if (vergleich.lte !== undefined && (n === null || !(n <= vergleich.lte))) return false;

  return true;
}

/**
 * Halten alle Bedingungen?
 *
 * Leere Bedingungen heissen **ja**. Das ist der Normalfall — die meisten
 * Regeln laufen auf jeden Vorgang ihres Auslösers — und es ist die einzige
 * Auslegung, die nicht überrascht: Eine Regel ohne Einschränkung ist eine
 * ohne Einschränkung.
 */
export function bedingungenErfuellt(bedingungen: Bedingungen, nutzlast: Nutzlast): boolean {
  for (const [pfad, erwartet] of Object.entries(bedingungen)) {
    const wert = wertAn(nutzlast, pfad);

    if (istVergleich(erwartet)) {
      if (!pruefeVergleich(wert, erwartet)) return false;
      continue;
    }

    // Kein Vergleichsobjekt — dann ist der Wert selbst gemeint.
    if (!gleich(wert, erwartet)) return false;
  }

  return true;
}

/**
 * Welche Felder eine Bedingung anspricht — für Anzeige und Fehlersuche.
 *
 * Nicht für die Auswertung: Die läuft über die Bedingungen selbst. Diese
 * Funktion beantwortet „worauf schaut diese Regel", und das ist die Frage vor
 * „warum hat sie nicht ausgelöst".
 */
export function angesprocheneFelder(bedingungen: Bedingungen): string[] {
  return Object.keys(bedingungen);
}
