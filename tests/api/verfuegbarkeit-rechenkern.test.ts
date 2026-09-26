import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  berechneSlots,
  einsatzfenster,
  naechsterTag,
  pruefeZeitraum,
  wochentag,
  zurichDatum,
  zurichZuUtc,
  type Anfrage,
  type Tagesdaten,
} from '../../src/lib/scheduling/verfuegbarkeit';

/**
 * Rechenkern der Terminverfügbarkeit mit festen Zahlen (Produktsprint
 * 2026-09-26).
 *
 * Wie die Rechenkerne der Unternehmensführung direkt importiert: Welche
 * Anfangszeiten in ein Fenster von 18:00 bis 22:00 passen, lässt sich über
 * HTTP nur mit einem Datenbestand prüfen, der die Rechnung verdeckt. Die
 * HTTP-Seite derselben Fälle — Einsatzzeiten, Arbeitszeiten, Abschluss,
 * gleichzeitige Buchungen — steht in `mehrere-leistungen.test.ts`.
 *
 * Der Kerntag ist ein Montag im Sommer (2026-06-15, UTC+2); die
 * Zeitumstellungsfälle nehmen die beiden Umstellungssonntage 2026.
 */

const TAG = '2026-06-15';
const ABEND = { von: '18:00', bis: '22:00' };

function tag(teil: Partial<Tagesdaten> = {}): Tagesdaten {
  return {
    datum: TAG,
    fenster: ABEND,
    personen: [
      { id: 'a', fenster: [{ von: '18:00', bis: '22:00' }], abwesend: false },
      { id: 'b', fenster: [{ von: '18:00', bis: '22:00' }], abwesend: false },
    ],
    arbeitszeitenGepflegt: true,
    belegungen: [],
    ...teil,
  };
}

function anfrage(dauerMin: number, teil: Partial<Anfrage> = {}): Anfrage {
  return {
    dauerMin,
    crew: 1,
    pufferMin: 0,
    // Weit genug vor allen Prüftagen, auch vor dem Umstellungssonntag im März.
    fruehestens: new Date('2026-01-01T00:00:00Z'),
    spaetestens: new Date('2026-12-31T00:00:00Z'),
    ...teil,
  };
}

const labels = (t: Tagesdaten, a: Anfrage) =>
  berechneSlots(t, a)
    .slots.filter((s) => s.available)
    .map((s) => s.label);

describe('Verfügbarkeit — Rechenkern', () => {
  describe('Einsatzfenster 18:00–22:00', () => {
    it('1 Stunde: 18:00 bis 21:00 im Halbstundenraster', () => {
      assert.deepEqual(labels(tag(), anfrage(60)), ['18:00', '18:30', '19:00', '19:30', '20:00', '20:30', '21:00']);
    });

    it('3 Stunden (Büro 2 h + Fenster 1 h): nur 18:00, 18:30, 19:00 — 20:00 nicht', () => {
      const frei = labels(tag(), anfrage(180));
      assert.deepEqual(frei, ['18:00', '18:30', '19:00']);
      assert.ok(!frei.includes('20:00'), '20:00 + 3 h = 23:00 liegt ausserhalb');
    });

    it('4 Stunden: genau 18:00', () => {
      assert.deepEqual(labels(tag(), anfrage(240)), ['18:00']);
    });

    it('länger als 4 Stunden: kein Zeitfenster, der Tag ist nicht verfügbar', () => {
      const ergebnis = berechneSlots(tag(), anfrage(270));
      assert.equal(ergebnis.slots.length, 0);
      assert.equal(ergebnis.available, false);
      assert.match(ergebnis.reason ?? '', /länger als unsere Einsatzzeit/);
    });

    it('der Abschluss prüft die Schliesszeit — 20:00 für 3 Stunden wird abgelehnt', () => {
      // Genau der Fall, den `isSlotBookable` vor dem Sprint durchliess.
      const start = zurichZuUtc(TAG, '20:00');
      assert.equal(pruefeZeitraum(tag(), start, anfrage(180)).ablehnung, 'AUSSERHALB_FENSTER');
      assert.equal(pruefeZeitraum(tag(), zurichZuUtc(TAG, '17:30'), anfrage(60)).ablehnung, 'AUSSERHALB_FENSTER');
      assert.equal(pruefeZeitraum(tag(), zurichZuUtc(TAG, '19:00'), anfrage(180)).ablehnung, null);
    });
  });

  describe('Wochentage und Einsatzzeiten', () => {
    const woche = [
      { weekday: 1, opensAt: '08:00', closesAt: '17:00', closed: false, serviceOpensAt: '18:00', serviceClosesAt: '22:00', serviceClosed: false },
      { weekday: 3, opensAt: '08:00', closesAt: '17:00', closed: false, serviceOpensAt: null, serviceClosesAt: null, serviceClosed: true },
      { weekday: 4, opensAt: '08:00', closesAt: '17:00', closed: false, serviceOpensAt: '17:00', serviceClosesAt: '21:00', serviceClosed: false },
      { weekday: 5, opensAt: '08:00', closesAt: '17:00', closed: false, serviceOpensAt: null, serviceClosesAt: null, serviceClosed: false },
      { weekday: 6, opensAt: null, closesAt: null, closed: true, serviceOpensAt: '09:00', serviceClosesAt: '12:00', serviceClosed: false },
    ];
    const fuer = (wt: number) => einsatzfenster(woche.find((z) => z.weekday === wt) ?? null);

    it('eigene Einsatzzeiten gehen den Öffnungszeiten vor', () => {
      assert.deepEqual(fuer(1), { von: '18:00', bis: '22:00' });
      assert.deepEqual(fuer(4), { von: '17:00', bis: '21:00' });
    });

    it('ohne eigene Einsatzzeiten gelten die Öffnungszeiten', () => {
      assert.deepEqual(fuer(5), { von: '08:00', bis: '17:00' });
    });

    it('„keine Einsätze" sperrt auch bei offenem Büro, und ein nicht erfasster Tag ist zu', () => {
      assert.equal(fuer(3), null);
      assert.equal(fuer(2), null, 'kein Rückfall auf 09:00–17:00');
    });

    it('Einsätze an einem Tag mit geschlossenem Büro', () => {
      assert.deepEqual(fuer(6), { von: '09:00', bis: '12:00' });
    });

    it('der Donnerstag erzeugt seine eigenen Anfangszeiten, der Mittwoch keine', () => {
      const donnerstag = '2026-06-18';
      assert.equal(wochentag(donnerstag), 4);
      const t = tag({ datum: donnerstag, fenster: fuer(4), personen: [{ id: 'a', fenster: [{ von: '17:00', bis: '21:00' }], abwesend: false }] });
      assert.deepEqual(labels(t, anfrage(180)), ['17:00', '17:30', '18:00']);
      const mittwoch = berechneSlots(tag({ datum: '2026-06-17', fenster: fuer(3) }), anfrage(60));
      assert.equal(mittwoch.closed, true);
      assert.equal(mittwoch.available, false);
    });
  });

  describe('Kapazität', () => {
    it('ein bestehender Einsatz bindet eine Person — mit zwei Personen bleibt der Termin frei, mit dreien belegt nicht', () => {
      const belegt = [{ start: zurichZuUtc(TAG, '18:00'), ende: zurichZuUtc(TAG, '20:00'), crew: 1, pufferMin: 0 }];
      assert.deepEqual(labels(tag({ belegungen: belegt }), anfrage(60)), ['18:00', '18:30', '19:00', '19:30', '20:00', '20:30', '21:00']);
      const zwei = [...belegt, { start: zurichZuUtc(TAG, '19:00'), ende: zurichZuUtc(TAG, '21:00'), crew: 1, pufferMin: 0 }];
      // Zwischen 19:00 und 20:00 sind beide gebunden — jede Stunde, die
      // diesen Abschnitt berührt, fällt weg; 18:00–19:00 und ab 20:00 bleibt
      // je eine Person frei.
      assert.deepEqual(labels(tag({ belegungen: zwei }), anfrage(60)), ['18:00', '20:00', '20:30', '21:00']);
    });

    it('der „Puffer zwischen Einsätzen" hält das Team über das Ende hinaus fest', () => {
      const eine = tag({ personen: [{ id: 'a', fenster: [{ von: '18:00', bis: '22:00' }], abwesend: false }] });
      const belegt = [{ start: zurichZuUtc(TAG, '18:00'), ende: zurichZuUtc(TAG, '19:00'), crew: 1, pufferMin: 30 }];
      assert.deepEqual(labels({ ...eine, belegungen: belegt }, anfrage(60)), ['19:30', '20:00', '20:30', '21:00']);
      // Der eigene Puffer zählt ebenso: 60 min Einsatz + 30 min Puffer ab 19:00
      // reicht bis 20:30 und stösst an den Einsatz um 20:00.
      const spaeter = [{ start: zurichZuUtc(TAG, '20:00'), ende: zurichZuUtc(TAG, '21:00'), crew: 1, pufferMin: 0 }];
      assert.deepEqual(labels({ ...eine, belegungen: spaeter }, anfrage(60, { pufferMin: 30 })), ['18:00', '18:30', '21:00']);
    });

    it('bewilligte Abwesenheit nimmt die Person aus der Rechnung', () => {
      const t = tag({
        personen: [
          { id: 'a', fenster: [{ von: '18:00', bis: '22:00' }], abwesend: true },
          { id: 'b', fenster: [{ von: '18:00', bis: '22:00' }], abwesend: false },
        ],
      });
      assert.deepEqual(labels(t, anfrage(60, { crew: 2 })), []);
      assert.equal(labels(t, anfrage(60, { crew: 1 })).length, 7);
    });

    it('Arbeitszeiten zählen, sobald sie gepflegt sind — wer bis 17 Uhr arbeitet, putzt nicht um 18 Uhr', () => {
      const t = tag({
        fenster: { von: '07:00', bis: '22:00' },
        personen: [{ id: 'a', fenster: [{ von: '07:00', bis: '17:00' }], abwesend: false }],
      });
      const frei = labels(t, anfrage(60));
      assert.ok(frei.includes('16:00'));
      assert.ok(!frei.includes('16:30'), '16:30 + 1 h endet nach der Arbeitszeit');
      assert.ok(!frei.includes('18:00'));
    });

    it('ohne gepflegte Arbeitszeiten zählt jede anwesende Person im ganzen Fenster', () => {
      const t = tag({ arbeitszeitenGepflegt: false, personen: [{ id: 'a', fenster: null, abwesend: false }] });
      assert.equal(labels(t, anfrage(60)).length, 7);
    });
  });

  describe('Vorlauf und Horizont', () => {
    it('vor dem frühesten Zeitpunkt ist nichts buchbar, danach schon', () => {
      const a = anfrage(60, { fruehestens: zurichZuUtc(TAG, '19:15') });
      assert.deepEqual(labels(tag(), a), ['19:30', '20:00', '20:30', '21:00']);
      assert.equal(pruefeZeitraum(tag(), zurichZuUtc(TAG, '18:00'), a).ablehnung, 'ZU_KURZFRISTIG');
    });

    it('jenseits des Buchungshorizonts ebenfalls nicht', () => {
      const a = anfrage(60, { spaetestens: zurichZuUtc(TAG, '12:00') });
      assert.equal(berechneSlots(tag(), a).available, false);
      assert.equal(pruefeZeitraum(tag(), zurichZuUtc(TAG, '18:00'), a).ablehnung, 'ZU_WEIT_VORAUS');
    });
  });

  describe('Zeitzone Europe/Zurich', () => {
    it('Sommerzeit: 18:00 in Zürich ist 16:00 UTC', () => {
      assert.equal(zurichZuUtc('2026-06-15', '18:00').toISOString(), '2026-06-15T16:00:00.000Z');
    });

    it('Winterzeit: 18:00 in Zürich ist 17:00 UTC', () => {
      assert.equal(zurichZuUtc('2026-12-14', '18:00').toISOString(), '2026-12-14T17:00:00.000Z');
    });

    it('am Umstellungstag im Oktober (25.10.2026) gilt abends bereits die Winterzeit', () => {
      assert.equal(zurichZuUtc('2026-10-25', '18:00').toISOString(), '2026-10-25T17:00:00.000Z');
      assert.equal(zurichZuUtc('2026-10-24', '18:00').toISOString(), '2026-10-24T16:00:00.000Z');
      // Ein Fenster am Umstellungstag bleibt vier Wandstunden lang.
      const t = tag({ datum: '2026-10-25' });
      assert.deepEqual(labels(t, anfrage(240)), ['18:00']);
    });

    it('am Umstellungstag im März (29.03.2026) ebenso — die fehlende Stunde verschiebt nichts', () => {
      assert.equal(zurichZuUtc('2026-03-29', '18:00').toISOString(), '2026-03-29T16:00:00.000Z');
      assert.equal(zurichZuUtc('2026-03-29', '01:00').toISOString(), '2026-03-29T00:00:00.000Z');
      // 02:30 gibt es nicht; die Umrechnung landet eine Stunde später, nicht davor.
      assert.equal(zurichZuUtc('2026-03-29', '02:30').toISOString(), '2026-03-29T01:30:00.000Z');
      assert.deepEqual(labels(tag({ datum: '2026-03-29' }), anfrage(180)), ['18:00', '18:30', '19:00']);
    });

    it('Mitternacht gehört zum richtigen Kalendertag', () => {
      assert.equal(zurichZuUtc('2026-06-16', '00:00').toISOString(), '2026-06-15T22:00:00.000Z');
      assert.equal(zurichDatum(new Date('2026-06-15T22:00:00Z')), '2026-06-16');
      assert.equal(zurichDatum(new Date('2026-06-15T21:59:00Z')), '2026-06-15');
      assert.equal(naechsterTag('2026-10-24'), '2026-10-25');
      assert.equal(naechsterTag('2026-03-28', 2), '2026-03-30');
    });
  });
});
