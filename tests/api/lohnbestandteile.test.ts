import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SAETZE_2026, rappen, type ArbeitgeberSaetze } from '../../src/lib/payroll/beitraege';
import {
  berechneDreizehnten,
  ermittleLohnteil,
  ferienanteilProzent,
  monatslohnAnteilig,
  schliesseAbrechnungAb,
  ueberstundenBetrag,
  werktage,
  type AbrechnungsEingabe,
  type DreizehnterGrundlage,
  type QuellensteuerGrundlage,
} from '../../src/lib/payroll/lohnbestandteile';

/**
 * Wave 9, Ausbau vom 2026-09-23 — die Bestandteile einer Abrechnung.
 *
 * Direkt geprüft, aus demselben Grund wie die Beitragsrechnung in
 * `lohnabrechnung.test.ts`: Gegenstand ist die Rechnung, und jede Zahl hier
 * soll sich von Hand nachrechnen lassen. Über HTTP prüft
 * `lohnabrechnung.test.ts`, dass der Lauf diese Rechnung mit den richtigen
 * Eingaben aufruft (Ein-/Austritt, Lohnänderung, Positionen, Sperre).
 *
 * **Keine Aussage über die Rechtslage.** Geprüft wird, dass die Rechnung tut,
 * was sie verspricht — nicht, dass Kalendertage statt 30er-Monate oder die
 * Ziffernzuordnung des Lohnausweises fachlich richtig sind. Das steht als
 * externe Prüfung in `docs/PAYROLL.md`.
 */

const KEIN_AG: ArbeitgeberSaetze = { ahvIvEo: 0, alv: 0, alvUeberGrenze: 0, uvgNbu: 0, uvgBu: 0, ktg: 0, fak: 0, vk: 0 };
const KEIN_13: DreizehnterGrundlage = {
  art: 'NONE',
  auszahlungsmonat: 12,
  grundlohnBisherImJahr: 0,
  bereitsAusbezahlt: 0,
  monatslohnVoll: null,
  anstellungstageImJahr: 0,
  tageImJahr: 365,
  austrittImMonat: false,
};

function eingabe(teil: Partial<AbrechnungsEingabe> = {}): AbrechnungsEingabe {
  return {
    jahr: 2026,
    monat: 3,
    grundlohn: { art: 'MONTHLY', betrag: 5000, tage: 31, voll: true, monatslohnVoll: 5000 },
    unbezahlteTage: 0,
    werktageImMonat: 22,
    positionen: [],
    ferienImLohn: false,
    ferientageJeJahr: 20,
    feiertagsanteilPct: null,
    dreizehnter: KEIN_13,
    saetze: SAETZE_2026,
    arbeitgeber: KEIN_AG,
    alter: 40,
    bruttoJahrHochrechnung: 60_000,
    ...teil,
  };
}

const KEINE_QST: QuellensteuerGrundlage = { status: 'KEINE' };

describe('Monatslohn nach Kalendertagen', () => {
  it('Eintritt am 20. eines 30-Tage-Monats: 11/30', () => {
    const r = monatslohnAnteilig({ jahr: 2026, monat: 4, abschnitte: [{ abTag: 1, monatslohnVoll: 6000 }], ersterTag: 20, letzterTag: 30 });
    assert.equal(r.betrag, 2200);
    assert.equal(r.tage, 11);
    assert.equal(r.voll, false);
  });

  it('Austritt am 10. eines 31-Tage-Monats: 10/31', () => {
    const r = monatslohnAnteilig({ jahr: 2026, monat: 1, abschnitte: [{ abTag: 1, monatslohnVoll: 6200 }], ersterTag: 1, letzterTag: 10 });
    assert.equal(r.betrag, 2000);
  });

  it('Lohnänderung am 16.: jeder Tag mit dem Lohn, der an ihm galt', () => {
    const r = monatslohnAnteilig({
      jahr: 2026,
      monat: 1,
      abschnitte: [
        { abTag: 1, monatslohnVoll: 5000 },
        { abTag: 16, monatslohnVoll: 6200 },
      ],
      ersterTag: 1,
      letzterTag: 31,
    });
    assert.equal(r.betrag, rappen((15 / 31) * 5000 + (16 / 31) * 6200));
    assert.equal(r.voll, true);
  });

  it('ein ganzer Monat ergibt genau den Monatslohn', () => {
    const r = monatslohnAnteilig({ jahr: 2026, monat: 2, abschnitte: [{ abTag: 1, monatslohnVoll: 4321.55 }], ersterTag: 1, letzterTag: 28 });
    assert.equal(r.betrag, 4321.55);
  });
});

describe('Kalenderhilfen', () => {
  it('Werktage Mo–Fr', () => {
    // März 2026: 1. ist ein Sonntag → 22 Werktage.
    assert.equal(werktage(new Date(Date.UTC(2026, 2, 1)), new Date(Date.UTC(2026, 2, 31))), 22);
  });
  it('Ferienentschädigung aus Ferienwochen', () => {
    assert.equal(ferienanteilProzent(20), 8.3333);
    assert.equal(ferienanteilProzent(25), 10.6383);
    assert.equal(ferienanteilProzent(30), 13.0435);
    assert.equal(ferienanteilProzent(0), 0);
  });
});

describe('Lohnbestandteile', () => {
  it('unbezahlter Urlaub: Monatslohn ÷ Werktage × Tage', () => {
    const t = ermittleLohnteil(eingabe({ grundlohn: { art: 'MONTHLY', betrag: 6000, tage: 31, voll: true, monatslohnVoll: 6000 }, unbezahlteTage: 2 }));
    const zeile = t.zeilen.find((z) => z.type === 'UNPAID_LEAVE');
    assert.ok(zeile);
    assert.equal(zeile.amount, -rappen((6000 / 22) * 2));
    assert.equal(t.brutto, rappen(6000 - (6000 / 22) * 2));
  });

  it('Überstunden: Stunden × Ansatz × (1 + Zuschlag), vom Server gerechnet', () => {
    assert.equal(ueberstundenBetrag(5, 30, 25), 187.5);
    assert.equal(ueberstundenBetrag(3.5, 28.4, 0), 99.4);
  });

  it('Zulagen und Korrekturen sind beitragspflichtig, Spesen nicht', () => {
    const t = ermittleLohnteil(
      eingabe({
        positionen: [
          { id: 'a', type: 'ALLOWANCE', label: 'Nachtzulage', quantity: null, rate: null, surchargePct: null, amount: 200 },
          { id: 'b', type: 'CORRECTION', label: 'Korrektur Februar', quantity: null, rate: null, surchargePct: null, amount: -50 },
          { id: 'c', type: 'EXPENSE', label: 'Spesen', quantity: null, rate: null, surchargePct: null, amount: 80 },
          { id: 'd', type: 'FAMILY_ALLOWANCE', label: 'Kinderzulage', quantity: null, rate: null, surchargePct: null, amount: 215 },
        ],
      }),
    );
    assert.equal(t.brutto, 5150, 'Spesen und Familienzulage gehören nicht zum AHV-Lohn');
    assert.equal(t.quellensteuerBemessung, 5365, 'Familienzulage ist steuerbar, Spesen nicht');
    assert.equal(t.zeilen.find((z) => z.type === 'EXPENSE')?.certificateField, '13.1.1');
  });

  it('Ferien- und Feiertagsentschädigung nur beim Stundenlohn', () => {
    const stunden = ermittleLohnteil(
      eingabe({ grundlohn: { art: 'HOURLY', betrag: 3000, stunden: 100 }, ferienImLohn: true, ferientageJeJahr: 25, feiertagsanteilPct: 3.5 }),
    );
    assert.equal(stunden.zeilen.find((z) => z.type === 'VACATION_PAY')?.amount, rappen(3000 * 0.106383));
    assert.equal(stunden.zeilen.find((z) => z.type === 'HOLIDAY_PAY')?.amount, 105);

    const monat = ermittleLohnteil(eingabe({ ferienImLohn: true, feiertagsanteilPct: 3.5 }));
    assert.equal(monat.zeilen.filter((z) => z.type === 'VACATION_PAY' || z.type === 'HOLIDAY_PAY').length, 0);
  });

  it('Stunden an Tagen ohne Monatslohn erscheinen als eigene Grundlohnzeile', () => {
    const t = ermittleLohnteil(
      eingabe({ grundlohn: { art: 'MONTHLY', betrag: 2500, tage: 16, voll: false, monatslohnVoll: 5000, stundenAnteil: { betrag: 900, stunden: 30 } } }),
    );
    assert.equal(t.zeilen.filter((z) => z.type === 'BASE').length, 2);
    assert.equal(t.brutto, 3400);
  });
});

describe('13. Monatslohn — vier vereinbarte Arten', () => {
  const g = (teil: Partial<DreizehnterGrundlage>): DreizehnterGrundlage => ({ ...KEIN_13, ...teil });

  it('NONE: nichts', () => {
    assert.equal(berechneDreizehnten(g({ art: 'NONE' }), 5000, 12).betrag, 0);
  });

  it('MONTHLY: jeden Monat ein Zwölftel des Grundlohns', () => {
    assert.equal(berechneDreizehnten(g({ art: 'MONTHLY' }), 6000, 3).betrag, 500);
  });

  it('PRO_RATA: im Auszahlungsmonat 1/12 der Jahresgrundlöhne abzüglich Ausgerichtetem', () => {
    assert.equal(berechneDreizehnten(g({ art: 'PRO_RATA', grundlohnBisherImJahr: 55_000 }), 5000, 12).betrag, 5000);
    assert.equal(berechneDreizehnten(g({ art: 'PRO_RATA', grundlohnBisherImJahr: 55_000, bereitsAusbezahlt: 1000 }), 5000, 12).betrag, 4000);
    assert.equal(berechneDreizehnten(g({ art: 'PRO_RATA', grundlohnBisherImJahr: 20_000 }), 5000, 6).betrag, 0, 'nicht fällig');
  });

  it('PRO_RATA beim Austritt: der offene Anteil wird im Austrittsmonat fällig', () => {
    const r = berechneDreizehnten(g({ art: 'PRO_RATA', grundlohnBisherImJahr: 20_000, austrittImMonat: true }), 4000, 5);
    assert.equal(r.betrag, 2000);
  });

  it('ANNUAL: ein Monatslohn, bei unterjähriger Anstellung nach Tagen', () => {
    assert.equal(berechneDreizehnten(g({ art: 'ANNUAL', monatslohnVoll: 6000, anstellungstageImJahr: 365 }), 6000, 12).betrag, 6000);
    const eintritt = berechneDreizehnten(g({ art: 'ANNUAL', monatslohnVoll: 6000, anstellungstageImJahr: 184 }), 6000, 12);
    assert.equal(eintritt.betrag, rappen((6000 * 184) / 365));
  });

  it('ANNUAL wird nie doppelt ausgerichtet', () => {
    assert.equal(berechneDreizehnten(g({ art: 'ANNUAL', monatslohnVoll: 6000, anstellungstageImJahr: 365, bereitsAusbezahlt: 6000 }), 6000, 12).betrag, 0);
  });

  it('ANNUAL ohne Monatslohn (Stundenlohn) rechnet wie PRO_RATA', () => {
    const r = berechneDreizehnten(g({ art: 'ANNUAL', monatslohnVoll: null, grundlohnBisherImJahr: 33_000 }), 3000, 12);
    assert.equal(r.betrag, 3000);
  });

  it('unbezahlter Urlaub mindert die Grundlage des monatlichen 13.', () => {
    const t = ermittleLohnteil(
      eingabe({ grundlohn: { art: 'MONTHLY', betrag: 6600, tage: 31, voll: true, monatslohnVoll: 6600 }, unbezahlteTage: 2, dreizehnter: g({ art: 'MONTHLY' }) }),
    );
    const grund = 6600 - rappen((6600 / 22) * 2);
    assert.equal(t.zeilen.find((z) => z.type === 'THIRTEENTH')?.amount, rappen(grund / 12));
  });
});

describe('Abschluss: Abzüge, Quellensteuer, Auszahlung', () => {
  it('Auszahlung = Brutto − Sozialabzüge − Quellensteuer − Abzüge + Spesen', () => {
    const e = eingabe({
      positionen: [
        { id: 's', type: 'EXPENSE', label: 'Spesen', quantity: null, rate: null, surchargePct: null, amount: 120 },
        { id: 'v', type: 'DEDUCTION', label: 'Vorschuss', quantity: null, rate: null, surchargePct: null, amount: 300 },
      ],
    });
    const a = schliesseAbrechnungAb(e, ermittleLohnteil(e), { status: 'SATZ', satzPct: 10, tarif: 'A0N', kanton: 'BE', quelle: 'Prüfreihe', satzId: 'x' });
    assert.equal(a.quellensteuer, 500);
    assert.equal(a.netto, rappen(5000 - a.beitraege.summe - 500 - 300 + 120));
    assert.equal(a.pruefungErforderlich, false);
  });

  it('ohne Tarifzeile keine Quellensteuer, sondern eine Prüfung', () => {
    const e = eingabe();
    const a = schliesseAbrechnungAb(e, ermittleLohnteil(e), { status: 'KEIN_TARIF', tarif: 'B1Y', kanton: 'BE', grund: 'kein Tarif' });
    assert.equal(a.quellensteuer, 0);
    assert.equal(a.pruefungErforderlich, true);
    assert.equal(a.pruefungsgrund, 'kein Tarif');
  });

  it('von Hand erfasste Quellensteuer ersetzt den Tarif', () => {
    const e = eingabe({
      positionen: [{ id: 'q', type: 'WITHHOLDING_TAX_MANUAL', label: 'Quellensteuer März', quantity: null, rate: null, surchargePct: null, amount: 432.1 }],
    });
    const a = schliesseAbrechnungAb(e, ermittleLohnteil(e), { status: 'KEIN_TARIF', tarif: 'A0N', kanton: 'BE', grund: 'kein Tarif' });
    assert.equal(a.quellensteuer, 432.1);
    assert.equal(a.pruefungErforderlich, false);
  });

  it('KTG wird abgezogen, sobald ein Satz besteht', () => {
    const e = eingabe({ saetze: { ...SAETZE_2026, ktg: 0.5 } });
    const a = schliesseAbrechnungAb(e, ermittleLohnteil(e), KEINE_QST);
    assert.equal(a.zeilen.find((z) => z.type === 'KTG')?.amount, 25);
  });

  it('Arbeitgeberbeiträge sind informativ und ändern die Auszahlung nicht', () => {
    const ohne = eingabe();
    const mit = eingabe({ arbeitgeber: { ahvIvEo: 5.3, alv: 1.1, alvUeberGrenze: 0, uvgNbu: 0, uvgBu: 0.5, ktg: 0, fak: 1.2, vk: 3 } });
    const a = schliesseAbrechnungAb(ohne, ermittleLohnteil(ohne), KEINE_QST);
    const b = schliesseAbrechnungAb(mit, ermittleLohnteil(mit), KEINE_QST);
    assert.equal(a.netto, b.netto);
    assert.equal(b.arbeitgeber.ahvIvEo, 265);
    assert.equal(b.arbeitgeber.fak, 60);
    assert.equal(b.arbeitgeber.uvg, 25);
    assert.equal(b.arbeitgeber.vk, rappen((265 + 265) * 0.03));
    assert.ok(b.zeilen.filter((z) => z.kind === 'EMPLOYER').length >= 4);
  });
});
