import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  alsTag,
  kuendigungsfrist,
  kuendigungswirkung,
  plusMonate,
  plusTage,
  serientage,
  tagSchluessel,
  termine,
  type Serienregel,
} from '../../src/lib/contracts/serie';

/**
 * Der Serien-Rechenkern der Verträge, mit festen Daten.
 *
 * Wie bei den Rechenkernen der Unternehmensführung wird hier Anwendungscode
 * direkt importiert — und aus demselben Grund: Welche Kalendertage eine Serie
 * trifft, ist eine reine Rechnung, und über HTTP liesse sie sich nur mit einem
 * Datenbestand prüfen, der die Rechnung verdeckt.
 *
 * Es ist zugleich die Stelle, an der ein Fehler am teuersten ist: Ein Termin
 * zu viel heisst ein Team vor einer verschlossenen Tür, ein Termin zu wenig
 * heisst eine nicht erbrachte Leistung, die niemand bemerkt, bis die Kundschaft
 * anruft.
 */

const tag = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const tage = (liste: { datum: Date }[]) => liste.map((t) => tagSchluessel(t.datum));

const woechentlich = (ueber: Partial<Serienregel> = {}): Serienregel => ({
  frequency: 'WEEKLY',
  interval: 1,
  weekdays: [1, 3, 5], // Mo, Mi, Fr
  monthDay: null,
  effectiveFrom: tag('2026-10-01'),
  effectiveUntil: null,
  holidayHandling: 'SKIP',
  ...ueber,
});

describe('Serien-Rechenkern der Verträge', () => {
  describe('Wochenrhythmus', () => {
    it('trifft genau die gewählten Wochentage', () => {
      // 2026-10-01 ist ein Donnerstag.
      const ergebnis = serientage(woechentlich(), tag('2026-10-01'), tag('2026-10-14'));
      assert.deepEqual(ergebnis.map(tagSchluessel), [
        '2026-10-02', // Fr
        '2026-10-05', // Mo
        '2026-10-07', // Mi
        '2026-10-09', // Fr
        '2026-10-12', // Mo
        '2026-10-14', // Mi
      ]);
    });

    it('zählt „alle zwei Wochen" ab der Woche des Serienbeginns, nicht ab dem Fenster', () => {
      const regel = woechentlich({ frequency: 'BIWEEKLY', weekdays: [1] });

      // Vom Beginn aus: 5.10., 19.10., 2.11.
      const vomBeginn = serientage(regel, tag('2026-10-01'), tag('2026-11-09'));
      assert.deepEqual(vomBeginn.map(tagSchluessel), ['2026-10-05', '2026-10-19', '2026-11-02']);

      // Dasselbe Ergebnis, wenn das Fenster erst später beginnt. Ohne feste
      // Basis verschöbe sich der Rhythmus bei jedem Nachplanen um eine Woche.
      const spaeteresFenster = serientage(regel, tag('2026-10-15'), tag('2026-11-09'));
      assert.deepEqual(spaeteresFenster.map(tagSchluessel), ['2026-10-19', '2026-11-02']);
    });

    it('ohne Wochentag entsteht keine Serie — und zwar leer, nicht zufällig', () => {
      assert.deepEqual(serientage(woechentlich({ weekdays: [] }), tag('2026-10-01'), tag('2026-12-31')), []);
    });

    it('endet mit `effectiveUntil`', () => {
      const regel = woechentlich({ weekdays: [1], effectiveUntil: tag('2026-10-12') });
      assert.deepEqual(
        serientage(regel, tag('2026-10-01'), tag('2026-11-30')).map(tagSchluessel),
        ['2026-10-05', '2026-10-12'],
      );
    });
  });

  describe('Monatsrhythmus', () => {
    it('hält den Monatstag und läuft nicht in den Folgemonat über', () => {
      const regel = woechentlich({
        frequency: 'MONTHLY',
        weekdays: [],
        monthDay: 31,
        effectiveFrom: tag('2026-01-31'),
      });
      const ergebnis = serientage(regel, tag('2026-01-01'), tag('2026-05-01'));
      // Der Februar hat keinen 31. — der Termin fällt auf den Monatsletzten
      // und wandert danach **nicht** weiter.
      assert.deepEqual(ergebnis.map(tagSchluessel), [
        '2026-01-31',
        '2026-02-28',
        '2026-03-31',
        '2026-04-30',
      ]);
    });

    it('vierteljährlich zählt in Dreierschritten', () => {
      const regel = woechentlich({
        frequency: 'QUARTERLY',
        weekdays: [],
        monthDay: 15,
        effectiveFrom: tag('2026-01-15'),
      });
      assert.deepEqual(
        serientage(regel, tag('2026-01-01'), tag('2026-12-31')).map(tagSchluessel),
        ['2026-01-15', '2026-04-15', '2026-07-15', '2026-10-15'],
      );
    });
  });

  describe('Feiertage', () => {
    const feiertag = new Set(['2026-10-05']); // ein Montag

    it('IGNORE lässt den Termin stehen', () => {
      const ergebnis = termine(
        woechentlich({ weekdays: [1], holidayHandling: 'IGNORE' }),
        tag('2026-10-01'),
        tag('2026-10-07'),
        feiertag,
      );
      assert.deepEqual(tage(ergebnis), ['2026-10-05']);
    });

    it('SKIP lässt ihn ersatzlos entfallen', () => {
      const ergebnis = termine(
        woechentlich({ weekdays: [1], holidayHandling: 'SKIP' }),
        tag('2026-10-01'),
        tag('2026-10-07'),
        feiertag,
      );
      assert.deepEqual(tage(ergebnis), []);
    });

    it('MOVE_BEFORE zieht auf den letzten Werktag davor vor — und behält den Serientag', () => {
      const ergebnis = termine(
        woechentlich({ weekdays: [1], holidayHandling: 'MOVE_BEFORE' }),
        tag('2026-10-01'),
        tag('2026-10-07'),
        feiertag,
      );
      assert.deepEqual(tage(ergebnis), ['2026-10-02']); // Freitag davor
      /**
       * Der Serientag bleibt der Montag. Das ist die Kennung der Idempotenz:
       * Wird der Feiertag später nachgetragen oder entfernt, erkennt der
       * Planer den Einsatz wieder, statt einen zweiten anzulegen.
       */
      assert.equal(tagSchluessel(ergebnis[0]!.serientag), '2026-10-05');
      assert.equal(ergebnis[0]!.grund, 'FEIERTAG_VOR');
    });

    it('MOVE_AFTER verschiebt auf den nächsten Werktag und überspringt das Wochenende', () => {
      // Freitag 2026-10-02 ist Feiertag → nächster Werktag ist Montag 05.10.
      const ergebnis = termine(
        woechentlich({ weekdays: [5], holidayHandling: 'MOVE_AFTER' }),
        tag('2026-10-01'),
        tag('2026-10-03'),
        new Set(['2026-10-02']),
      );
      assert.deepEqual(tage(ergebnis), ['2026-10-05']);
      assert.equal(tagSchluessel(ergebnis[0]!.serientag), '2026-10-02');
    });
  });

  describe('Ausnahmen', () => {
    it('SKIP entfernt genau einen Termin', () => {
      const ergebnis = termine(
        woechentlich({ weekdays: [1] }),
        tag('2026-10-01'),
        tag('2026-10-20'),
        new Set(),
        [{ kind: 'SKIP', originalDate: tag('2026-10-12'), newDate: null }],
      );
      assert.deepEqual(tage(ergebnis), ['2026-10-05', '2026-10-19']);
    });

    it('MOVE verschiebt und behält den Serientag', () => {
      const ergebnis = termine(
        woechentlich({ weekdays: [1] }),
        tag('2026-10-01'),
        tag('2026-10-09'),
        new Set(),
        [{ kind: 'MOVE', originalDate: tag('2026-10-05'), newDate: tag('2026-10-08') }],
      );
      assert.deepEqual(tage(ergebnis), ['2026-10-08']);
      assert.equal(tagSchluessel(ergebnis[0]!.serientag), '2026-10-05');
    });

    it('geht der Feiertagsregel vor — sonst würde zweimal verschoben', () => {
      const ergebnis = termine(
        woechentlich({ weekdays: [1], holidayHandling: 'MOVE_AFTER' }),
        tag('2026-10-01'),
        tag('2026-10-09'),
        new Set(['2026-10-05']),
        [{ kind: 'MOVE', originalDate: tag('2026-10-05'), newDate: tag('2026-10-07') }],
      );
      assert.deepEqual(tage(ergebnis), ['2026-10-07']);
    });

    it('EXTRA setzt einen zusätzlichen Termin an', () => {
      const ergebnis = termine(
        woechentlich({ weekdays: [1] }),
        tag('2026-10-01'),
        tag('2026-10-09'),
        new Set(),
        [{ kind: 'EXTRA', originalDate: tag('2026-10-08'), newDate: null }],
      );
      assert.deepEqual(tage(ergebnis), ['2026-10-05', '2026-10-08']);
    });
  });

  describe('Fristen', () => {
    it('die Kündigungsfrist liegt n Tage vor dem Vertragsende', () => {
      assert.equal(
        tagSchluessel(kuendigungsfrist(tag('2027-03-31'), 90)!),
        '2026-12-31',
      );
    });

    it('ohne Vertragsende gibt es keine Frist', () => {
      assert.equal(kuendigungsfrist(null, 90), null);
    });

    it('ohne Vertragsende wirkt eine Kündigung nach Ablauf der Frist', () => {
      const wirkung = kuendigungswirkung({
        gekuendigtAm: tag('2026-10-01'),
        noticePeriodDays: 90,
        vertragsende: null,
        renewalType: 'NONE',
        renewalPeriodMonths: null,
      });
      assert.equal(tagSchluessel(wirkung), '2026-12-30');
    });

    it('bei befristetem Vertrag ohne Verlängerung zum vereinbarten Ende', () => {
      const wirkung = kuendigungswirkung({
        gekuendigtAm: tag('2026-10-01'),
        noticePeriodDays: 90,
        vertragsende: tag('2027-06-30'),
        renewalType: 'NONE',
        renewalPeriodMonths: null,
      });
      assert.equal(tagSchluessel(wirkung), '2027-06-30');
    });

    it('bei automatischer Verlängerung zum nächsten Laufzeitende nach Ablauf der Frist', () => {
      /**
       * Gekündigt am 1. Oktober, Frist 90 Tage → frühestens 30. Dezember. Das
       * Laufzeitende ist der 31. März 2027, also **nach** dem frühesten
       * Termin: Der Vertrag endet dort und nicht mitten in der Periode. Genau
       * deshalb steht dort eine Fallunterscheidung und keine Addition.
       */
      const wirkung = kuendigungswirkung({
        gekuendigtAm: tag('2026-10-01'),
        noticePeriodDays: 90,
        vertragsende: tag('2027-03-31'),
        renewalType: 'AUTOMATIC',
        renewalPeriodMonths: 12,
      });
      assert.equal(tagSchluessel(wirkung), '2027-03-31');
    });

    it('zu spät gekündigt: der Vertrag läuft eine Verlängerungsperiode weiter', () => {
      const wirkung = kuendigungswirkung({
        gekuendigtAm: tag('2027-02-01'),
        noticePeriodDays: 90,
        vertragsende: tag('2027-03-31'),
        renewalType: 'AUTOMATIC',
        renewalPeriodMonths: 12,
      });
      // Frühestens 2.5.2027 — das ist nach dem 31.3., also gilt das nächste
      // Laufzeitende.
      assert.equal(tagSchluessel(wirkung), '2028-03-31');
    });
  });

  describe('Datumshilfen', () => {
    it('plusMonate läuft nicht in den Folgemonat über', () => {
      assert.equal(tagSchluessel(plusMonate(tag('2026-01-31'), 1)), '2026-02-28');
      assert.equal(tagSchluessel(plusMonate(tag('2026-01-31'), 3)), '2026-04-30');
    });

    it('alsTag schneidet die Uhrzeit ab', () => {
      assert.equal(tagSchluessel(alsTag(new Date('2026-10-05T22:30:00.000Z'))), '2026-10-05');
    });

    it('plusTage rechnet über Monatsgrenzen', () => {
      assert.equal(tagSchluessel(plusTage(tag('2026-10-30'), 5)), '2026-11-04');
    });
  });
});
