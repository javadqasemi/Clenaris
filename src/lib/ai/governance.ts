/**
 * KI-Governance: Datensparsamkeit vor dem Versand (Wave 15, 2026-09-23).
 *
 * ---------------------------------------------------------------------------
 *  Warum ein zentraler Ausgangsfilter
 * ---------------------------------------------------------------------------
 *
 * Die KI-Funktionen schicken Text an einen Auftragsverarbeiter im Ausland.
 * Einzelne Funktionen waren bereits sparsam (die Personaldisposition
 * pseudonymisiert Personen und Einsätze), andere nicht: Zusammenfassen und
 * Übersetzen reichten beliebigen Text durch, der E-Mail-Entwurf den Klarnamen
 * der Empfängerin, der Einsatzbericht Kunden- und Teamnamen, die
 * Routenplanung Datenbankkennungen.
 *
 * Eine Regel je Funktion wäre die Regel, die bei der nächsten Funktion
 * fehlt. Deshalb zwei Stufen:
 *
 *  1. **Ausgangsfilter** (`ausgangsfilter`) im KI-Client selbst — jede
 *     Anfrage läuft hindurch, ohne dass der Aufrufer daran denken muss. Er
 *     ersetzt, was sich sicher erkennen lässt und für keine der Aufgaben
 *     nötig ist: E-Mail-Adressen, Telefonnummern, IBAN, AHV-Nummern,
 *     Datenbankkennungen.
 *  2. **Platzhalter** (`mitPlatzhaltern` / `platzhalterZurueck`) dort, wo ein
 *     Name im Ergebnis stehen muss (Anrede im E-Mail-Entwurf, Kunde im
 *     Einsatzbericht): Das Modell sieht `{{EMPFAENGER}}`, das Ergebnis bekommt
 *     den Namen erst danach, im eigenen Prozess.
 *
 * **Was das nicht ist:** Anonymisierung. Namen im Freitext, Adressen für die
 * Routenplanung und fachliche Merkmale bleiben erkennbar. Die Übermittlung
 * wird sparsam, nicht anonym — so steht es auch in `docs/KI_GOVERNANCE.md`.
 *
 * Ohne `server-only` und ohne Abhängigkeiten, damit die Prüfreihe die Regeln
 * direkt prüfen kann (`tests/api/ki-governance.test.ts`).
 */

export interface Filterergebnis {
  text: string;
  /** Je Kategorie, wie oft ersetzt wurde — für das Protokoll, ohne Inhalt. */
  ersetzungen: Record<string, number>;
}

const MUSTER: ReadonlyArray<{ art: string; muster: RegExp; ersatz: string }> = [
  // Reihenfolge ist wichtig: AHV und IBAN vor den Telefonnummern (Ziffernfolgen).
  { art: 'ahv', muster: /\b756[.\s]?\d{4}[.\s]?\d{4}[.\s]?\d{2}\b/g, ersatz: '[AHV-NUMMER]' },
  { art: 'iban', muster: /\b[A-Z]{2}\d{2}(?:[\s]?[0-9A-Z]{4}){3,7}(?:[\s]?[0-9A-Z]{1,4})?\b/g, ersatz: '[IBAN]' },
  { art: 'email', muster: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, ersatz: '[E-MAIL]' },
  // Schweizer Nummern: +41 / 0041 / 0xx, mit Leerzeichen, Punkten oder Bindestrichen.
  { art: 'telefon', muster: /(?:\+41|0041|\b0)[\s.-]?\d{2}[\s.-]?\d{3}[\s.-]?\d{2}[\s.-]?\d{2}\b/g, ersatz: '[TELEFON]' },
  // Datenbankkennungen (cuid): bedeutungslos für das Modell, aber ein Schlüssel in unsere Daten.
  { art: 'kennung', muster: /\bc[a-z0-9]{24}\b/g, ersatz: '[KENNUNG]' },
];

/** Erkennbare Kontakt-, Bank-, Sozialversicherungs- und Datenbankkennungen ersetzen. */
export function ausgangsfilter(text: string): Filterergebnis {
  let ergebnis = text;
  const ersetzungen: Record<string, number> = {};
  for (const { art, muster, ersatz } of MUSTER) {
    ergebnis = ergebnis.replace(muster, () => {
      ersetzungen[art] = (ersetzungen[art] ?? 0) + 1;
      return ersatz;
    });
  }
  return { text: ergebnis, ersetzungen };
}

export function summeErsetzungen(...ergebnisse: Record<string, number>[]): Record<string, number> {
  const summe: Record<string, number> = {};
  for (const e of ergebnisse) for (const [k, v] of Object.entries(e)) summe[k] = (summe[k] ?? 0) + v;
  return summe;
}

/**
 * Namen durch Platzhalter ersetzen, bevor ein Text das Haus verlässt.
 * Längere Namen zuerst, damit „Anna Keller" nicht als „Anna" plus Rest
 * ersetzt wird.
 */
export function mitPlatzhaltern(text: string, namen: Record<string, string | null | undefined>): string {
  const eintraege = Object.entries(namen)
    .filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].trim().length >= 2)
    .sort((a, b) => b[1].length - a[1].length);
  let ergebnis = text;
  for (const [platzhalter, name] of eintraege) {
    ergebnis = ergebnis.split(name).join(`{{${platzhalter}}}`);
  }
  return ergebnis;
}

/** Platzhalter im Ergebnis wieder durch die Namen ersetzen — im eigenen Prozess. */
export function platzhalterZurueck(text: string, namen: Record<string, string | null | undefined>): string {
  let ergebnis = text;
  for (const [platzhalter, name] of Object.entries(namen)) {
    ergebnis = ergebnis.split(`{{${platzhalter}}}`).join(name ?? '');
  }
  return ergebnis;
}

/**
 * Kürzel für Datensätze einer einzelnen Anfrage (A1, A2 …) — dasselbe
 * Verfahren wie in der Personaldisposition. Das Kürzel ist ausserhalb dieser
 * Anfrage bedeutungslos; ein Kürzel, das das Modell erfindet, lässt sich
 * nicht zurückübersetzen und wird verworfen.
 */
export function kuerzel<T extends string>(ids: readonly T[], praefix: string) {
  const hin = new Map<T, string>();
  const zurueck = new Map<string, T>();
  ids.forEach((id, i) => {
    const k = `${praefix}${i + 1}`;
    hin.set(id, k);
    zurueck.set(k, id);
  });
  return {
    hin: (id: T) => hin.get(id) ?? `${praefix}?`,
    zurueck: (k: string) => zurueck.get(k.trim()),
  };
}
