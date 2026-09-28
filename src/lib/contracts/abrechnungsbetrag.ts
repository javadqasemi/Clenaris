import { aufRappen, geld, prozentVon, summeZahl, type Eingabe } from '@/lib/money';

/**
 * Der Betrag einer Vertragsperiode — rein gerechnet, ohne Datenbank.
 *
 * Herausgelöst aus `contractBillingBasis` (2026-09-28), damit die Rechnung
 * selbst prüfbar ist: Über die Schnittstelle liesse sich ein Stundenvertrag
 * mit genau 90 freigegebenen Minuten nur mit einem Bestand aus Einsätzen und
 * Zeiterfassung herstellen, der die Rechnung verdeckt
 * (`tests/api/vertraege-rechenkern.test.ts`).
 *
 * **Dezimal, gerundet erst am Ende.** Vorher Gleitkomma mit
 * `Math.round(x * 100) / 100` — genau die Rechnung, die
 * `lib/rechnungsbetraege.ts` für Rechnungen schon abgelöst hatte. 90 Minuten
 * zu CHF 12.35 sind 18.525 und damit 18.53; binär ist 18.525 aber
 * 18.52499…, und der Vertrag verrechnete 18.52. Der Betrag wird zur
 * `unitPrice` der Vertragsrechnung — ein falscher Rappen landete also auf einem
 * ausgestellten Beleg. Die Stunden entstehen deshalb nicht als `Minuten / 60`
 * (periodischer Bruch), sondern `Minuten × Satz / 60` in einem Zug.
 */
export type Preismodell = 'FIXED_PERIOD' | 'FIXED_PER_VISIT' | 'HOURLY' | 'UNIT_BASED' | string;

export interface AbrechnungsEingabe {
  pricingModel: Preismodell;
  baseAmount: Eingabe;
  hourlyRate: Eingabe;
  unitPrice: Eingabe;
  vatRate: Eingabe;
  /** Abgeschlossene oder geprüfte Einsätze der Periode. */
  einsaetze: number;
  /** Freigegebene Minuten der Periode. */
  minuten: number;
  /** Summe der Mengen aller Leistungen der Fassung. */
  menge: Eingabe;
  /** Zeitanteil an der vollen Periode, 0 < anteil ≤ 1. */
  anteil: number;
}

export function abrechnungsbetrag(e: AbrechnungsEingabe): { netto: number; mwst: number; brutto: number } {
  const anteil = Math.min(1, Math.max(0, e.anteil));
  let roh;
  switch (e.pricingModel) {
    case 'FIXED_PER_VISIT':
      roh = geld(e.baseAmount).times(e.einsaetze);
      break;
    case 'HOURLY':
      roh = geld(e.minuten).times(geld(e.hourlyRate)).dividedBy(60);
      break;
    case 'UNIT_BASED':
      roh = geld(e.menge).times(geld(e.unitPrice)).times(anteil);
      break;
    // FIXED_PERIOD und jede abweichende Vereinbarung: der Betrag der Fassung.
    default:
      roh = geld(e.baseAmount).times(anteil);
  }
  const netto = aufRappen(roh).toNumber();
  const mwst = prozentVon(netto, e.vatRate);
  return { netto, mwst, brutto: summeZahl(netto, mwst) };
}
