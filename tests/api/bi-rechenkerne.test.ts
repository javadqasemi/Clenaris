import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { budgetVariance, computeScenario, depreciation, keyResultProgress, riskBand, riskSeverity, subScore, weightedScore } from '../../src/lib/bi/math';
import { periodOf, shiftPeriod, wholeMonthsBetween, workingDays, zurichMidnight } from '../../src/lib/bi/periods';

/**
 * Rechenkerne der Unternehmensführung mit festen Zahlen.
 *
 * Die einzige Stelle, an der die Prüfungen Anwendungscode direkt importieren —
 * bewusst: Abschreibung, Gesundheitswert, Budgetabweichung und Szenario sind
 * reine Funktionen ohne Datenbank, und ihre Richtigkeit lässt sich über HTTP
 * nur mit einem Datenbestand prüfen, der die Rechnung verdeckt. Die Zahlen
 * unten stammen aus `docs/bi/05-MIGRATION-TESTS-BETRIEB.md`.
 */

describe('Rechenkerne der Unternehmensführung', () => {
  describe('Abschreibung', () => {
    it('linear: 24 000 über 4 Jahre, nach 18 Monaten 15 000', () => {
      const result = depreciation({ purchaseAmount: 24_000, residualValue: 0, usefulLifeYears: 4, method: 'STRAIGHT_LINE', monthsInService: 18 });
      assert.equal(result.bookValue, 15_000);
      assert.equal(result.accumulated, 9_000);
      assert.equal(result.annualCharge, 6_000);
      assert.equal(result.remainingMonths, 30);
    });

    it('linear: nie unter den Restwert', () => {
      const result = depreciation({ purchaseAmount: 24_000, residualValue: 4_000, usefulLifeYears: 4, method: 'STRAIGHT_LINE', monthsInService: 120 });
      assert.equal(result.bookValue, 4_000);
      assert.equal(result.annualCharge, 0);
    });

    it('degressiv: 20 000 auf 2 000 in 5 Jahren ergibt einen Satz von 36.9 % und nach einem Jahr 12 620', () => {
      const result = depreciation({ purchaseAmount: 20_000, residualValue: 2_000, usefulLifeYears: 5, method: 'DECLINING', monthsInService: 12 });
      assert.equal(result.rate, 0.3690);
      // 20 000 × (1 − 0.369) = 12 619.15 — der Bauplan rundet auf 12 620.
      assert.ok(Math.abs(result.bookValue - 12_620) < 1, `Restwert ${result.bookValue}`);
    });

    it('ohne Abschreibung bleibt der Anschaffungswert', () => {
      const result = depreciation({ purchaseAmount: 10_000, residualValue: 0, usefulLifeYears: null, method: 'NONE', monthsInService: 36 });
      assert.equal(result.bookValue, 10_000);
      assert.equal(result.remainingMonths, null);
    });

    it('verlangt bei linear und degressiv eine Nutzungsdauer', () => {
      assert.throws(() => depreciation({ purchaseAmount: 10_000, residualValue: 0, usefulLifeYears: null, method: 'STRAIGHT_LINE', monthsInService: 0 }));
    });
  });

  describe('Gesundheitswert', () => {
    it('Teilnote linear zwischen Warnschwelle und Ziel, gekappt', () => {
      assert.equal(subScore(30, 20, 40), 50);
      assert.equal(subScore(45, 20, 40), 100);
      assert.equal(subScore(10, 20, 40), 0);
    });

    it('„weniger ist besser" dreht die Formel über die Lage der Schwellen', () => {
      // Warnschwelle 45 Tage, Ziel 25 Tage: 35 Tage sind die Mitte.
      assert.equal(subScore(35, 45, 25), 50);
      assert.equal(subScore(20, 45, 25), 100);
    });

    it('Gewichte 20 und 10 mit Teilnoten 80 und 50 ergeben 70', () => {
      assert.equal(weightedScore([{ subScore: 80, weight: 20 }, { subScore: 50, weight: 10 }]), 70);
    });

    it('ohne gewichtete Einträge gibt es keinen Wert', () => {
      assert.equal(weightedScore([{ subScore: 80, weight: 0 }]), null);
    });
  });

  describe('Budgetabweichung', () => {
    it('Plan 12 000 im Jahr, Ist 5 200 nach 4 Monaten: +1 200 (30 %)', () => {
      const result = budgetVariance({ plan: 12_000, monthlyPlan: [], actual: 5_200, elapsedMonths: 4, totalMonths: 12 });
      assert.equal(result.planToDate, 4_000);
      assert.equal(result.variance, 1_200);
      assert.equal(result.variancePct, 30);
      assert.equal(result.forecast, 15_600);
    });

    it('Hochrechnung erst ab drei Monaten', () => {
      const result = budgetVariance({ plan: 12_000, monthlyPlan: [], actual: 2_000, elapsedMonths: 2, totalMonths: 12 });
      assert.equal(result.forecast, null);
    });

    it('nutzt die Monatsverteilung, wenn sie vollständig ist', () => {
      const plan = [2_000, 2_000, 500, 500, 500, 500, 500, 500, 500, 500, 2_000, 2_000];
      const result = budgetVariance({ plan: 12_000, monthlyPlan: plan, actual: 4_000, elapsedMonths: 2, totalMonths: 12 });
      assert.equal(result.planToDate, 4_000);
      assert.equal(result.variance, 0);
    });
  });

  describe('Szenario', () => {
    it('Fixkosten 8 000, Deckungsbeitrag 45 %, Umsatz 20 000: Break-even im ersten Monat', () => {
      const result = computeScenario({
        horizonMonths: 6,
        openingCash: 10_000,
        drivers: {
          jobsPerMonth: { value: 80, monthlyChangePct: 0 },
          averageTicket: { value: 250, monthlyChangePct: 0 },
          laborCostPct: { value: 45, monthlyChangePct: 0 },
          materialCostPct: { value: 10, monthlyChangePct: 0 },
          overheadPerMonth: { value: 8_000, monthlyChangePct: 0 },
        },
        jobsPerCustomerMonth: 0.5,
        hoursPerFteMonth: 182,
      });
      assert.equal(result.months[0].revenue, 20_000);
      assert.equal(result.months[0].contribution, 9_000);
      assert.equal(result.months[0].result, 1_000);
      assert.equal(result.breakEvenMonth, 1);
      assert.equal(result.breakEvenRevenue, Math.round((8_000 / 0.45) * 100) / 100);
    });

    it('Zahlungsverzug verschiebt die Einzahlung, nicht den Umsatz', () => {
      const result = computeScenario({
        horizonMonths: 3,
        openingCash: 0,
        drivers: {
          jobsPerMonth: { value: 10, monthlyChangePct: 0 },
          averageTicket: { value: 1_000, monthlyChangePct: 0 },
          overheadPerMonth: { value: 1_000, monthlyChangePct: 0 },
          paymentDelayDays: { value: 30, monthlyChangePct: 0 },
        },
        jobsPerCustomerMonth: 1,
        hoursPerFteMonth: 182,
      });
      assert.equal(result.months[0].cashIn, 0);
      assert.equal(result.months[1].cashIn, 10_000);
      assert.equal(result.liquidityLow.month, 1);
      assert.equal(result.liquidityLow.cash, -1_000);
    });

    it('Wachstum je Monat wirkt zinseszinsartig', () => {
      const result = computeScenario({
        horizonMonths: 3,
        openingCash: 0,
        drivers: { jobsPerMonth: { value: 100, monthlyChangePct: 10 }, averageTicket: { value: 10, monthlyChangePct: 0 } },
        jobsPerCustomerMonth: 1,
        hoursPerFteMonth: 182,
      });
      assert.equal(result.months[2].jobs, 121);
    });
  });

  describe('Fortschritt und Risiko', () => {
    it('Fortschritt zwischen Start und Ziel, gekappt', () => {
      assert.equal(keyResultProgress(0, 10, 4, 'UP_IS_GOOD'), 40);
      assert.equal(keyResultProgress(50, 20, 35, 'DOWN_IS_GOOD'), 50);
      assert.equal(keyResultProgress(0, 10, 15, 'UP_IS_GOOD'), 100);
      assert.equal(keyResultProgress(10, 10, 10, 'UP_IS_GOOD'), 100);
    });

    it('Schwere und Stufe', () => {
      assert.equal(riskSeverity(3, 4), 12);
      assert.equal(riskBand(12), 'HIGH');
      assert.equal(riskBand(16), 'CRITICAL');
      assert.equal(riskBand(4), 'LOW');
    });
  });

  describe('Perioden', () => {
    it('Monatsgrenzen liegen auf Zürcher Mitternacht', () => {
      const march = periodOf('MONTH', zurichMidnight(2026, 2, 15));
      assert.equal(march.periodStart.toISOString().slice(0, 10), '2026-03-01');
      assert.equal(march.periodEnd.toISOString().slice(0, 10), '2026-03-31');
      // 1. März 00:00 Zürich = 28. Februar 23:00 UTC (Winterzeit).
      assert.equal(march.from.toISOString(), '2026-02-28T23:00:00.000Z');
      assert.equal(march.label, 'März 2026');
    });

    it('Quartale und Verschiebung', () => {
      const q = periodOf('QUARTER', zurichMidnight(2026, 4, 10));
      assert.equal(q.label, 'Q2 2026');
      assert.equal(shiftPeriod(q, -1).label, 'Q1 2026');
      assert.equal(shiftPeriod(q, 3).label, 'Q1 2027');
    });

    it('Wochen beginnen am Montag', () => {
      const week = periodOf('WEEK', zurichMidnight(2026, 8, 16)); // Mittwoch
      assert.equal(week.periodStart.getUTCDay(), 1);
      assert.equal(week.periodStart.toISOString().slice(0, 10), '2026-09-14');
    });

    it('Arbeitstage ohne Wochenenden und Feiertage', () => {
      const from = new Date(Date.UTC(2026, 11, 21));
      const to = new Date(Date.UTC(2026, 11, 31));
      assert.equal(workingDays(from, to), 9);
      assert.equal(workingDays(from, to, [new Date(Date.UTC(2026, 11, 25))]), 8);
    });

    it('ganze Monate zwischen Kalendertagen', () => {
      assert.equal(wholeMonthsBetween(new Date(Date.UTC(2025, 0, 15)), new Date(Date.UTC(2026, 6, 14))), 17);
      assert.equal(wholeMonthsBetween(new Date(Date.UTC(2025, 0, 15)), new Date(Date.UTC(2026, 6, 15))), 18);
    });
  });
});
