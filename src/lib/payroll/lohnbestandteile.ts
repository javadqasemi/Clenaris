/**
 * Die Bestandteile einer Lohnabrechnung — reine Rechnung ohne Datenbank.
 *
 * ---------------------------------------------------------------------------
 *  Was hier entsteht (Wave 9, 2026-09-23)
 * ---------------------------------------------------------------------------
 *
 * Bis hierher kannte die Abrechnung genau zwei Zahlen: Bruttolohn und die
 * Sozialabzüge darauf. Hier entsteht die vollständige Aufstellung in Zeilen:
 *
 *   Grundlohn (anteilig bei Ein-/Austritt und Lohnänderung im Monat)
 *   − unbezahlter Urlaub
 *   + Überstunden, Zulagen, Korrekturen            (beitragspflichtig)
 *   + Ferien- und Feiertagsentschädigung          (Stundenlohn, vertraglich)
 *   + 13. Monatslohn                              (vertraglich, vier Arten)
 *   = Bruttolohn                                  → Sozialabzüge
 *   − Quellensteuer                               (nur mit Tarif oder von Hand)
 *   − andere Abzüge
 *   + Spesen, Familienzulagen, Netto-Korrekturen  (keine Beiträge)
 *   = Auszahlung
 *
 * **Was hier bewusst nicht steht:** ein einziger gesetzlicher Satz. Die
 * Beitragssätze kommen aus den versionierten Satzversionen, der
 * Quellensteuersatz aus einem eingelesenen Tarif oder von Hand, die
 * Ferienentschädigung aus den Ferienwochen der Personalakte, die
 * Feiertagsentschädigung und der 13. Monatslohn aus der Vereinbarung.
 *
 * **Keine Pfad-Aliasse, kein `server-only`:** Die Prüfungen laufen mit `tsx`
 * ausserhalb des Next-Bündels (`tests/api/lohnbestandteile.test.ts`).
 */

import {
  berechneArbeitgeberbeitraege,
  berechneBeitraege,
  type ArbeitgeberBeitraege,
  type ArbeitgeberSaetze,
  type Beitraege,
  type BeitragsSaetze,
} from './beitraege';
import { alsZahl, geld, prozentVon, summe, summeZahl, type Geld } from '../money';

// ---------------------------------------------------------------------------
//  Kalender
// ---------------------------------------------------------------------------

/** Tage des Monats (1–12). */
export function tageImMonat(jahr: number, monat: number): number {
  return new Date(Date.UTC(jahr, monat, 0)).getUTCDate();
}

/** Werktage Montag bis Freitag in `[von, bis]` (Kalendertage, UTC-Datumsangaben). */
export function werktage(von: Date, bis: Date): number {
  let n = 0;
  const d = new Date(Date.UTC(von.getUTCFullYear(), von.getUTCMonth(), von.getUTCDate()));
  const ende = Date.UTC(bis.getUTCFullYear(), bis.getUTCMonth(), bis.getUTCDate());
  while (d.getTime() <= ende) {
    const wt = d.getUTCDay();
    if (wt !== 0 && wt !== 6) n += 1;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return n;
}

/**
 * Ferienentschädigung in Prozent aus den Ferientagen je Jahr.
 *
 * Die übliche Herleitung: Wochen Ferien geteilt durch die übrigen
 * Arbeitswochen — 4 Wochen ergeben 4/48 = 8,33 %, 5 Wochen 5/47 = 10,64 %,
 * 6 Wochen 6/46 = 13,04 %. Keine Tabelle, keine Annahme: eine Rechnung aus
 * dem, was in der Personalakte steht (Ferientage ÷ 5 = Wochen).
 */
export function ferienanteilProzent(ferientageJeJahr: number): number {
  const wochen = Math.max(0, ferientageJeJahr) / 5;
  if (wochen <= 0 || wochen >= 52) return 0;
  return Math.round((wochen / (52 - wochen)) * 100 * 10_000) / 10_000;
}

// ---------------------------------------------------------------------------
//  Grundlohn
// ---------------------------------------------------------------------------

/** Ein Abschnitt des Monatslohns: ab `ab` (Tag des Monats, 1-basiert) gilt `monatslohnVoll`. */
export interface Lohnabschnitt {
  abTag: number;
  /** Monatslohn × Pensum — der Betrag für einen ganzen Monat. */
  monatslohnVoll: number;
}

export interface Monatslohngrundlage {
  jahr: number;
  monat: number;
  /** Nach `abTag` aufsteigend; der erste beginnt spätestens am Eintrittstag. */
  abschnitte: Lohnabschnitt[];
  /** Erster und letzter angestellter Tag im Monat (1-basiert, einschliesslich). */
  ersterTag: number;
  letzterTag: number;
}

/**
 * Monatslohn nach Kalendertagen — anteilig bei Eintritt, Austritt und
 * Lohnänderung im Monat.
 *
 * Bis 2026-09-23 zahlte der Lauf immer den vollen Monatslohn zum Stand des
 * Monatsletzten: Eintritt am 20. ergab einen ganzen Monatslohn, eine
 * Erhöhung am 16. galt für den ganzen Monat. Jetzt zählt jeder Tag mit dem
 * Lohn, der an ihm galt, als Anteil `1 / Tage im Monat`.
 *
 * **Kalendertage, nicht 30er-Monate.** Beide Konventionen sind in der Praxis
 * verbreitet; welche gilt, regelt der Vertrag. Die Wahl steht hier offen im
 * Code und in `docs/PAYROLL.md` §5 als fachlich zu bestätigen.
 */
export function monatslohnAnteilig(g: Monatslohngrundlage): { betrag: number; tage: number; voll: boolean } {
  const tage = tageImMonat(g.jahr, g.monat);
  // Dezimal (Phase 25): 31 Anteile `Lohn / 31` binär addiert ergeben den
  // vollen Lohn nicht genau, und eine Summe knapp unter x.xx5 rundet ab.
  let summe = geld(0);
  for (let tag = g.ersterTag; tag <= g.letzterTag; tag++) {
    let gilt = 0;
    for (const a of g.abschnitte) if (a.abTag <= tag) gilt = a.monatslohnVoll;
    summe = summe.plus(geld(gilt).dividedBy(tage));
  }
  const angestellt = Math.max(0, g.letzterTag - g.ersterTag + 1);
  return { betrag: alsZahl(summe), tage: angestellt, voll: angestellt === tage };
}

// ---------------------------------------------------------------------------
//  Zeilen
// ---------------------------------------------------------------------------

export type Zeilenart =
  | 'BASE'
  | 'UNPAID_LEAVE'
  | 'OVERTIME'
  | 'ALLOWANCE'
  | 'FAMILY_ALLOWANCE'
  | 'VACATION_PAY'
  | 'HOLIDAY_PAY'
  | 'THIRTEENTH'
  | 'CORRECTION'
  | 'EXPENSE'
  | 'NET_CORRECTION'
  | 'AHV_IV_EO'
  | 'ALV'
  | 'BVG'
  | 'UVG_NBU'
  | 'KTG'
  | 'WITHHOLDING_TAX'
  | 'DEDUCTION'
  | 'EMPLOYER';

export type Zeilenwirkung = 'EARNING' | 'PAYMENT' | 'DEDUCTION' | 'EMPLOYER';

export interface Zeile {
  type: Zeilenart;
  kind: Zeilenwirkung;
  label: string;
  quantity: number | null;
  rate: number | null;
  amount: number;
  /** Steuerbarer Lohn (Quellensteuer, Lohnausweis). */
  taxable: boolean;
  /**
   * Ziffer des Lohnausweises (Formular 11). **Fachlich zu bestätigen** —
   * die Zuordnung folgt der Wegleitung, wie sie hier verstanden wurde.
   */
  certificateField: string | null;
  sourceItemId: string | null;
}

/**
 * Wo eine Zeile im Lohnausweis landet. Eine Tabelle, nicht verstreut — damit
 * die fachliche Prüfung eine Stelle ansehen kann.
 *
 * - 1: Lohn (inkl. Überstunden, Zulagen, Ferien-/Feiertagsentschädigung, 13.)
 * - 7: Andere Leistungen (Familienzulagen, die über den Betrieb laufen)
 * - 9: AHV/IV/EO, ALV, NBUV — Arbeitnehmerbeiträge
 * - 10.1: BVG, ordentliche Beiträge
 * - 12: Quellensteuerabzug
 * - 13.1.1: effektive Spesen
 */
export const LOHNAUSWEIS_ZIFFER: Partial<Record<Zeilenart, string>> = {
  BASE: '1',
  UNPAID_LEAVE: '1',
  OVERTIME: '1',
  ALLOWANCE: '1',
  VACATION_PAY: '1',
  HOLIDAY_PAY: '1',
  THIRTEENTH: '1',
  CORRECTION: '1',
  FAMILY_ALLOWANCE: '7',
  AHV_IV_EO: '9',
  ALV: '9',
  UVG_NBU: '9',
  BVG: '10.1',
  WITHHOLDING_TAX: '12',
  EXPENSE: '13.1.1',
};

function zeile(
  type: Zeilenart,
  kind: Zeilenwirkung,
  label: string,
  /** Als Dezimalzahl, wo er aus einer Rechnung stammt — gerundet wird hier, einmal. */
  amount: number | Geld,
  extra: Partial<Pick<Zeile, 'quantity' | 'rate' | 'taxable' | 'sourceItemId'>> = {},
): Zeile {
  return {
    type,
    kind,
    label,
    amount: alsZahl(amount),
    quantity: extra.quantity ?? null,
    rate: extra.rate ?? null,
    taxable: extra.taxable ?? (kind === 'EARNING'),
    certificateField: LOHNAUSWEIS_ZIFFER[type] ?? null,
    sourceItemId: extra.sourceItemId ?? null,
  };
}

// ---------------------------------------------------------------------------
//  Eingaben
// ---------------------------------------------------------------------------

export type PositionsArt =
  | 'OVERTIME'
  | 'ALLOWANCE'
  | 'FAMILY_ALLOWANCE'
  | 'EXPENSE'
  | 'CORRECTION'
  | 'NET_CORRECTION'
  | 'DEDUCTION'
  | 'WITHHOLDING_TAX_MANUAL';

export interface Position {
  id: string;
  type: PositionsArt;
  label: string;
  quantity: number | null;
  rate: number | null;
  surchargePct: number | null;
  amount: number;
}

/** Überstunden: Stunden × Ansatz × (1 + Zuschlag). Der Server rechnet, nie der Client. */
export function ueberstundenBetrag(stunden: number, ansatz: number, zuschlagPct: number): number {
  return alsZahl(geld(stunden).times(geld(ansatz)).times(geld(100).plus(geld(zuschlagPct))).dividedBy(100));
}

export type DreizehnterArt = 'NONE' | 'ANNUAL' | 'PRO_RATA' | 'MONTHLY';

export interface DreizehnterGrundlage {
  art: DreizehnterArt;
  auszahlungsmonat: number;
  /** Summe der Grundlöhne dieses Jahres in **früheren** Monaten. */
  grundlohnBisherImJahr: number;
  /** Bereits ausgerichteter 13. Monatslohn dieses Jahres. */
  bereitsAusbezahlt: number;
  /** Monatslohn × Pensum zum Stand des Monatsendes — nur bei Monatslohn. */
  monatslohnVoll: number | null;
  /** Angestellte Kalendertage im Jahr bis zum (voraussichtlichen) Jahresende bzw. Austritt. */
  anstellungstageImJahr: number;
  tageImJahr: number;
  /** Tritt die Person in diesem Monat aus? Dann wird der offene Anteil jetzt fällig. */
  austrittImMonat: boolean;
}

export type QuellensteuerGrundlage =
  | { status: 'KEINE' }
  | { status: 'SATZ'; satzPct: number; tarif: string; kanton: string; quelle: string; satzId: string }
  | { status: 'KEIN_TARIF'; tarif: string; kanton: string; grund: string };

export interface AbrechnungsEingabe {
  jahr: number;
  monat: number;
  grundlohn:
    | {
        art: 'MONTHLY';
        betrag: number;
        tage: number;
        voll: boolean;
        monatslohnVoll: number;
        /**
         * Stunden im selben Monat, an Tagen **ohne** Monatslohn — der Monat,
         * in dem jemand vom Stunden- zum Monatslohn wechselt (oder zurück).
         * Ohne diese Zeile wären die Stunden vor dem Wechsel unbezahlt.
         */
        stundenAnteil?: { betrag: number; stunden: number };
      }
    | { art: 'HOURLY'; betrag: number; stunden: number };
  /** Unbezahlte Abwesenheit in Werktagen (nur Monatslohn wirksam). */
  unbezahlteTage: number;
  /** Werktage Mo–Fr im Monat — Nenner des Abzugs für unbezahlten Urlaub. */
  werktageImMonat: number;
  positionen: Position[];
  /** Ferienentschädigung mit dem Lohn (nur Stundenlohn). */
  ferienImLohn: boolean;
  ferientageJeJahr: number;
  feiertagsanteilPct: number | null;
  dreizehnter: DreizehnterGrundlage;
  saetze: BeitragsSaetze;
  arbeitgeber: ArbeitgeberSaetze;
  alter: number | null;
  bruttoJahrHochrechnung: number;
}

export interface Abrechnung {
  zeilen: Zeile[];
  brutto: number;
  beitraege: Beitraege;
  arbeitgeber: ArbeitgeberBeitraege;
  quellensteuer: number;
  quellensteuerBemessung: number;
  spesenUndZahlungen: number;
  andereAbzuege: number;
  netto: number;
  pruefungErforderlich: boolean;
  pruefungsgrund: string | null;
  herleitung: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
//  Schritt 1: Lohnbestandteile bis zum Bruttolohn
// ---------------------------------------------------------------------------

export interface Lohnteil {
  zeilen: Zeile[];
  brutto: number;
  /** Bemessung der Quellensteuer — steuerbare Lohnbestandteile des Monats. */
  quellensteuerBemessung: number;
  /** Von Hand erfasste Quellensteuer, falls vorhanden — ersetzt den Tarif. */
  quellensteuerVonHand: Position | null;
  herleitung: Record<string, unknown>;
}

export function ermittleLohnteil(e: AbrechnungsEingabe): Lohnteil {
  const zeilen: Zeile[] = [];
  const herleitung: Record<string, unknown> = {};

  // Grundlohn ---------------------------------------------------------------
  if (e.grundlohn.art === 'MONTHLY') {
    zeilen.push(
      zeile(
        'BASE',
        'EARNING',
        e.grundlohn.voll ? 'Monatslohn' : `Monatslohn anteilig (${e.grundlohn.tage} Kalendertage)`,
        e.grundlohn.betrag,
        { quantity: e.grundlohn.voll ? null : e.grundlohn.tage },
      ),
    );
    if (e.grundlohn.stundenAnteil && e.grundlohn.stundenAnteil.betrag !== 0) {
      zeilen.push(
        zeile('BASE', 'EARNING', 'Stundenlohn (Tage ohne Monatslohn)', e.grundlohn.stundenAnteil.betrag, {
          quantity: e.grundlohn.stundenAnteil.stunden,
        }),
      );
    }
    /**
     * Unbezahlter Urlaub: Monatslohn ÷ Werktage des Monats × unbezahlte
     * Werktage. Werktage Mo–Fr ohne Feiertage — eine Vereinfachung, die in
     * `docs/PAYROLL.md` steht; der Vertrag kann anders rechnen.
     */
    if (e.unbezahlteTage > 0 && e.werktageImMonat > 0) {
      const abzug = alsZahl(geld(e.grundlohn.monatslohnVoll).dividedBy(e.werktageImMonat).times(e.unbezahlteTage));
      zeilen.push(
        zeile('UNPAID_LEAVE', 'EARNING', `Unbezahlter Urlaub (${e.unbezahlteTage} Werktage)`, -Math.min(abzug, e.grundlohn.betrag), {
          quantity: e.unbezahlteTage,
          rate: alsZahl(geld(e.grundlohn.monatslohnVoll).dividedBy(e.werktageImMonat)),
        }),
      );
      herleitung.unbezahlterUrlaub = { tage: e.unbezahlteTage, werktageImMonat: e.werktageImMonat };
    }
  } else {
    zeilen.push(zeile('BASE', 'EARNING', 'Stundenlohn', e.grundlohn.betrag, { quantity: e.grundlohn.stunden }));
  }

  // Erfasste Positionen ------------------------------------------------------
  let quellensteuerVonHand: Position | null = null;
  for (const p of e.positionen) {
    switch (p.type) {
      case 'OVERTIME':
        zeilen.push(
          zeile('OVERTIME', 'EARNING', p.label, p.amount, { quantity: p.quantity, rate: p.rate, sourceItemId: p.id }),
        );
        break;
      case 'ALLOWANCE':
        zeilen.push(zeile('ALLOWANCE', 'EARNING', p.label, p.amount, { sourceItemId: p.id }));
        break;
      case 'CORRECTION':
        zeilen.push(zeile('CORRECTION', 'EARNING', p.label, p.amount, { sourceItemId: p.id }));
        break;
      case 'FAMILY_ALLOWANCE':
        // Nicht AHV-pflichtig, aber steuerbar.
        zeilen.push(zeile('FAMILY_ALLOWANCE', 'PAYMENT', p.label, p.amount, { taxable: true, sourceItemId: p.id }));
        break;
      case 'EXPENSE':
        zeilen.push(zeile('EXPENSE', 'PAYMENT', p.label, p.amount, { taxable: false, sourceItemId: p.id }));
        break;
      case 'NET_CORRECTION':
        zeilen.push(zeile('NET_CORRECTION', 'PAYMENT', p.label, p.amount, { taxable: false, sourceItemId: p.id }));
        break;
      case 'DEDUCTION':
        zeilen.push(zeile('DEDUCTION', 'DEDUCTION', p.label, p.amount, { taxable: false, sourceItemId: p.id }));
        break;
      case 'WITHHOLDING_TAX_MANUAL':
        quellensteuerVonHand = p;
        break;
    }
  }

  // Ferien- und Feiertagsentschädigung (Stundenlohn) -------------------------
  const grundlohn = summe(zeilen.filter((z) => z.type === 'BASE').map((z) => z.amount)).toNumber();
  if (e.grundlohn.art === 'HOURLY' && e.ferienImLohn) {
    const satz = ferienanteilProzent(e.ferientageJeJahr);
    if (satz > 0) {
      zeilen.push(
        zeile('VACATION_PAY', 'EARNING', `Ferienentschädigung ${satz.toFixed(2)} %`, prozentVon(grundlohn, satz), { rate: satz }),
      );
      herleitung.ferienentschaedigung = { ferientageJeJahr: e.ferientageJeJahr, satzPct: satz };
    }
  }
  if (e.grundlohn.art === 'HOURLY' && e.feiertagsanteilPct && e.feiertagsanteilPct > 0) {
    zeilen.push(
      zeile(
        'HOLIDAY_PAY',
        'EARNING',
        `Feiertagsentschädigung ${e.feiertagsanteilPct.toFixed(2)} %`,
        prozentVon(grundlohn, e.feiertagsanteilPct),
        { rate: e.feiertagsanteilPct },
      ),
    );
  }

  // 13. Monatslohn -----------------------------------------------------------
  const unbezahlt = summe(zeilen.filter((z) => z.type === 'UNPAID_LEAVE').map((z) => z.amount)).toNumber();
  const dreizehnter = berechneDreizehnten(e.dreizehnter, summeZahl(grundlohn, unbezahlt), e.monat);
  if (dreizehnter.betrag !== 0) {
    zeilen.push(zeile('THIRTEENTH', 'EARNING', dreizehnter.beschriftung, dreizehnter.betrag));
  }
  herleitung.dreizehnter = dreizehnter.herleitung;

  const brutto = summe(zeilen.filter((z) => z.kind === 'EARNING').map((z) => z.amount)).toNumber();
  const quellensteuerBemessung = summe(
    zeilen.filter((z) => (z.kind === 'EARNING' || z.kind === 'PAYMENT') && z.taxable).map((z) => z.amount),
  ).toNumber();
  return { zeilen, brutto, quellensteuerBemessung, quellensteuerVonHand, herleitung };
}

/**
 * Der 13. Monatslohn — nach der vereinbarten Art, nie als gesetzliche Pflicht.
 *
 *  • `MONTHLY`: jeden Monat ein Zwölftel des Grundlohns (nach Abzug
 *    unbezahlten Urlaubs).
 *  • `PRO_RATA`: im Auszahlungsmonat oder beim Austritt ein Zwölftel der im
 *    Jahr bezahlten Grundlöhne, abzüglich des schon Ausgerichteten. Ein- und
 *    Austritt, Lohnänderung und unbezahlter Urlaub sind damit von selbst
 *    berücksichtigt — sie stehen bereits in den Grundlöhnen.
 *  • `ANNUAL`: im Auszahlungsmonat ein Monatslohn (Stand Monatsende), bei
 *    unterjähriger Anstellung nach Kalendertagen anteilig; beim Austritt der
 *    anteilige Betrag im Austrittsmonat. Ohne Monatslohn (Stundenlohn) gilt
 *    `PRO_RATA` — ein „Monatslohn" existiert dort nicht.
 *
 * Doppelt ausgerichtet wird nie: `bereitsAusbezahlt` wird abgezogen bzw.
 * sperrt die Einmalzahlung.
 */
export function berechneDreizehnten(
  g: DreizehnterGrundlage,
  grundlohnDiesesMonats: number,
  monat: number,
): { betrag: number; beschriftung: string; herleitung: Record<string, unknown> } {
  if (g.art === 'NONE') return { betrag: 0, beschriftung: '', herleitung: { art: 'NONE' } };

  if (g.art === 'MONTHLY') {
    const betrag = alsZahl(geld(grundlohnDiesesMonats).dividedBy(12));
    return { betrag, beschriftung: '13. Monatslohn (monatlich 1/12)', herleitung: { art: 'MONTHLY', grundlage: grundlohnDiesesMonats } };
  }

  const faellig = monat === g.auszahlungsmonat || g.austrittImMonat;
  if (!faellig) return { betrag: 0, beschriftung: '', herleitung: { art: g.art, faellig: false } };

  const art = g.art === 'ANNUAL' && g.monatslohnVoll === null ? 'PRO_RATA' : g.art;

  if (art === 'ANNUAL') {
    if (g.bereitsAusbezahlt > 0) {
      return { betrag: 0, beschriftung: '', herleitung: { art, bereitsAusbezahlt: g.bereitsAusbezahlt } };
    }
    const anteil = g.tageImJahr > 0 ? Math.min(1, g.anstellungstageImJahr / g.tageImJahr) : 0;
    // Lohn × Tage ÷ Jahrestage, nicht Lohn × (binärer Anteil).
    const betrag =
      anteil >= 1
        ? alsZahl(g.monatslohnVoll ?? 0)
        : alsZahl(geld(g.monatslohnVoll ?? 0).times(g.anstellungstageImJahr).dividedBy(g.tageImJahr));
    return {
      betrag,
      beschriftung: anteil < 1 ? `13. Monatslohn anteilig (${g.anstellungstageImJahr} Tage)` : '13. Monatslohn',
      herleitung: { art, monatslohnVoll: g.monatslohnVoll, anstellungstageImJahr: g.anstellungstageImJahr, tageImJahr: g.tageImJahr },
    };
  }

  const imJahr = geld(g.grundlohnBisherImJahr).plus(geld(grundlohnDiesesMonats));
  const betrag = alsZahl(imJahr.dividedBy(12).minus(geld(g.bereitsAusbezahlt)));
  return {
    betrag: betrag > 0 ? betrag : 0,
    beschriftung: '13. Monatslohn (1/12 der Grundlöhne)',
    herleitung: { art: 'PRO_RATA', grundlohnImJahr: alsZahl(imJahr), bereitsAusbezahlt: g.bereitsAusbezahlt },
  };
}

// ---------------------------------------------------------------------------
//  Schritt 2: Abzüge, Quellensteuer, Auszahlung
// ---------------------------------------------------------------------------

export function schliesseAbrechnungAb(
  e: AbrechnungsEingabe,
  teil: Lohnteil,
  quellensteuer: QuellensteuerGrundlage,
): Abrechnung {
  const zeilen = [...teil.zeilen];
  const grundlage = { bruttoMonat: teil.brutto, bruttoJahr: e.bruttoJahrHochrechnung, alter: e.alter };
  const beitraege = berechneBeitraege(grundlage, e.saetze);
  const arbeitgeber = berechneArbeitgeberbeitraege(grundlage, e.saetze, e.arbeitgeber, beitraege);

  const abzug = (type: Zeilenart, label: string, betrag: number, satz: number | null) => {
    if (betrag !== 0) zeilen.push(zeile(type, 'DEDUCTION', label, betrag, { rate: satz, taxable: false }));
  };
  abzug('AHV_IV_EO', 'AHV/IV/EO', beitraege.ahvIv, e.saetze.ahvIvEo);
  abzug('ALV', 'ALV', beitraege.alv, e.saetze.alv);
  abzug('UVG_NBU', 'Nichtberufsunfall (NBU)', beitraege.uvg, e.saetze.uvgNbu);
  abzug('KTG', 'Krankentaggeld', beitraege.ktg, e.saetze.ktg);
  abzug('BVG', 'Berufliche Vorsorge (BVG)', beitraege.bvg, null);

  // Quellensteuer ------------------------------------------------------------
  let qst = 0;
  let pruefungErforderlich = false;
  let pruefungsgrund: string | null = null;
  const qstHerleitung: Record<string, unknown> = { status: quellensteuer.status, bemessung: teil.quellensteuerBemessung };
  if (teil.quellensteuerVonHand) {
    qst = alsZahl(teil.quellensteuerVonHand.amount);
    abzug('WITHHOLDING_TAX', teil.quellensteuerVonHand.label || 'Quellensteuer (von Hand)', qst, null);
    qstHerleitung.vonHand = true;
  } else if (quellensteuer.status === 'SATZ') {
    qst = prozentVon(teil.quellensteuerBemessung, quellensteuer.satzPct);
    abzug(
      'WITHHOLDING_TAX',
      `Quellensteuer ${quellensteuer.kanton} ${quellensteuer.tarif} ${quellensteuer.satzPct.toFixed(2)} %`,
      qst,
      quellensteuer.satzPct,
    );
    Object.assign(qstHerleitung, { satzPct: quellensteuer.satzPct, tarif: quellensteuer.tarif, kanton: quellensteuer.kanton, quelle: quellensteuer.quelle, satzId: quellensteuer.satzId });
  } else if (quellensteuer.status === 'KEIN_TARIF') {
    pruefungErforderlich = true;
    pruefungsgrund = quellensteuer.grund;
    Object.assign(qstHerleitung, { tarif: quellensteuer.tarif, kanton: quellensteuer.kanton });
  }

  // Arbeitgeberbeiträge — informativ ------------------------------------------
  const ag = (label: string, betrag: number) => {
    if (betrag !== 0) zeilen.push(zeile('EMPLOYER', 'EMPLOYER', label, betrag, { taxable: false }));
  };
  ag('Arbeitgeber AHV/IV/EO', arbeitgeber.ahvIvEo);
  ag('Arbeitgeber ALV', arbeitgeber.alv);
  ag('Arbeitgeber UVG', arbeitgeber.uvg);
  ag('Arbeitgeber KTG', arbeitgeber.ktg);
  ag('Arbeitgeber FAK', arbeitgeber.fak);
  ag('Arbeitgeber Verwaltungskosten', arbeitgeber.vk);
  ag('Arbeitgeber BVG', arbeitgeber.bvg);

  const spesenUndZahlungen = summe(zeilen.filter((z) => z.kind === 'PAYMENT').map((z) => z.amount)).toNumber();
  const andereAbzuege = summe(zeilen.filter((z) => z.type === 'DEDUCTION').map((z) => z.amount)).toNumber();
  const netto = summeZahl(teil.brutto, -beitraege.summe, -qst, -andereAbzuege, spesenUndZahlungen);

  return {
    zeilen,
    brutto: teil.brutto,
    beitraege,
    arbeitgeber,
    quellensteuer: qst,
    quellensteuerBemessung: teil.quellensteuerBemessung,
    spesenUndZahlungen,
    andereAbzuege,
    netto,
    pruefungErforderlich,
    pruefungsgrund,
    herleitung: { ...teil.herleitung, ...beitraege.herleitung, quellensteuer: qstHerleitung },
  };
}
