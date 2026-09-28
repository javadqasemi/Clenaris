/**
 * Der Rechenkern der Qualitätskontrolle — rein, ohne Prisma, ohne
 * `server-only`, ohne Pfad-Alias.
 *
 * ---------------------------------------------------------------------------
 *  Warum getrennt
 * ---------------------------------------------------------------------------
 *
 * Dieselbe Entscheidung wie bei der Serienrechnung der Verträge
 * (`src/lib/contracts/serie.ts`) und den Rechenkernen der
 * Unternehmensführung: Was eine reine Funktion ist, wird als reine Funktion
 * geprüft. Ob 17 von 20 Punkten „bestanden" heissen, ist keine Frage, die man
 * über HTTP stellen sollte — dort verdeckt der Datenbestand die Rechnung, und
 * eine Prüfung, die erst einen Vertrag anlegen muss, prüft am Ende den
 * Vertrag.
 *
 * ---------------------------------------------------------------------------
 *  Die zwei Entscheidungen, die alles tragen
 * ---------------------------------------------------------------------------
 *
 * **Die Punktzahl rechnet der Server, nie der Client.** Dieselbe Regel wie
 * beim Preis: Die Maske schickt die Einzelbewertungen, die Gesamtzahl entsteht
 * hier. Ein mitgeschicktes `score` wäre eine Behauptung über das eigene
 * Ergebnis.
 *
 * **Gewichtung, nicht Mittelwert.** Ein Kriterium „Sanitärbereich" wiegt
 * schwerer als „Papierkorb geleert". Ein ungewichteter Mittelwert liesse sich
 * durch viele Kleinigkeiten schönrechnen — genau das, was eine
 * Qualitätskontrolle nicht tun darf. Ohne Gewicht zählt jedes Kriterium
 * einfach; das ist der Normalfall und braucht keine Konfiguration.
 */

import { zuercherTag } from '../zuerich';

/** Eine Einzelbewertung: 0 bis `maximum` Punkte, mit optionalem Gewicht. */
export interface Kriterium {
  /** Erreichte Punkte. */
  punkte: number;
  /** Höchstpunktzahl dieses Kriteriums. */
  maximum: number;
  /**
   * Gewicht. Ohne Angabe 1.
   *
   * Ein Kriterium mit Gewicht 0 zählt **nicht** mit — das ist der Weg,
   * etwas zu erfassen, das an diesem Tag nicht beurteilbar war (der Keller
   * war verschlossen), ohne es als „null Punkte" zu werten. Der Unterschied
   * ist wesentlich: „nicht geprüft" ist keine schlechte Note.
   */
  gewicht?: number;
}

export interface Bewertung {
  /** Erreichte gewichtete Punkte. */
  erreicht: number;
  /** Mögliche gewichtete Punkte — ohne die Kriterien mit Gewicht 0. */
  moeglich: number;
  /** 0–100, auf eine Nachkommastelle. `null`, wenn nichts beurteilbar war. */
  prozent: number | null;
  /** Wie viele Kriterien mitgezählt haben. */
  gezaehlt: number;
  /** Wie viele als „nicht beurteilbar" ausgeklammert wurden. */
  ausgeklammert: number;
}

/**
 * Die Punktzahl einer Kontrolle.
 *
 * Wirft nicht bei unsinnigen Eingaben, sondern begrenzt: Punkte unter null
 * werden zu null, Punkte über dem Maximum auf das Maximum. Der Grund ist
 * derselbe wie an jeder Rechenkante dieser Anwendung — eine Kontrolle, die
 * wegen eines Tippfehlers abbricht, verliert die Arbeit einer halben Stunde
 * vor Ort. Die Eingabeprüfung steht im Zod-Schema und meldet den Tippfehler
 * am Feld; dieser Kern rechnet auch mit dem, was durchkommt.
 */
export function bewerte(kriterien: readonly Kriterium[]): Bewertung {
  let erreicht = 0;
  let moeglich = 0;
  let gezaehlt = 0;
  let ausgeklammert = 0;

  for (const kriterium of kriterien) {
    const gewicht = kriterium.gewicht ?? 1;
    const maximum = Math.max(0, kriterium.maximum);

    if (gewicht <= 0 || maximum === 0) {
      ausgeklammert += 1;
      continue;
    }

    const punkte = Math.min(Math.max(kriterium.punkte, 0), maximum);
    erreicht += punkte * gewicht;
    moeglich += maximum * gewicht;
    gezaehlt += 1;
  }

  return {
    erreicht: runde(erreicht),
    moeglich: runde(moeglich),
    prozent: moeglich > 0 ? runde((erreicht / moeglich) * 100) : null,
    gezaehlt,
    ausgeklammert,
  };
}

/** Auf eine Nachkommastelle — mehr behauptet eine Begehung nicht. */
function runde(wert: number): number {
  return Math.round(wert * 10) / 10;
}

// ---------------------------------------------------------------------------
//  Das Ergebnis gegen die Zusage
// ---------------------------------------------------------------------------

export type Ergebnis =
  /** Der Zielwert ist erreicht. */
  | 'BESTANDEN'
  /** Unter dem Ziel, aber innerhalb der Toleranz — Hinweis, keine Massnahme. */
  | 'KNAPP'
  /** Unter der Toleranz — hier gehört eine Massnahme dazu. */
  | 'NICHT_BESTANDEN'
  /** Kein Zielwert vereinbart: Die Kontrolle misst, urteilt aber nicht. */
  | 'OHNE_ZIEL';

/** Wie weit unter dem Ziel noch „knapp" heisst — in Prozentpunkten. */
export const TOLERANZ = 5;

/**
 * Das Urteil.
 *
 * **Ohne vereinbarten Zielwert gibt es keines.** Eine Kontrolle ohne Zusage
 * ist eine Messung, kein Bestehen oder Durchfallen — und das Produkt erfindet
 * keinen Massstab, auf den sich niemand geeinigt hat. Genau dieselbe Haltung
 * wie bei der Indexierung im Vertrag und bei der Wirksamkeit einer Kündigung.
 *
 * Der Zielwert stammt aus der Vertragsfassung, die **zum Zeitpunkt der
 * Kontrolle** galt, nicht aus der heute geltenden. Eine Begehung, die nach
 * einer Vertragsänderung plötzlich anders ausfiele, wäre kein Beleg.
 */
export function beurteile(prozent: number | null, zielwert: number | null | undefined): Ergebnis {
  if (prozent === null) return 'OHNE_ZIEL';
  if (zielwert === null || zielwert === undefined) return 'OHNE_ZIEL';
  if (prozent >= zielwert) return 'BESTANDEN';
  if (prozent >= zielwert - TOLERANZ) return 'KNAPP';
  return 'NICHT_BESTANDEN';
}

// ---------------------------------------------------------------------------
//  Fälligkeit der nächsten Kontrolle
// ---------------------------------------------------------------------------

/**
 * Ein Kalendertag in Zürcher Ortszeit, auf Mitternacht UTC normiert.
 *
 * Der Kommentar stand schon so da, die Rechnung nahm aber die UTC-Felder
 * (bis 2026-09-27): Eine Kontrolle um 00:30 Uhr zählte als gestern, und die
 * Fälligkeit hinkte zwischen Mitternacht und 02:00 um einen Tag nach. Für
 * einen reinen Kalendertag (`@db.Date`) ergibt der Zürcher Tag denselben Tag.
 */
function alsTag(wert: Date): Date {
  return zuercherTag(wert);
}

function plusTage(tag: Date, tage: number): Date {
  return new Date(Date.UTC(tag.getUTCFullYear(), tag.getUTCMonth(), tag.getUTCDate() + tage));
}

export interface Faelligkeit {
  /** Wann die nächste Kontrolle ansteht. `null` = kein Intervall vereinbart. */
  faelligAm: Date | null;
  /** Tage bis dahin; negativ heisst überfällig. `null` ohne Intervall. */
  inTagen: number | null;
  ueberfaellig: boolean;
}

/**
 * Wann die nächste Begehung ansteht.
 *
 * Gerechnet ab der **letzten durchgeführten** Kontrolle, nicht ab dem
 * Vertragsbeginn: Wer früher kontrolliert als vereinbart, verschiebt die
 * nächste Frist nach hinten — sonst häuften sich Termine an, die niemand
 * gewollt hat. Gab es noch keine, zählt der Vertragsbeginn.
 *
 * Ohne vereinbartes Intervall gibt es keine Fälligkeit. Auch hier gilt: kein
 * erfundener Massstab.
 */
export function naechsteKontrolle(params: {
  intervallTage: number | null | undefined;
  letzteKontrolleAm: Date | null | undefined;
  vertragsbeginn: Date;
  heute?: Date;
}): Faelligkeit {
  if (!params.intervallTage || params.intervallTage <= 0) {
    return { faelligAm: null, inTagen: null, ueberfaellig: false };
  }

  const basis = alsTag(params.letzteKontrolleAm ?? params.vertragsbeginn);
  const faelligAm = plusTage(basis, params.intervallTage);
  const heute = alsTag(params.heute ?? new Date());
  const inTagen = Math.round((faelligAm.getTime() - heute.getTime()) / 86_400_000);

  return { faelligAm, inTagen, ueberfaellig: inTagen < 0 };
}

// ---------------------------------------------------------------------------
//  Reaktionszeit auf eine Reklamation
// ---------------------------------------------------------------------------

export interface Reaktionsfrist {
  /** Bis wann geantwortet sein muss. `null` = keine Zusage vereinbart. */
  fristBis: Date | null;
  /** Tatsächlich vergangene Stunden, auf eine Nachkommastelle. */
  gebrauchteStunden: number | null;
  /** true = innerhalb der Zusage geantwortet. `null` ohne Zusage oder ohne Antwort. */
  eingehalten: boolean | null;
}

/**
 * Ob die zugesagte Reaktionszeit gehalten wurde.
 *
 * **Kalenderzeit, keine Arbeitszeit.** Eine Zusage „Reaktion in 24 Stunden"
 * ist gegenüber der Kundschaft eine Aussage über die Uhr, nicht über
 * Bürozeiten — und eine Umrechnung auf Öffnungszeiten wäre eine Auslegung des
 * Vertrags, die dieses System nicht vornimmt. Wer Bürozeiten meint, vereinbart
 * eine entsprechend längere Frist.
 *
 * Ohne Antwort gibt es kein Urteil, sondern eine offene Frist: `eingehalten`
 * bleibt `null` und `fristBis` sagt, bis wann noch Zeit ist.
 */
export function reaktionsfrist(params: {
  eingegangenAm: Date;
  beantwortetAm?: Date | null;
  zugesagteStunden: number | null | undefined;
}): Reaktionsfrist {
  const gebrauchteStunden = params.beantwortetAm
    ? Math.round(((params.beantwortetAm.getTime() - params.eingegangenAm.getTime()) / 3_600_000) * 10) / 10
    : null;

  if (!params.zugesagteStunden || params.zugesagteStunden <= 0) {
    return { fristBis: null, gebrauchteStunden, eingehalten: null };
  }

  const fristBis = new Date(params.eingegangenAm.getTime() + params.zugesagteStunden * 3_600_000);

  return {
    fristBis,
    gebrauchteStunden,
    eingehalten: params.beantwortetAm ? params.beantwortetAm.getTime() <= fristBis.getTime() : null,
  };
}
