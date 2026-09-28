import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  bewerte,
  beurteile,
  naechsteKontrolle,
  reaktionsfrist,
  TOLERANZ,
} from '../../src/lib/quality/bewertung';

/**
 * Der Rechenkern der Qualitätskontrolle (Wave 11), direkt geprüft.
 *
 * Kein Server, keine Datenbank: Was eine reine Funktion ist, wird als reine
 * Funktion geprüft — dieselbe Entscheidung wie bei `vertraege-rechenkern` und
 * `bi-rechenkerne`. Über HTTP verdeckte der Datenbestand die Rechnung, und
 * eine Prüfung, die erst einen Vertrag anlegen muss, prüft am Ende den
 * Vertrag.
 */

const tag = (text: string) => new Date(`${text}T00:00:00.000Z`);

describe('Rechenkern der Qualitätskontrolle', () => {
  describe('Punktzahl', () => {
    it('rechnet ohne Gewichte den einfachen Anteil', () => {
      const ergebnis = bewerte([
        { punkte: 5, maximum: 5 },
        { punkte: 3, maximum: 5 },
        { punkte: 4, maximum: 5 },
      ]);

      assert.equal(ergebnis.erreicht, 12);
      assert.equal(ergebnis.moeglich, 15);
      assert.equal(ergebnis.prozent, 80);
      assert.equal(ergebnis.gezaehlt, 3);
      assert.equal(ergebnis.ausgeklammert, 0);
    });

    /**
     * Der eigentliche Grund für die Gewichtung: Ein schwerwiegendes Kriterium
     * darf sich nicht durch Kleinigkeiten schönrechnen lassen.
     */
    it('lässt sich durch viele gute Kleinigkeiten nicht schönrechnen', () => {
      const ungewichtet = bewerte([
        { punkte: 0, maximum: 5 }, // Sanitärbereich
        { punkte: 5, maximum: 5 },
        { punkte: 5, maximum: 5 },
        { punkte: 5, maximum: 5 },
      ]);
      assert.equal(ungewichtet.prozent, 75, 'ohne Gewicht sehen 0 Punkte im Sanitärbereich harmlos aus');

      const gewichtet = bewerte([
        { punkte: 0, maximum: 5, gewicht: 4 },
        { punkte: 5, maximum: 5 },
        { punkte: 5, maximum: 5 },
        { punkte: 5, maximum: 5 },
      ]);
      assert.equal(gewichtet.prozent, 42.9, 'mit Gewicht schlägt es durch');
    });

    /**
     * „Nicht beurteilbar" ist keine schlechte Note. Der Keller war
     * verschlossen — das darf die Punktzahl weder senken noch heben.
     */
    it('klammert Kriterien mit Gewicht 0 aus, statt sie als null Punkte zu werten', () => {
      const ergebnis = bewerte([
        { punkte: 4, maximum: 5 },
        { punkte: 0, maximum: 5, gewicht: 0 },
        { punkte: 4, maximum: 5 },
      ]);

      assert.equal(ergebnis.moeglich, 10, 'das ausgeklammerte Kriterium zählt nicht zum Möglichen');
      assert.equal(ergebnis.prozent, 80);
      assert.equal(ergebnis.gezaehlt, 2);
      assert.equal(ergebnis.ausgeklammert, 1);
    });

    it('meldet ohne beurteilbares Kriterium keine Prozentzahl statt null Prozent', () => {
      const ergebnis = bewerte([{ punkte: 0, maximum: 5, gewicht: 0 }]);
      assert.equal(ergebnis.prozent, null, 'nichts geprüft ist nicht dasselbe wie null Punkte');
      assert.equal(ergebnis.moeglich, 0);
    });

    it('begrenzt unsinnige Eingaben, statt abzubrechen', () => {
      const ergebnis = bewerte([
        { punkte: 99, maximum: 5 },
        { punkte: -3, maximum: 5 },
      ]);

      assert.equal(ergebnis.erreicht, 5, 'über dem Maximum wird gekappt, unter null aufgefangen');
      assert.equal(ergebnis.moeglich, 10);
      assert.equal(ergebnis.prozent, 50);
    });

    it('rechnet die leere Kontrolle ohne Fehler', () => {
      const ergebnis = bewerte([]);
      assert.equal(ergebnis.prozent, null);
      assert.equal(ergebnis.gezaehlt, 0);
    });
  });

  describe('Urteil gegen die Zusage', () => {
    it('besteht ab dem Zielwert', () => {
      assert.equal(beurteile(85, 85), 'BESTANDEN');
      assert.equal(beurteile(92.5, 85), 'BESTANDEN');
    });

    it('nennt knapp verfehlt knapp — innerhalb der Toleranz', () => {
      assert.equal(beurteile(85 - TOLERANZ, 85), 'KNAPP');
      assert.equal(beurteile(84.9, 85), 'KNAPP');
    });

    it('nennt deutlich verfehlt nicht bestanden', () => {
      assert.equal(beurteile(85 - TOLERANZ - 0.1, 85), 'NICHT_BESTANDEN');
      assert.equal(beurteile(40, 85), 'NICHT_BESTANDEN');
    });

    /**
     * Die Haltung des ganzen Produkts: Wo nichts vereinbart wurde, wird nichts
     * behauptet — wie bei der Indexierung und der Wirksamkeit einer Kündigung.
     */
    it('urteilt ohne vereinbarten Zielwert nicht', () => {
      assert.equal(beurteile(40, null), 'OHNE_ZIEL');
      assert.equal(beurteile(100, undefined), 'OHNE_ZIEL');
      assert.equal(beurteile(null, 85), 'OHNE_ZIEL', 'und ohne beurteilbares Kriterium erst recht nicht');
    });
  });

  describe('Fälligkeit der nächsten Kontrolle', () => {
    it('rechnet ab der letzten Kontrolle, nicht ab dem Vertragsbeginn', () => {
      const ergebnis = naechsteKontrolle({
        intervallTage: 30,
        letzteKontrolleAm: tag('2026-09-10'),
        vertragsbeginn: tag('2026-01-01'),
        heute: tag('2026-09-22'),
      });

      assert.equal(ergebnis.faelligAm?.toISOString().slice(0, 10), '2026-10-10');
      assert.equal(ergebnis.inTagen, 18);
      assert.equal(ergebnis.ueberfaellig, false);
    });

    /**
     * Wer früher kontrolliert als vereinbart, verschiebt die nächste Frist
     * nach hinten. Sonst häuften sich Termine an, die niemand gewollt hat.
     */
    it('belohnt frühes Kontrollieren, statt Termine aufzustauen', () => {
      const frueh = naechsteKontrolle({
        intervallTage: 30,
        letzteKontrolleAm: tag('2026-09-20'),
        vertragsbeginn: tag('2026-01-01'),
        heute: tag('2026-09-22'),
      });
      assert.equal(frueh.faelligAm?.toISOString().slice(0, 10), '2026-10-20');
    });

    it('zählt ohne bisherige Kontrolle ab dem Vertragsbeginn', () => {
      const ergebnis = naechsteKontrolle({
        intervallTage: 90,
        letzteKontrolleAm: null,
        vertragsbeginn: tag('2026-06-01'),
        heute: tag('2026-09-22'),
      });

      assert.equal(ergebnis.faelligAm?.toISOString().slice(0, 10), '2026-08-30');
      assert.equal(ergebnis.ueberfaellig, true);
      assert.equal(ergebnis.inTagen, -23);
    });

    it('kennt ohne vereinbartes Intervall keine Fälligkeit', () => {
      for (const intervall of [null, undefined, 0, -30]) {
        const ergebnis = naechsteKontrolle({
          intervallTage: intervall,
          letzteKontrolleAm: tag('2026-09-10'),
          vertragsbeginn: tag('2026-01-01'),
          heute: tag('2026-09-22'),
        });
        assert.equal(ergebnis.faelligAm, null, `Intervall ${intervall}`);
        assert.equal(ergebnis.inTagen, null);
        assert.equal(ergebnis.ueberfaellig, false, 'ohne Frist ist nichts überfällig');
      }
    });
  });

  describe('Reaktionszeit auf eine Reklamation', () => {
    const eingang = new Date('2026-09-22T08:00:00.000Z');

    it('hält die Zusage, wenn rechtzeitig geantwortet wurde', () => {
      const ergebnis = reaktionsfrist({
        eingegangenAm: eingang,
        beantwortetAm: new Date('2026-09-22T20:30:00.000Z'),
        zugesagteStunden: 24,
      });

      assert.equal(ergebnis.gebrauchteStunden, 12.5);
      assert.equal(ergebnis.eingehalten, true);
      assert.equal(ergebnis.fristBis?.toISOString(), '2026-09-23T08:00:00.000Z');
    });

    it('meldet die Überschreitung, auch knapp', () => {
      const ergebnis = reaktionsfrist({
        eingegangenAm: eingang,
        beantwortetAm: new Date('2026-09-23T08:01:00.000Z'),
        zugesagteStunden: 24,
      });

      assert.equal(ergebnis.eingehalten, false);
      assert.equal(ergebnis.gebrauchteStunden, 24);
    });

    /**
     * Kalenderzeit, keine Arbeitszeit: Eine Zusage „24 Stunden" ist eine
     * Aussage über die Uhr. Eine Umrechnung auf Bürozeiten wäre eine Auslegung
     * des Vertrags, die dieses System nicht vornimmt.
     */
    it('rechnet über das Wochenende durch', () => {
      const freitagAbend = new Date('2026-09-25T17:00:00.000Z');
      const ergebnis = reaktionsfrist({
        eingegangenAm: freitagAbend,
        beantwortetAm: new Date('2026-09-28T09:00:00.000Z'),
        zugesagteStunden: 24,
      });

      assert.equal(ergebnis.eingehalten, false, 'am Montag geantwortet ist bei 24 Stunden zu spät');
      assert.equal(ergebnis.gebrauchteStunden, 64);
    });

    it('lässt die offene Frist offen, statt sie als eingehalten zu zählen', () => {
      const ergebnis = reaktionsfrist({
        eingegangenAm: eingang,
        beantwortetAm: null,
        zugesagteStunden: 24,
      });

      assert.equal(ergebnis.eingehalten, null, 'unbeantwortet ist weder gehalten noch gebrochen');
      assert.equal(ergebnis.gebrauchteStunden, null);
      assert.equal(ergebnis.fristBis?.toISOString(), '2026-09-23T08:00:00.000Z', 'die Frist steht trotzdem');
    });

    it('urteilt ohne Zusage nicht, misst aber trotzdem', () => {
      const ergebnis = reaktionsfrist({
        eingegangenAm: eingang,
        beantwortetAm: new Date('2026-09-25T08:00:00.000Z'),
        zugesagteStunden: null,
      });

      assert.equal(ergebnis.fristBis, null);
      assert.equal(ergebnis.eingehalten, null);
      assert.equal(ergebnis.gebrauchteStunden, 72, 'die Dauer ist auch ohne Zusage eine Tatsache');
    });
  });
});
