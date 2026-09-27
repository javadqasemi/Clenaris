import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { aufRappen, ausRappen, geld, inRappen, max0, produkt, prozentVon, summe, summeZahl } from '../../src/lib/money';
import { kaufmaennischRunden } from '../../src/lib/runden';
import { gutschriftsSummen, rechnungsSummen } from '../../src/lib/rechnungsbetraege';
import { round2 as biRound2 } from '../../src/lib/bi/math';
import { SAETZE_2026, berechneBeitraege, rappen } from '../../src/lib/payroll/beitraege';
import { monatslohnAnteilig, ueberstundenBetrag } from '../../src/lib/payroll/lohnbestandteile';

/**
 * Geldrechnung (2026-09-27) — die zwei Stellen, an denen Beträge gerundet
 * werden: `money.ts` (dezimal, für Summen und Salden) und `runden.ts` (am
 * Ende einer `number`-Rechnung, auch im Browser).
 *
 * Der Anlass: Alle drei früheren Rundungshelfer rundeten die Binärzahl. Eine
 * Rechnungsposition von 1.5 Std. × CHF 12.35 (= 18.525) stand mit 18.52 auf
 * der Rechnung. `money.ts` verwies in seinem Kopf auf diese Datei, die es bis
 * dahin nicht gab.
 */

describe('kaufmaennischRunden — der Dezimalwert, nicht der Binärwert', () => {
  it('Produkte, die binär knapp unter der Hälfte liegen, runden auf', () => {
    // Jeder dieser Werte ist als Gleitkommazahl 0.00499999… statt 0.005.
    assert.equal(kaufmaennischRunden(1.5 * 12.35), 18.53);
    assert.equal(kaufmaennischRunden(0.5 * 10.05), 5.03);
    assert.equal(kaufmaennischRunden(2.675), 2.68);
    assert.equal(kaufmaennischRunden(1.005), 1.01);
  });

  it('negativ spiegelbildlich, null bleibt null, ganze Zahlen unberührt', () => {
    assert.equal(kaufmaennischRunden(-18.525), -18.53);
    assert.equal(kaufmaennischRunden(-0.001), 0);
    assert.equal(Object.is(kaufmaennischRunden(-0.001), -0), false, 'keine negative Null');
    assert.equal(kaufmaennischRunden(42), 42);
    assert.equal(kaufmaennischRunden(1e-7), 0);
    assert.equal(kaufmaennischRunden(1234567.891), 1234567.89);
  });

  it('andere Stellenzahl: 5 Rappen sind eine eigene Regel, hier nur Stellen', () => {
    assert.equal(kaufmaennischRunden(8.10405, 3), 8.104);
    assert.equal(kaufmaennischRunden(0.0005, 3), 0.001);
  });

  it('alle drei Helfer runden dieselbe Grenze gleich', () => {
    for (const wert of [18.525, 5.025, 2.675, -18.525, 0.125]) {
      const erwartet = kaufmaennischRunden(wert);
      assert.equal(biRound2(wert), erwartet, `bi/math ${wert}`);
      assert.equal(rappen(wert), erwartet, `payroll ${wert}`);
    }
  });
});

describe('Rechnungs- und Gutschriftsbeträge — dezimal', () => {
  const pos = (quantity: number, unitPrice: number, vatRate = 8.1, discount = 0) => ({ quantity, unitPrice, vatRate, discount });

  it('0.1 + 0.2: zwei Positionen ergeben genau 0.30', () => {
    const r = rechnungsSummen([pos(1, 0.1, 0), pos(1, 0.2, 0)]);
    assert.equal(r.subtotal, 0.3);
    assert.equal(r.grossTotal, 0.3);
  });

  it('grosse Beträge bleiben exakt', () => {
    const r = rechnungsSummen([pos(1000, 99_999.99, 8.1)]);
    assert.equal(r.netTotal, 99_999_990);
    // 99 999 990 × 8.1 % = 8 099 999.19
    assert.equal(r.vatAmount, 8_099_999.19);
    assert.equal(r.grossTotal, 108_099_989.19);
  });

  it('Rundung: 1.5 × 12.35 ist 18.53, die MWST je Position gerundet', () => {
    const r = rechnungsSummen([pos(1.5, 12.35)]);
    assert.equal(r.items[0]!.netAmount, 18.53);
    assert.equal(r.items[0]!.vatAmount, 1.5);
    assert.equal(r.grossTotal, 20.03);
  });

  it('MWST je Position, nicht auf dem Total: gemischte Sätze', () => {
    // 5 × 0.30 zu 8.1 %: je Position 0.0243 → 0.02, zusammen 0.10. Auf dem
    // Total gerechnet wären es 1.50 × 8.1 % = 0.1215 → 0.12 — die Regel
    // „je Position" (Architekturentscheid 4 in invoice.service) gilt.
    const r = rechnungsSummen(Array.from({ length: 5 }, () => pos(1, 0.3)));
    assert.equal(r.vatAmount, 0.1);
    const gemischt = rechnungsSummen([pos(1, 100, 8.1), pos(1, 100, 2.6)]);
    assert.equal(gemischt.vatAmount, 10.7);
  });

  it('Rabattreihenfolge: erst Positionsrabatt, dann Rechnungsrabatt, MWST anteilig', () => {
    // 200 − 10 % = 180; Rechnungsrabatt 30 → 150; MWST 14.58 × 150/180 = 12.15
    const r = rechnungsSummen([pos(2, 100, 8.1, 10)], 30);
    assert.equal(r.items[0]!.netAmount, 180);
    assert.equal(r.subtotal, 180);
    assert.equal(r.netTotal, 150);
    assert.equal(r.vatAmount, 12.15);
    assert.equal(r.grossTotal, 162.15);
    // Ein Rechnungsrabatt über der Zwischensumme wird gekappt, nie negativ.
    assert.equal(rechnungsSummen([pos(1, 50)], 80).netTotal, 0);
  });

  it('Gutschrift: Netto und MWST dezimal', () => {
    const g = gutschriftsSummen([pos(1.5, 12.35), pos(1, 0.1, 0), pos(1, 0.2, 0)]);
    assert.equal(g.netTotal, 18.83);
    // 18.525 × 8.1 % = 1.5005… → 1.50
    assert.equal(g.vatAmount, 1.5);
    assert.equal(g.grossTotal, 20.33);
  });
});

describe('produkt und prozentVon — Produkte dezimal (Preis-Engine)', () => {
  it('Produkte, deren Binärwert unter die Hälfte fällt, runden auf', () => {
    // Treffer der Suche vom 2026-09-27: binär 45.22, 133.7, 0.03.
    assert.equal(produkt(30.15, 1.5), 45.23);
    assert.equal(produkt(30.25, 4.42), 133.71);
    assert.equal(prozentVon(0.35, 10), 0.04);
    assert.equal(prozentVon(1.5, 15), 0.23);
    // Zur Gegenprobe: genau diese Fälle rundet die Zahlenrechnung falsch.
    assert.equal(kaufmaennischRunden(30.15 * 1.5), 45.22);
    assert.equal(kaufmaennischRunden(0.35 * (10 / 100)), 0.03);
  });

  it('MWST, grosse Beträge, negative Werte, Summen', () => {
    assert.equal(prozentVon(45.23, 8.1), 3.66);
    assert.equal(prozentVon(9_999_999.99, 8.1), 810_000);
    assert.equal(produkt(-30.15, 1.5), -45.23);
    assert.equal(summeZahl(0.1, 0.2), 0.3);
    assert.equal(summeZahl(45.23, -6.78, 3.66), 42.11);
  });
});

describe('Lohn — Beiträge und Bestandteile dezimal', () => {
  it('AHV 5.3 % von CHF 1085.00 sind 57.51, nicht 57.50', () => {
    const b = berechneBeitraege({ bruttoMonat: 1085, bruttoJahr: 1085 * 12, alter: 30 }, SAETZE_2026);
    assert.equal(b.ahvIv, 57.51);
    // Gegenprobe: die frühere Rechnung ergab 57.50.
    assert.equal(rappen(1085 * (5.3 / 100)), 57.5);
    // Summe = Summe der angezeigten Zeilen.
    assert.equal(b.summe, summeZahl(b.ahvIv, b.alv, b.bvg, b.uvg, b.ktg));
  });

  it('Überstunden und anteiliger Monatslohn ohne Binärfehler', () => {
    // 1.5 Std. × CHF 30.15 × 125 % = 56.53125 → 56.53
    assert.equal(ueberstundenBetrag(1.5, 30.15, 25), 56.53);
    // 30.15 × 1.5 = 45.225 → 45.23 (ohne Zuschlag)
    assert.equal(ueberstundenBetrag(1.5, 30.15, 0), 45.23);
    // Ein voller Monat nach Kalendertagen ist genau der Monatslohn, auch bei 31 Tagen.
    const voll = monatslohnAnteilig({ jahr: 2026, monat: 1, abschnitte: [{ abTag: 1, monatslohnVoll: 4567.85 }], ersterTag: 1, letzterTag: 31 });
    assert.equal(voll.betrag, 4567.85);
  });
});

describe('money.ts — dezimal', () => {
  it('0.1 + 0.2 ist 0.3; Summen und Rappen exakt', () => {
    assert.equal(summe([0.1, 0.2]).toString(), '0.3');
    assert.equal(summe(['18.525', 0]).toString(), '18.53');
    assert.equal(aufRappen('18.525').toString(), '18.53');
    assert.equal(geld(null).toString(), '0');
  });

  it('Rappen für Stripe und zurück; nie negativ, wo es nicht darf', () => {
    assert.equal(inRappen('12.35'), 1235);
    assert.equal(ausRappen(1235).toString(), '12.35');
    assert.equal(max0(-5).toString(), '0');
    assert.equal(max0('7.5').toString(), '7.5');
  });
});
