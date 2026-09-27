/**
 * Rechnungs- und Gutschriftsbeträge — dezimal gerechnet (2026-09-27).
 *
 * ---------------------------------------------------------------------------
 *  Warum hier und warum dezimal
 * ---------------------------------------------------------------------------
 *
 * Die Beträge stehen als `Decimal(12,2)` in der Datenbank, gerechnet wurden
 * sie in `invoice.service.ts` aber in JavaScript-`number`: Menge × Preis ×
 * (1 − Rabatt) → MWST, jede Stufe binär, gerundet mit einem Helfer, der die
 * Binärzahl rundete. 1.5 Std. × CHF 12.35 stand mit 18.52 statt 18.53 auf der
 * Rechnung. Die Rundung ist inzwischen korrigiert (`lib/runden.ts`), doch in
 * einer Kette von Operationen kann das Ergebnis auf die *benachbarte*
 * Binärzahl fallen — und deren kürzeste Darstellung ist dann nicht mehr der
 * gemeinte Dezimalwert. Für das, was auf einer Rechnung steht, rechnet dieses
 * Modul deshalb vom ersten Schritt an mit `Prisma.Decimal` (`lib/money.ts`)
 * und gibt erst die fertigen, auf Rappen gerundeten Beträge als Zahl heraus.
 *
 * Die Regeln selbst sind unverändert übernommen:
 *
 *  • **Rechnung:** je Position Netto = Menge × Preis × (1 − Positionsrabatt),
 *    auf Rappen; MWST je Position auf Rappen; ein Rechnungsrabatt wird auf die
 *    Zwischensumme gekappt und anteilig auf die MWST umgelegt.
 *  • **Gutschrift:** Netto und MWST über alle Positionen, je einmal gerundet.
 *
 * Rein, ohne `server-only` und ohne Pfad-Aliasse: `tests/api/geldrechnung.test.ts`
 * importiert es direkt.
 */

import { aufRappen, geld, summe, type Geld } from './money';

export interface RechnungsPosition {
  quantity: number;
  unitPrice: number;
  vatRate: number;
  /** Positionsrabatt in Prozent. */
  discount?: number | null;
}

export interface BerechnetePosition {
  netAmount: number;
  vatAmount: number;
  lineTotal: number;
}

export interface Rechnungssummen<P> {
  subtotal: number;
  netTotal: number;
  vatAmount: number;
  grossTotal: number;
  items: (P & BerechnetePosition & { position: number })[];
}

const HUNDERT = geld(100);

export function rechnungsSummen<P extends RechnungsPosition>(positionen: P[], rechnungsrabatt: number = 0): Rechnungssummen<P> {
  const zeilen = positionen.map((p, index) => {
    const brutto = geld(p.quantity).times(geld(p.unitPrice));
    const netto = aufRappen(brutto.times(HUNDERT.minus(geld(p.discount ?? 0))).dividedBy(HUNDERT));
    const mwst = aufRappen(netto.times(geld(p.vatRate)).dividedBy(HUNDERT));
    return { p, index, netto, mwst };
  });

  const zwischensumme = summe(zeilen.map((z) => z.netto));
  const rabatt = aufRappen(kleiner(geld(rechnungsrabatt), zwischensumme));
  const nettoTotal = aufRappen(zwischensumme.minus(rabatt));
  // Rabatt anteilig auf die MWST-Basis: jede Position im Verhältnis
  // Netto nach Rabatt / Netto vor Rabatt.
  const faktor = zwischensumme.greaterThan(0) ? nettoTotal.dividedBy(zwischensumme) : geld(1);
  const mwstTotal = aufRappen(zeilen.reduce((s, z) => s.plus(z.mwst.times(faktor)), geld(0)));

  return {
    subtotal: zwischensumme.toNumber(),
    netTotal: nettoTotal.toNumber(),
    vatAmount: mwstTotal.toNumber(),
    grossTotal: aufRappen(nettoTotal.plus(mwstTotal)).toNumber(),
    items: zeilen.map((z) => ({
      ...z.p,
      netAmount: z.netto.toNumber(),
      vatAmount: z.mwst.toNumber(),
      lineTotal: aufRappen(z.netto.plus(z.mwst)).toNumber(),
      position: z.index,
    })),
  };
}

export function gutschriftsSummen(positionen: RechnungsPosition[]): { netTotal: number; vatAmount: number; grossTotal: number } {
  const netto = aufRappen(positionen.reduce((s, p) => s.plus(geld(p.quantity).times(geld(p.unitPrice))), geld(0)));
  const mwst = aufRappen(
    positionen.reduce((s, p) => s.plus(geld(p.quantity).times(geld(p.unitPrice)).times(geld(p.vatRate)).dividedBy(HUNDERT)), geld(0)),
  );
  return { netTotal: netto.toNumber(), vatAmount: mwst.toNumber(), grossTotal: aufRappen(netto.plus(mwst)).toNumber() };
}

function kleiner(a: Geld, b: Geld): Geld {
  return a.lessThan(b) ? a : b;
}
