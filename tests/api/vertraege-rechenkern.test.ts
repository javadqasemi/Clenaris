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
  vertragsperiode,
  zuercherHeute,
  zuercherZeitpunkt,
  type FassungZeitraum,
  type Serienregel,
} from '../../src/lib/contracts/serie';
import { abrechnungsbetrag, type AbrechnungsEingabe } from '../../src/lib/contracts/abrechnungsbetrag';

/**
 * Der Betrag einer Vertragsperiode (B-06, 2026-09-28). Jeder Fall hier ergab
 * mit der früheren Gleitkommarechnung (`Math.round(x * 100) / 100`) einen
 * Rappen zu wenig — die Erwartung ist die kaufmännische Rundung des exakten
 * Werts, nicht das, was der alte Code lieferte.
 */
describe('Vertragsabrechnung — Betrag dezimal', () => {
  const basis: AbrechnungsEingabe = {
    pricingModel: 'FIXED_PERIOD', baseAmount: 0, hourlyRate: 0, unitPrice: 0, vatRate: 0,
    einsaetze: 0, minuten: 0, menge: 0, anteil: 1,
  };

  it('90 Minuten zu CHF 12.35 sind 18.53 (binär 18.52499…)', () => {
    assert.equal(abrechnungsbetrag({ ...basis, pricingModel: 'HOURLY', hourlyRate: 12.35, minuten: 90 }).netto, 18.53);
  });

  it('die halbe Pauschale von CHF 12.35 ist 6.18 (binär 6.17499…)', () => {
    assert.equal(abrechnungsbetrag({ ...basis, baseAmount: 12.35, anteil: 0.5 }).netto, 6.18);
  });

  it('20 Minuten zu CHF 55.00 sind 18.33 — ein Drittel wird nicht zuerst gerundet', () => {
    assert.equal(abrechnungsbetrag({ ...basis, pricingModel: 'HOURLY', hourlyRate: 55, minuten: 20 }).netto, 18.33);
  });

  it('MWST vom gerundeten Netto, Brutto als Summe: 1200 zu 8.1 % → 97.20 / 1297.20', () => {
    assert.deepEqual(abrechnungsbetrag({ ...basis, baseAmount: 1200, vatRate: 8.1 }), { netto: 1200, mwst: 97.2, brutto: 1297.2 });
  });

  it('Einsatzpauschale und Mengenpreis', () => {
    assert.equal(abrechnungsbetrag({ ...basis, pricingModel: 'FIXED_PER_VISIT', baseAmount: 0.1, einsaetze: 3 }).netto, 0.3);
    assert.equal(abrechnungsbetrag({ ...basis, pricingModel: 'UNIT_BASED', unitPrice: 1.005, menge: 10, anteil: 1 }).netto, 10.05);
  });
});

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

  // -------------------------------------------------------------------------
  //  Kantenfälle des Kalenders
  // -------------------------------------------------------------------------

  describe('Kalender-Kantenfälle', () => {
    it('„alle drei Wochen" zählt in Dreierschritten ab dem ersten Serientermin', () => {
      const regel = woechentlich({ frequency: 'WEEKLY', interval: 3, weekdays: [2] });
      // Beginn Do 2026-10-01 → erster Dienstag 06.10., dann 27.10., 17.11.
      assert.deepEqual(
        serientage(regel, tag('2026-10-01'), tag('2026-11-30')).map(tagSchluessel),
        ['2026-10-06', '2026-10-27', '2026-11-17'],
      );
    });

    it('Vertragsbeginn zwischen zwei Serientagen lässt den ersten nicht ausfallen', () => {
      /**
       * Der Fehler, den die erste Fassung hatte: Der Rhythmus zählte ab der
       * Woche von `effectiveFrom`. Beginnt der Vertrag an einem Donnerstag und
       * wird montags gereinigt, liegt der erste Montag in der Folgewoche — und
       * bei zweiwöchentlichem Takt fiel er aus. Der erste Termin eines
       * Vertrags entfiel, und beim Testen sieht das niemand.
       */
      for (const beginn of ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']) {
        const regel = woechentlich({ frequency: 'BIWEEKLY', weekdays: [1], effectiveFrom: tag(beginn) });
        const ergebnis = serientage(regel, tag(beginn), tag('2026-10-31'));
        assert.equal(ergebnis[0] ? tagSchluessel(ergebnis[0]) : null, '2026-10-05', `Beginn ${beginn}`);
      }
    });

    it('Vertrag endet vor dem nächsten Termin: keine Serientage', () => {
      const regel = woechentlich({ weekdays: [1], effectiveFrom: tag('2026-10-06'), effectiveUntil: tag('2026-10-10') });
      // Erster Montag nach dem 6.10. wäre der 12.10. — nach dem Ende.
      assert.deepEqual(serientage(regel, tag('2026-10-01'), tag('2026-12-31')), []);
    });

    it('Monatsletzter im Februar — auch im Schaltjahr', () => {
      const regel = woechentlich({
        frequency: 'MONTHLY',
        weekdays: [],
        monthDay: 31,
        effectiveFrom: tag('2028-01-31'),
      });
      // 2028 ist ein Schaltjahr: der 29. Februar existiert.
      assert.deepEqual(
        serientage(regel, tag('2028-01-01'), tag('2028-04-01')).map(tagSchluessel),
        ['2028-01-31', '2028-02-29', '2028-03-31'],
      );

      const keinSchaltjahr = woechentlich({
        frequency: 'MONTHLY',
        weekdays: [],
        monthDay: 30,
        effectiveFrom: tag('2027-01-30'),
      });
      assert.deepEqual(
        serientage(keinSchaltjahr, tag('2027-01-01'), tag('2027-04-01')).map(tagSchluessel),
        ['2027-01-30', '2027-02-28', '2027-03-30'],
      );
    });

    it('halbjährlich und jährlich treffen denselben Kalendertag', () => {
      const halb = woechentlich({ frequency: 'SEMIANNUAL', weekdays: [], monthDay: 15, effectiveFrom: tag('2026-03-15') });
      assert.deepEqual(
        serientage(halb, tag('2026-01-01'), tag('2027-12-31')).map(tagSchluessel),
        ['2026-03-15', '2026-09-15', '2027-03-15', '2027-09-15'],
      );

      const jaehrlich = woechentlich({ frequency: 'ANNUAL', weekdays: [], monthDay: 29, effectiveFrom: tag('2028-02-29') });
      // 2029 hat keinen 29. Februar — der Termin fällt auf den Monatsletzten
      // und wandert danach **nicht** weiter.
      assert.deepEqual(
        serientage(jaehrlich, tag('2028-01-01'), tag('2030-12-31')).map(tagSchluessel),
        ['2028-02-29', '2029-02-28', '2030-02-28'],
      );
    });

    it('ein Feiertag am Jahreswechsel verschiebt über die Jahresgrenze', () => {
      // 1. Januar 2027 ist ein Freitag und Feiertag → Termin geht auf Montag.
      const ergebnis = termine(
        woechentlich({ weekdays: [5], holidayHandling: 'MOVE_AFTER', effectiveFrom: tag('2026-12-01') }),
        tag('2026-12-28'),
        tag('2027-01-03'),
        new Set(['2027-01-01']),
      );
      assert.deepEqual(tage(ergebnis), ['2027-01-04']);
      assert.equal(tagSchluessel(ergebnis[0]!.serientag), '2027-01-01');
    });
  });

  // -------------------------------------------------------------------------
  //  Zeitzone
  // -------------------------------------------------------------------------

  /**
   * Kalendertag und Zeitpunkt sind zwei verschiedene Dinge, und der Planer
   * muss sie sauber trennen: Gespeichert wird UTC, gemeint ist Ortszeit.
   * „Ab 06:00" heisst sechs Uhr in Bern — im Sommer wie im Winter.
   */
  describe('Ortszeit und Umstellung', () => {
    const ortszeit = (zeitpunkt: Date) =>
      new Intl.DateTimeFormat('de-CH', {
        timeZone: 'Europe/Zurich',
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
      }).format(zeitpunkt);

    it('06:00 bleibt 06:00 — im Winter wie im Sommer', () => {
      assert.equal(ortszeit(zuercherZeitpunkt(tag('2027-01-15'), 6 * 60)), '06:00');
      assert.equal(ortszeit(zuercherZeitpunkt(tag('2027-07-15'), 6 * 60)), '06:00');
    });

    it('die UTC-Zeitpunkte unterscheiden sich dabei um eine Stunde', () => {
      const winter = zuercherZeitpunkt(tag('2027-01-15'), 6 * 60);
      const sommer = zuercherZeitpunkt(tag('2027-07-15'), 6 * 60);
      assert.equal(winter.getUTCHours(), 5, 'MEZ = UTC+1');
      assert.equal(sommer.getUTCHours(), 4, 'MESZ = UTC+2');
    });

    it('Umstellung im Frühjahr: der Tag hat 23 Stunden, 06:00 bleibt 06:00', () => {
      // 2027-03-28 ist der Umstellungssonntag (02:00 → 03:00).
      assert.equal(ortszeit(zuercherZeitpunkt(tag('2027-03-28'), 6 * 60)), '06:00');
      assert.equal(ortszeit(zuercherZeitpunkt(tag('2027-03-29'), 6 * 60)), '06:00');
    });

    it('Umstellung im Herbst: der Tag hat 25 Stunden, 06:00 bleibt 06:00', () => {
      // 2027-10-31 ist der Rückstellungssonntag (03:00 → 02:00).
      assert.equal(ortszeit(zuercherZeitpunkt(tag('2027-10-31'), 6 * 60)), '06:00');
      assert.equal(ortszeit(zuercherZeitpunkt(tag('2027-11-01'), 6 * 60)), '06:00');
    });

    it('auch ein früher Beginn überlebt die Umstellung', () => {
      // 01:00 liegt vor der Lücke und bleibt 01:00.
      assert.equal(ortszeit(zuercherZeitpunkt(tag('2027-03-28'), 60)), '01:00');
      // 04:00 liegt danach.
      assert.equal(ortszeit(zuercherZeitpunkt(tag('2027-03-28'), 4 * 60)), '04:00');
    });

    it('der Kalendertag bleibt derselbe — kein Abrutschen in den Vortag', () => {
      const zeitpunkt = zuercherZeitpunkt(tag('2027-07-15'), 0);
      const datum = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich' }).format(zeitpunkt);
      assert.equal(datum, '2027-07-15');
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

  /**
   * RB-008 — die Periode trägt die Fassung, die an ihrem Stichtag galt.
   *
   * Bis 2026-09-23 rechnete jede Periode mit der aktuellen Fassung, und ein
   * Zykluswechsel liess Perioden überlappen. Der reine Kern bestimmt jetzt
   * Fassung, Grenzen und Zeitanteil; die Datenbank verhindert zusätzlich jede
   * Überlappung.
   */
  describe('Vertragsperiode — Fassung und Grenzen', () => {
    const v1: FassungZeitraum = {
      id: 'v1',
      versionNumber: 1,
      billingCycle: 'MONTHLY',
      effectiveFrom: tag('2026-01-01'),
      effectiveUntil: tag('2026-03-15'),
    };
    const v2: FassungZeitraum = {
      id: 'v2',
      versionNumber: 2,
      billingCycle: 'QUARTERLY',
      effectiveFrom: tag('2026-03-15'),
      effectiveUntil: null,
    };
    const periode = (stichtag: string) =>
      vertragsperiode({
        fassungen: [v1, v2],
        stichtag: tag(stichtag),
        vertragsBeginn: tag('2026-01-01'),
        vertragsEndeExklusiv: null,
      });

    it('Januar unter V1 bleibt Januar unter V1 — auch wenn heute V2 gilt', () => {
      const januar = periode('2026-01-20')!;
      assert.equal(januar.fassung.id, 'v1');
      assert.equal(tagSchluessel(januar.start), '2026-01-01');
      assert.equal(tagSchluessel(januar.endeExklusiv), '2026-02-01');
      assert.equal(januar.anteil, 1);
      assert.equal(januar.gekuerzt, false);
    });

    it('der Wechselmonat wird an der Fassungsgrenze geschnitten — beide Seiten', () => {
      const vorher = periode('2026-03-10')!;
      assert.equal(vorher.fassung.id, 'v1');
      assert.equal(tagSchluessel(vorher.start), '2026-03-01');
      assert.equal(tagSchluessel(vorher.endeExklusiv), '2026-03-15');
      assert.equal(vorher.gekuerzt, true);
      assert.equal(vorher.anteil, 14 / 31);

      const nachher = periode('2026-03-20')!;
      assert.equal(nachher.fassung.id, 'v2');
      assert.equal(tagSchluessel(nachher.start), '2026-03-15', 'Das Quartal unter V2 beginnt am Stichtag');
      assert.equal(tagSchluessel(nachher.endeExklusiv), '2026-04-01');
      assert.equal(nachher.anteil, 17 / 90);
    });

    it('die Zeiträume beider Seiten überlappen nicht und lassen keine Lücke', () => {
      const vorher = periode('2026-03-10')!;
      const nachher = periode('2026-03-20')!;
      assert.equal(vorher.endeExklusiv.getTime(), nachher.start.getTime());
    });

    it('nach dem Wechsel: volle Quartale unter V2', () => {
      const q2 = periode('2026-05-05')!;
      assert.equal(q2.fassung.id, 'v2');
      assert.equal(tagSchluessel(q2.start), '2026-04-01');
      assert.equal(tagSchluessel(q2.endeExklusiv), '2026-07-01');
      assert.equal(q2.anteil, 1);
    });

    it('vor dem Vertragsbeginn und nach dem Ende gibt es keine Periode', () => {
      assert.equal(periode('2025-12-31'), null);
      const mitEnde = vertragsperiode({
        fassungen: [v1],
        stichtag: tag('2026-02-20'),
        vertragsBeginn: tag('2026-01-01'),
        vertragsEndeExklusiv: tag('2026-02-15'),
      });
      assert.equal(mitEnde, null, 'Nach dem letzten Leistungstag nichts');
      const letzte = vertragsperiode({
        fassungen: [v1],
        stichtag: tag('2026-02-10'),
        vertragsBeginn: tag('2026-01-01'),
        vertragsEndeExklusiv: tag('2026-02-15'),
      })!;
      assert.equal(tagSchluessel(letzte.endeExklusiv), '2026-02-15', 'Die letzte Periode endet mit dem Vertrag');
      assert.equal(letzte.anteil, 14 / 28);
    });

    it('in einem Schaltjahr hat der Februar 29 Tage', () => {
      const februar = vertragsperiode({
        fassungen: [{ ...v1, effectiveFrom: tag('2028-01-01'), effectiveUntil: tag('2028-02-15') }],
        stichtag: tag('2028-02-01'),
        vertragsBeginn: tag('2028-01-01'),
        vertragsEndeExklusiv: null,
      })!;
      assert.equal(februar.anteil, 14 / 29);
    });
  });

  describe('Heute in Zürich', () => {
    it('kurz nach Mitternacht Ortszeit ist in UTC noch gestern — Zürich zählt', () => {
      // 2026-07-15 00:30 Zürich (Sommerzeit) = 2026-07-14 22:30 UTC
      assert.equal(tagSchluessel(zuercherHeute(new Date('2026-07-14T22:30:00Z'))), '2026-07-15');
      // 2026-01-15 00:30 Zürich (Winterzeit) = 2026-01-14 23:30 UTC
      assert.equal(tagSchluessel(zuercherHeute(new Date('2026-01-14T23:30:00Z'))), '2026-01-15');
      // Mittag: kein Unterschied
      assert.equal(tagSchluessel(zuercherHeute(new Date('2026-01-15T12:00:00Z'))), '2026-01-15');
    });

    it('über die Umstellungsnächte hinweg', () => {
      // 29.03.2026: 02:00 → 03:00. 00:30 UTC = 01:30 MEZ, noch der 29.
      assert.equal(tagSchluessel(zuercherHeute(new Date('2026-03-29T00:30:00Z'))), '2026-03-29');
      // 25.10.2026: 03:00 → 02:00. 22:30 UTC am 24. = 00:30 MESZ am 25.
      assert.equal(tagSchluessel(zuercherHeute(new Date('2026-10-24T22:30:00Z'))), '2026-10-25');
    });
  });
});
