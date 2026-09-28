import { Prisma } from '@prisma/client';

/**
 * Geldrechnung mit Dezimalzahlen — nie mit binären Gleitkommazahlen
 * (2026-09-27).
 *
 * Gespeichert wird Geld seit jeher als `Decimal(12,2)`. Gerechnet wurde es
 * trotzdem in JavaScript-`number`: `toNumber()` am Anfang, `Math.round(x *
 * 100) / 100` am Ende, dazwischen Gleitkomma. Für Einzelbeträge fällt das
 * selten auf; für Summen, Salden und Rückerstattungen schon — `0.1 + 0.2`
 * ist in `number` nicht `0.3`, und ein Saldo von `-0.0000000001` ist nicht
 * „bezahlt". Drei verschiedene Rundungshelfer (`utils.round2` mit EPSILON,
 * `bi/math.round2` ohne, `payroll/beitraege.rappen`) rundeten dieselbe
 * Grenze verschieden.
 *
 * Hier liegt **eine** Rechnung: `Prisma.Decimal` (decimal.js, dieselbe
 * Bibliothek, die Prisma für die Spalten zurückgibt), gerundet kaufmännisch
 * auf Rappen (`ROUND_HALF_UP`). In `number` umgewandelt wird erst am Rand —
 * Anzeige, JSON-Antwort, Stripe-Rappen.
 *
 * Ohne `server-only`: reine Rechnung ohne Geheimnis, prüfbar ohne Server
 * (`tests/api/geldrechnung.test.ts`).
 */

export type Geld = Prisma.Decimal;
type Eingabe = Prisma.Decimal | number | string | null | undefined;

const RAPPEN_STELLEN = 2;

/** Ein Betrag als Dezimalzahl; `null`/`undefined` gelten als 0. */
export function geld(wert: Eingabe): Geld {
  if (wert === null || wert === undefined) return new Prisma.Decimal(0);
  return wert instanceof Prisma.Decimal ? wert : new Prisma.Decimal(wert);
}

/** Auf Rappen runden, kaufmännisch (0.005 → 0.01). */
export function aufRappen(wert: Eingabe): Geld {
  return geld(wert).toDecimalPlaces(RAPPEN_STELLEN, Prisma.Decimal.ROUND_HALF_UP);
}

/** Summe beliebig vieler Beträge, exakt, danach auf Rappen gerundet. */
export function summe(werte: Iterable<Eingabe>): Geld {
  let s = new Prisma.Decimal(0);
  for (const w of werte) s = s.plus(geld(w));
  return aufRappen(s);
}

/** Für die Anzeige und JSON — erst am Rand, nie zum Weiterrechnen. */
export function alsZahl(wert: Eingabe): number {
  return aufRappen(wert).toNumber();
}

/** Ganze Rappen (Stripe rechnet in der kleinsten Einheit). */
export function inRappen(wert: Eingabe): number {
  return aufRappen(wert).times(100).toNumber();
}

export function ausRappen(rappen: number): Geld {
  return aufRappen(new Prisma.Decimal(rappen).dividedBy(100));
}

/**
 * a × b, dezimal gerechnet und auf Rappen gerundet — als Zahl für die
 * Weiterverarbeitung (2026-09-27, Preis-Engine).
 *
 * CHF 30.15 × 1.5 Std. sind 45.225; binär ergibt das Produkt die Zahl knapp
 * darunter, und selbst die Rundung auf die kürzeste Dezimaldarstellung
 * (`kaufmaennischRunden`) macht daraus 45.22 — sie rundet richtig, aber die
 * *falsche Zahl*. Die Eingaben dagegen sind exakt: Eine `number` wie 30.15
 * wird als „30.15" übernommen. Also wird das Produkt dezimal gebildet.
 *
 * Wichtig für Aufrufer: Faktoren nie vorher binär umformen. `geld(1.15 - 1)`
 * ist 0.1499999…, `geld(1.15).minus(1)` ist 0.15.
 */
export function produkt(a: Eingabe, b: Eingabe): number {
  return aufRappen(geld(a).times(geld(b))).toNumber();
}

/** `prozent` % von `basis`, dezimal, auf Rappen. Der Satz als Prozentzahl (8.1), nicht als Anteil (0.081). */
export function prozentVon(basis: Eingabe, prozent: Eingabe): number {
  return aufRappen(geld(basis).times(geld(prozent)).dividedBy(100)).toNumber();
}

/** Summe als Zahl, dezimal gerechnet. */
export function summeZahl(...werte: Eingabe[]): number {
  return summe(werte).toNumber();
}

export function max0(wert: Eingabe): Geld {
  const w = geld(wert);
  return w.isNegative() ? new Prisma.Decimal(0) : w;
}

/**
 * Der Ertrag eines Einsatzes ohne Buchung als eine Rechnungszeile
 * (2026-09-27, Befund N-03).
 *
 * Die Regel: Verrechnet wird der vereinbarte Ertrag des Einsatzes — nicht
 * mehr, nicht weniger. `invoice.service.ts:createInvoiceFromJobs` bildete
 * vorher Menge = Stunden und Einzelpreis = Ertrag / max(Stunden, 0.5). Unter
 * 30 Minuten verrechnete das nur einen Bruchteil (20 Minuten, Ertrag 100 →
 * 0.33 × 200 = 66), darüber wich gerundeter Satz mal gerundete Stunden vom
 * Ertrag ab. Eine Menge × Satz, deren Produkt *genau* der Ertrag ist, gibt es
 * bei Stunden wie 0.33 nicht; eine Pauschale über den Ertrag ist die einzige
 * Zeile, die ihn exakt trägt. Die Dauer bleibt als Auskunft (`stunden`) für
 * den Zeilentext erhalten.
 *
 * Hier und nicht im Dienst, weil der Dienst `server-only` ist und die Regel
 * sich so ohne Server prüfen lässt (`tests/api/finanzbelege.test.ts`).
 */
export function einsatzertragAlsPauschale(
  ertrag: Eingabe,
  minuten: number,
): { quantity: number; unit: string; unitPrice: number; stunden: number } {
  return {
    quantity: 1,
    unit: 'Pauschal',
    unitPrice: aufRappen(ertrag).toNumber(),
    stunden: aufRappen(geld(Math.max(0, minuten)).dividedBy(60)).toNumber(),
  };
}
