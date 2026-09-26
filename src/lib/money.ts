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

export function max0(wert: Eingabe): Geld {
  const w = geld(wert);
  return w.isNegative() ? new Prisma.Decimal(0) : w;
}
