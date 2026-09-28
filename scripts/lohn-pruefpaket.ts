/**
 * Das maschinenlesbare Prüfpaket der Lohnrechnung erzeugen und prüfen
 * (F-13 / E-6, 2026-09-27).
 *
 *   npx tsx scripts/lohn-pruefpaket.ts            # docs/lohn/pruefpaket.json neu schreiben
 *   npx tsx scripts/lohn-pruefpaket.ts --pruefen  # nur vergleichen; Exitcode 1, wenn veraltet
 *
 * ---------------------------------------------------------------------------
 *  Wofür
 * ---------------------------------------------------------------------------
 *
 * Die fachliche Prüfung der Lohnabrechnung (E-6) macht eine externe
 * Fachperson — Treuhand oder Lohnbuchhaltung. Sie soll dafür keinen
 * TypeScript-Code lesen müssen, und sie soll auch keine Beschreibung
 * bekommen, die neben dem Code herläuft und irgendwann nicht mehr stimmt.
 * `docs/PAYROLL.md` §11 war bis hierher eine Liste offener Fragen, kein
 * prüfbares Paket.
 *
 * Deshalb entsteht das Paket **aus dem Code**: Die Sätze kommen aus
 * `SAETZE_2026`, jedes Ergebnis eines Beispielfalls aus denselben Funktionen,
 * die der Lohnlauf aufruft (`berechneBeitraege`, `ermittleLohnteil`,
 * `schliesseAbrechnungAb` …). Neben jedem gerechneten Ergebnis steht ein
 * **von Hand gerechneter Sollwert** mit dem Rechenweg. Weicht der Code von der
 * Handrechnung ab, schreibt dieses Skript kein Paket, sondern scheitert — ein
 * Paket, dessen Beispiele sich selbst widersprechen, ist für eine Prüfung
 * wertlos.
 *
 * Was das Paket **nicht** ist: ein Nachweis, dass die Sätze stimmen. Alle
 * Sätze sind Vorbelegung und ungeprüft; genau das soll die Fachperson
 * bestätigen oder korrigieren.
 *
 * Ohne Datenbank: Die Rechenkerne sind rein (`src/lib/payroll/*`), und die
 * Vorbelegung der Arbeitgeberanteile wird hier gespiegelt — so, wie
 * `prisma/seed.ts` sie aus `SAETZE_2026` ableitet. `payroll-rates.service.ts`
 * trägt `server-only` und lässt sich nicht laden, ohne den Dienst zu starten.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  SAETZE_2026,
  berechneArbeitgeberbeitraege,
  berechneBeitraege,
  type ArbeitgeberSaetze,
  type BeitragsGrundlage,
} from '../src/lib/payroll/beitraege';
import {
  berechneDreizehnten,
  ermittleLohnteil,
  ferienanteilProzent,
  monatslohnAnteilig,
  schliesseAbrechnungAb,
  ueberstundenBetrag,
  type AbrechnungsEingabe,
  type DreizehnterGrundlage,
  type QuellensteuerGrundlage,
} from '../src/lib/payroll/lohnbestandteile';

const WURZEL = join(__dirname, '..');
const ZIEL = join(WURZEL, 'docs', 'lohn', 'pruefpaket.json');

/** Fester Stand — kein Zeitstempel, sonst wäre jede Erzeugung eine Änderung. */
const STAND = '2026-09-27';
const VORBELEGUNG_QUELLE = 'Vorbelegung Clenaris (Stand 2026) — ungeprüft, fachlich zu bestätigen';

/** Die Arbeitgeber-Vorbelegung, wie `payroll-rates.service.ts:vorbelegung` und `prisma/seed.ts` sie setzen. */
const ARBEITGEBER_VORBELEGUNG: ArbeitgeberSaetze = {
  ahvIvEo: SAETZE_2026.ahvIvEo,
  alv: SAETZE_2026.alv,
  alvUeberGrenze: SAETZE_2026.alvUeberGrenze,
  uvgNbu: 0,
  uvgBu: 0,
  ktg: 0,
  fak: 0,
  vk: 0,
};

// ---------------------------------------------------------------------------
//  Sätze
// ---------------------------------------------------------------------------

const GUELTIG = { gueltigAb: '2026-01-01', gueltigBis: '2026-12-31' };
const HERKUNFT = {
  quelle: VORBELEGUNG_QUELLE,
  version: 'SAETZE_2026',
  pruefstand: 'UNGEPRUEFT',
  fundstelle: 'src/lib/payroll/beitraege.ts:SAETZE_2026; Arbeitgeberanteile: src/server/services/payroll-rates.service.ts:vorbelegung',
};

const SAETZE = [
  {
    code: 'AHV_IV_EO',
    bezeichnung: 'AHV/IV/EO',
    arbeitnehmerPct: SAETZE_2026.ahvIvEo,
    arbeitgeberPct: ARBEITGEBER_VORBELEGUNG.ahvIvEo,
    basis: 'Bruttolohn des Monats (AHV-pflichtiger Lohn)',
    zuPruefen: 'Satz 2026 gegen die Vorgaben des Bundes (BSV) bestätigen.',
    ...GUELTIG,
    ...HERKUNFT,
  },
  {
    code: 'ALV',
    bezeichnung: 'ALV bis Grenze',
    arbeitnehmerPct: SAETZE_2026.alv,
    arbeitgeberPct: ARBEITGEBER_VORBELEGUNG.alv,
    grenzeJahr: SAETZE_2026.alvGrenzeJahr,
    basis: 'Bruttolohn bis zur Jahresgrenze ÷ 12 je Monat',
    zuPruefen: 'Satz und Höchstbetrag 2026; Monatsaufteilung der Jahresgrenze (÷ 12) statt laufender Jahressumme.',
    ...GUELTIG,
    ...HERKUNFT,
  },
  {
    code: 'ALV_SOLIDARITY',
    bezeichnung: 'ALV über Grenze (Solidarität)',
    arbeitnehmerPct: SAETZE_2026.alvUeberGrenze,
    arbeitgeberPct: ARBEITGEBER_VORBELEGUNG.alvUeberGrenze,
    grenzeJahr: SAETZE_2026.alvGrenzeJahr,
    basis: 'Bruttolohn über der Jahresgrenze ÷ 12',
    zuPruefen: 'Seit 2023 aufgehoben — 0 bestätigen.',
    ...GUELTIG,
    ...HERKUNFT,
  },
  {
    code: 'UVG_NBU',
    bezeichnung: 'UVG Nichtberufsunfall',
    arbeitnehmerPct: SAETZE_2026.uvgNbu,
    arbeitgeberPct: ARBEITGEBER_VORBELEGUNG.uvgNbu,
    basis: 'Bruttolohn des Monats (ohne Höchstbetrag in der Rechnung)',
    zuPruefen: 'Betriebsabhängig: Satz aus dem Versicherungsvertrag. 1,6 % ist eine Annahme für das Reinigungsgewerbe. Der UVG-Höchstbetrag wird nicht angewendet.',
    ...GUELTIG,
    ...HERKUNFT,
  },
  {
    code: 'UVG_BU',
    bezeichnung: 'UVG Berufsunfall',
    arbeitnehmerPct: 0,
    arbeitgeberPct: ARBEITGEBER_VORBELEGUNG.uvgBu,
    basis: 'Bruttolohn des Monats',
    zuPruefen: 'Betriebsabhängig, trägt der Betrieb. Vorbelegung 0 — nicht geraten.',
    ...GUELTIG,
    ...HERKUNFT,
  },
  {
    code: 'KTG',
    bezeichnung: 'Krankentaggeld',
    arbeitnehmerPct: SAETZE_2026.ktg,
    arbeitgeberPct: ARBEITGEBER_VORBELEGUNG.ktg,
    basis: 'Bruttolohn des Monats',
    zuPruefen: 'Nur mit Versicherung; Satz und Aufteilung aus dem Vertrag (GAV Reinigung beachten).',
    ...GUELTIG,
    ...HERKUNFT,
  },
  {
    code: 'FAK',
    bezeichnung: 'Familienausgleichskasse',
    arbeitnehmerPct: 0,
    arbeitgeberPct: ARBEITGEBER_VORBELEGUNG.fak,
    basis: 'Bruttolohn des Monats (AHV-Lohn)',
    zuPruefen: 'Kantonal (Bern) und je Kasse. Vorbelegung 0 — nicht geraten.',
    ...GUELTIG,
    ...HERKUNFT,
  },
  {
    code: 'VK',
    bezeichnung: 'Verwaltungskosten Ausgleichskasse',
    arbeitnehmerPct: 0,
    arbeitgeberPct: ARBEITGEBER_VORBELEGUNG.vk,
    basis: 'AHV/IV/EO-Beiträge beider Seiten — nicht der Lohn',
    zuPruefen: 'Je Ausgleichskasse. Vorbelegung 0 — nicht geraten.',
    ...GUELTIG,
    ...HERKUNFT,
  },
  {
    code: 'BVG',
    bezeichnung: 'Berufliche Vorsorge (Altersgutschrift)',
    arbeitnehmerPct: SAETZE_2026.bvgAnteilArbeitnehmer,
    arbeitgeberPct: 100 - SAETZE_2026.bvgAnteilArbeitnehmer,
    anteilHinweis: 'Prozent der Altersgutschrift, nicht des Lohns',
    eintrittsschwelle: SAETZE_2026.bvgEintrittsschwelle,
    koordinationsabzug: SAETZE_2026.bvgKoordinationsabzug,
    mindestKoordiniert: SAETZE_2026.bvgMindestKoordiniert,
    obergrenze: SAETZE_2026.bvgObergrenze,
    altersgutschriften: SAETZE_2026.bvgSaetze,
    basis: 'Koordinierter Jahreslohn aus der Jahreshochrechnung; Alter am 31.12. des Abrechnungsjahres',
    zuPruefen: 'Grenzbeträge 2026, Altersbänder und Aufteilung gegen den Vorsorgeplan; nur Sparbeitrag, keine Risikobeiträge.',
    ...GUELTIG,
    ...HERKUNFT,
  },
];

// ---------------------------------------------------------------------------
//  Formeln
// ---------------------------------------------------------------------------

const FORMELN = [
  { id: 'rundung', formel: 'Jeder Beitrag = Satz % × Basis, dezimal gerechnet, einmal auf Rappen gerundet (kaufmännisch, 0.005 → 0.01).', fundstelle: 'src/lib/money.ts:aufRappen; src/lib/payroll/beitraege.ts:prozent' },
  { id: 'ahv', formel: 'AHV/IV/EO = Brutto × Satz', fundstelle: 'beitraege.ts:berechneBeitraege' },
  { id: 'alv', formel: 'ALV = min(Brutto, Grenze/12) × Satz + max(0, Brutto − Grenze/12) × Satz über Grenze', fundstelle: 'beitraege.ts:berechneBeitraege' },
  { id: 'uvg-ktg', formel: 'UVG-NBU = Brutto × Satz; KTG = Brutto × Satz (ohne Höchstbetrag)', fundstelle: 'beitraege.ts:berechneBeitraege' },
  {
    id: 'bvg-koordiniert',
    formel: 'Jahreslohn < Eintrittsschwelle → 0 (nicht versichert); sonst max(Mindestbetrag, min(Jahreslohn, Obergrenze) − Koordinationsabzug)',
    fundstelle: 'beitraege.ts:koordinierterLohn',
  },
  { id: 'bvg-satz', formel: 'Altersgutschrift des höchsten Bandes mit abAlter ≤ Alter; Alter = Abrechnungsjahr − Geburtsjahr; ohne Geburtsdatum 0', fundstelle: 'beitraege.ts:bvgSatzFuerAlter, alterImJahr' },
  { id: 'bvg-abzug', formel: 'BVG AN = koordinierter Lohn × Satz ÷ 12 × Anteil AN %; AG = derselbe Monatsbetrag × (100 − Anteil AN) %', fundstelle: 'beitraege.ts:berechneBeitraege, berechneArbeitgeberbeitraege' },
  { id: 'vk', formel: 'VK = (AHV/IV/EO AN + AHV/IV/EO AG) × VK-Satz', fundstelle: 'beitraege.ts:berechneArbeitgeberbeitraege' },
  { id: 'anteilig', formel: 'Monatslohn anteilig = Σ über angestellte Kalendertage (Monatslohn des Tages ÷ Tage im Monat)', fundstelle: 'lohnbestandteile.ts:monatslohnAnteilig' },
  { id: 'unbezahlt', formel: 'Unbezahlter Urlaub = Monatslohn ÷ Werktage Mo–Fr des Monats × unbezahlte Werktage (Feiertage nicht abgezogen)', fundstelle: 'lohnbestandteile.ts:ermittleLohnteil' },
  { id: 'ueberstunden', formel: 'Überstunden = Stunden × Ansatz × (100 + Zuschlag %) ÷ 100', fundstelle: 'lohnbestandteile.ts:ueberstundenBetrag' },
  { id: 'ferien', formel: 'Ferienentschädigung % = Wochen ÷ (52 − Wochen) × 100, Wochen = Ferientage ÷ 5, auf 4 Stellen', fundstelle: 'lohnbestandteile.ts:ferienanteilProzent' },
  {
    id: 'dreizehnter',
    formel: 'MONTHLY: Grundlohn ÷ 12 je Monat; PRO_RATA: (Grundlöhne des Jahres ÷ 12) − bereits ausbezahlt; ANNUAL: Monatslohn × Anstellungstage ÷ Jahrestage (voll bei ganzem Jahr)',
    fundstelle: 'lohnbestandteile.ts:berechneDreizehnten',
  },
  { id: 'quellensteuer', formel: 'Quellensteuer = Bemessung (steuerbare Lohn- und Zahlungsbestandteile) × Tarifsatz; ohne Tarif keine Zahl, sondern Prüfung', fundstelle: 'lohnbestandteile.ts:schliesseAbrechnungAb' },
  { id: 'netto', formel: 'Auszahlung = Brutto − Sozialabzüge − Quellensteuer − andere Abzüge + Spesen/Zahlungen', fundstelle: 'lohnbestandteile.ts:schliesseAbrechnungAb' },
];

// ---------------------------------------------------------------------------
//  Beispielfälle — Ergebnis aus dem Code, Sollwert von Hand
// ---------------------------------------------------------------------------

interface Fall {
  id: string;
  titel: string;
  eingabe: unknown;
  rechenweg: string;
  soll: Record<string, number | boolean | null>;
  ist: Record<string, number | boolean | null>;
}

const faelle: Fall[] = [];

function beitraegeFall(id: string, titel: string, g: BeitragsGrundlage, rechenweg: string, soll: Fall['soll']): void {
  const b = berechneBeitraege(g, SAETZE_2026);
  faelle.push({
    id,
    titel,
    eingabe: { ...g, saetze: 'SAETZE_2026' },
    rechenweg,
    soll,
    ist: {
      ahvIvEo: b.ahvIv,
      alv: b.alv,
      uvgNbu: b.uvg,
      ktg: b.ktg,
      bvg: b.bvg,
      summe: b.summe,
      bvgKoordinierterJahreslohn: b.herleitung.bvgKoordinierterJahreslohn,
      bvgSatzGesamt: b.herleitung.bvgSatzGesamt,
      bvgVersichert: b.herleitung.bvgVersichert,
    },
  });
}

beitraegeFall(
  'B1',
  'Vollzeit, Monatslohn 6000, Alter 40',
  { bruttoMonat: 6000, bruttoJahr: 72_000, alter: 40 },
  'AHV 6000 × 5.3 % = 318.00; ALV 6000 × 1.1 % = 66.00; NBU 6000 × 1.6 % = 96.00; BVG: 72000 − 26460 = 45540 × 10 % = 4554 ÷ 12 = 379.50 × 50 % = 189.75; Summe 669.75',
  { ahvIvEo: 318, alv: 66, uvgNbu: 96, ktg: 0, bvg: 189.75, summe: 669.75, bvgKoordinierterJahreslohn: 45_540, bvgSatzGesamt: 10, bvgVersichert: true },
);
beitraegeFall(
  'B2',
  'Teilzeit knapp über der Eintrittsschwelle: Mindestbetrag des koordinierten Lohns',
  { bruttoMonat: 2000, bruttoJahr: 24_000, alter: 30 },
  'AHV 106.00; ALV 22.00; NBU 32.00; BVG: 24000 ≥ 22680, 24000 − 26460 < 0 → Mindestbetrag 3780 × 7 % = 264.60 ÷ 12 = 22.05 × 50 % = 11.025 → 11.03; Summe 171.03',
  { ahvIvEo: 106, alv: 22, uvgNbu: 32, ktg: 0, bvg: 11.03, summe: 171.03, bvgKoordinierterJahreslohn: 3780, bvgSatzGesamt: 7, bvgVersichert: true },
);
beitraegeFall(
  'B3',
  'Unter der Eintrittsschwelle: kein BVG',
  { bruttoMonat: 1500, bruttoJahr: 18_000, alter: 50 },
  'AHV 79.50; ALV 16.50; NBU 24.00; BVG 0 (18000 < 22680); Summe 120.00',
  { ahvIvEo: 79.5, alv: 16.5, uvgNbu: 24, ktg: 0, bvg: 0, summe: 120, bvgKoordinierterJahreslohn: 0, bvgSatzGesamt: 0, bvgVersichert: false },
);
beitraegeFall(
  'B4',
  'Hoher Lohn: ALV-Grenze und BVG-Obergrenze greifen, Alter 58',
  { bruttoMonat: 15_000, bruttoJahr: 180_000, alter: 58 },
  'AHV 795.00; ALV: Grenze 148200 ÷ 12 = 12350 × 1.1 % = 135.85, darüber 2650 × 0 % = 0; NBU 240.00; BVG: min(180000, 90720) − 26460 = 64260 × 18 % = 11566.80 ÷ 12 = 963.90 × 50 % = 481.95; Summe 1652.80',
  { ahvIvEo: 795, alv: 135.85, uvgNbu: 240, ktg: 0, bvg: 481.95, summe: 1652.8, bvgKoordinierterJahreslohn: 64_260, bvgSatzGesamt: 18, bvgVersichert: true },
);
beitraegeFall(
  'B5',
  'Rundung auf halbe Rappen: 57.505 wird 57.51',
  { bruttoMonat: 1085, bruttoJahr: 13_020, alter: 30 },
  'AHV 1085 × 5.3 % = 57.505 → 57.51; ALV 1085 × 1.1 % = 11.935 → 11.94; NBU 1085 × 1.6 % = 17.36; BVG 0; Summe 86.81',
  { ahvIvEo: 57.51, alv: 11.94, uvgNbu: 17.36, ktg: 0, bvg: 0, summe: 86.81, bvgKoordinierterJahreslohn: 0, bvgSatzGesamt: 0, bvgVersichert: false },
);
beitraegeFall(
  'B6',
  'Ohne Geburtsdatum: versichert, aber keine Altersgutschrift',
  { bruttoMonat: 6000, bruttoJahr: 72_000, alter: null },
  'AHV 318.00; ALV 66.00; NBU 96.00; BVG 0 (Alter unbekannt — Lücke in der Personalakte, kein geratener Satz); Summe 480.00',
  { ahvIvEo: 318, alv: 66, uvgNbu: 96, ktg: 0, bvg: 0, summe: 480, bvgKoordinierterJahreslohn: 45_540, bvgSatzGesamt: 0, bvgVersichert: true },
);

function arbeitgeberFall(id: string, titel: string, ag: ArbeitgeberSaetze, rechenweg: string, soll: Fall['soll']): void {
  const g: BeitragsGrundlage = { bruttoMonat: 6000, bruttoJahr: 72_000, alter: 40 };
  const an = berechneBeitraege(g, SAETZE_2026);
  const r = berechneArbeitgeberbeitraege(g, SAETZE_2026, ag, an);
  faelle.push({ id, titel, eingabe: { ...g, arbeitgeberSaetze: ag }, rechenweg, soll, ist: { ...r } });
}

arbeitgeberFall(
  'AG1',
  'Arbeitgeberbeiträge zu B1 mit der Vorbelegung',
  ARBEITGEBER_VORBELEGUNG,
  'AHV 318.00; ALV 66.00; UVG 0; KTG 0; FAK 0; VK 0; BVG 379.50 × 50 % = 189.75; Summe 573.75',
  { ahvIvEo: 318, alv: 66, uvg: 0, ktg: 0, fak: 0, vk: 0, bvg: 189.75, summe: 573.75 },
);
arbeitgeberFall(
  'AG2',
  'Arbeitgeberbeiträge zu B1 mit Beispielsätzen (keine Vorbelegung): VK auf die Beiträge, nicht auf den Lohn',
  { ahvIvEo: 5.3, alv: 1.1, alvUeberGrenze: 0, uvgNbu: 0, uvgBu: 0.5, ktg: 0, fak: 1.2, vk: 3 },
  'AHV 318.00; ALV 66.00; UVG 6000 × 0.5 % = 30.00; FAK 6000 × 1.2 % = 72.00; VK (318 + 318) × 3 % = 19.08; BVG 189.75; Summe 694.83',
  { ahvIvEo: 318, alv: 66, uvg: 30, ktg: 0, fak: 72, vk: 19.08, bvg: 189.75, summe: 694.83 },
);

faelle.push({
  id: 'L1',
  titel: 'Ferienentschädigung für 4, 5 und 6 Wochen',
  eingabe: { ferientageJeJahr: [20, 25, 30] },
  rechenweg: '4 ÷ 48 = 8.3333 %; 5 ÷ 47 = 10.6383 %; 6 ÷ 46 = 13.0435 %',
  soll: { tage20: 8.3333, tage25: 10.6383, tage30: 13.0435 },
  ist: { tage20: ferienanteilProzent(20), tage25: ferienanteilProzent(25), tage30: ferienanteilProzent(30) },
});

const eintritt = monatslohnAnteilig({ jahr: 2021, monat: 3, abschnitte: [{ abTag: 1, monatslohnVoll: 6000 }], ersterTag: 20, letzterTag: 31 });
const aenderung = monatslohnAnteilig({
  jahr: 2021,
  monat: 4,
  abschnitte: [
    { abTag: 1, monatslohnVoll: 6000 },
    { abTag: 16, monatslohnVoll: 6200 },
  ],
  ersterTag: 1,
  letzterTag: 30,
});
faelle.push({
  id: 'L2',
  titel: 'Monatslohn anteilig: Eintritt am 20. März, Lohnänderung am 16. April',
  eingabe: { eintritt: 'März 2021, Tag 20–31, 6000', aenderung: 'April 2021, 6000 bis 15., 6200 ab 16.' },
  rechenweg: 'März: 12 Tage × 6000 ÷ 31 = 2322.58; April: 15 × 6000 ÷ 30 + 15 × 6200 ÷ 30 = 3000 + 3100 = 6100.00',
  soll: { eintritt: 2322.58, eintrittTage: 12, aenderung: 6100 },
  ist: { eintritt: eintritt.betrag, eintrittTage: eintritt.tage, aenderung: aenderung.betrag },
});

faelle.push({
  id: 'L3',
  titel: 'Überstunden mit Zuschlag',
  eingabe: { stunden: 5, ansatz: 40, zuschlagPct: 25 },
  rechenweg: '5 × 40 × 125 % = 250.00',
  soll: { betrag: 250 },
  ist: { betrag: ueberstundenBetrag(5, 40, 25) },
});

const dreizehnterBasis: DreizehnterGrundlage = {
  art: 'PRO_RATA',
  auszahlungsmonat: 12,
  grundlohnBisherImJahr: 66_000,
  bereitsAusbezahlt: 0,
  monatslohnVoll: 6000,
  anstellungstageImJahr: 365,
  tageImJahr: 365,
  austrittImMonat: false,
};
faelle.push({
  id: 'L4',
  titel: '13. Monatslohn: pro rata, jährlich anteilig, monatlich',
  eingabe: { proRata: dreizehnterBasis, jaehrlichAnteilig: { ...dreizehnterBasis, art: 'ANNUAL', grundlohnBisherImJahr: 0, anstellungstageImJahr: 183 }, monatlich: { grundlohn: 6000 } },
  rechenweg: 'PRO_RATA: (66000 + 6000) ÷ 12 = 6000.00; ANNUAL: 6000 × 183 ÷ 365 = 3008.22; MONTHLY: 6000 ÷ 12 = 500.00',
  soll: { proRata: 6000, jaehrlichAnteilig: 3008.22, monatlich: 500 },
  ist: {
    proRata: berechneDreizehnten(dreizehnterBasis, 6000, 12).betrag,
    jaehrlichAnteilig: berechneDreizehnten({ ...dreizehnterBasis, art: 'ANNUAL', grundlohnBisherImJahr: 0, anstellungstageImJahr: 183 }, 6000, 12).betrag,
    monatlich: berechneDreizehnten({ ...dreizehnterBasis, art: 'MONTHLY' }, 6000, 5).betrag,
  },
});

/** Eine ganze Abrechnung: Monatslohn mit Positionen, einmal ohne und einmal mit Quellensteuer. */
function abrechnungsFall(id: string, titel: string, quellensteuer: QuellensteuerGrundlage, rechenweg: string, soll: Fall['soll']): void {
  const e: AbrechnungsEingabe = {
    jahr: 2026,
    monat: 5,
    grundlohn: { art: 'MONTHLY', betrag: 6000, tage: 31, voll: true, monatslohnVoll: 6000 },
    unbezahlteTage: 0,
    werktageImMonat: 21,
    positionen: [
      { id: 'p1', type: 'OVERTIME', label: 'Überstunden', quantity: 5, rate: 40, surchargePct: 25, amount: 250 },
      { id: 'p2', type: 'ALLOWANCE', label: 'Zulage', quantity: null, rate: null, surchargePct: null, amount: 200 },
      { id: 'p3', type: 'EXPENSE', label: 'Spesen', quantity: null, rate: null, surchargePct: null, amount: 80 },
      { id: 'p4', type: 'DEDUCTION', label: 'Abzug', quantity: null, rate: null, surchargePct: null, amount: 300 },
    ],
    ferienImLohn: false,
    ferientageJeJahr: 25,
    feiertagsanteilPct: null,
    dreizehnter: { ...dreizehnterBasis, art: 'NONE' },
    saetze: SAETZE_2026,
    arbeitgeber: ARBEITGEBER_VORBELEGUNG,
    alter: 40,
    bruttoJahrHochrechnung: 72_000,
  };
  const a = schliesseAbrechnungAb(e, ermittleLohnteil(e), quellensteuer);
  faelle.push({
    id,
    titel,
    eingabe: { ...e, saetze: 'SAETZE_2026', arbeitgeber: 'Vorbelegung', quellensteuer },
    rechenweg,
    soll,
    ist: {
      brutto: a.brutto,
      sozialabzuege: a.beitraege.summe,
      quellensteuer: a.quellensteuer,
      andereAbzuege: a.andereAbzuege,
      spesenUndZahlungen: a.spesenUndZahlungen,
      netto: a.netto,
      pruefungErforderlich: a.pruefungErforderlich,
    },
  });
}

abrechnungsFall(
  'A1',
  'Ganze Abrechnung: Monatslohn 6000, Überstunden 250, Zulage 200, Spesen 80, Abzug 300, ohne Quellensteuer',
  { status: 'KEINE' },
  'Brutto 6000 + 250 + 200 = 6450; AHV 341.85, ALV 70.95, NBU 103.20, BVG 189.75 (Jahreshochrechnung 72000) = 705.75; Netto 6450 − 705.75 − 300 + 80 = 5524.25',
  { brutto: 6450, sozialabzuege: 705.75, quellensteuer: 0, andereAbzuege: 300, spesenUndZahlungen: 80, netto: 5524.25, pruefungErforderlich: false },
);
abrechnungsFall(
  'A2',
  'Wie A1, mit Quellensteuer aus einem Beispieltarif von 10 % (kein echter Tarif)',
  { status: 'SATZ', satzPct: 10, tarif: 'A0N', kanton: 'BE', quelle: 'Beispielsatz des Prüfpakets', satzId: 'beispiel' },
  'Bemessung = steuerbare Bestandteile 6450 (Spesen nicht steuerbar); Quellensteuer 645.00; Netto 5524.25 − 645.00 = 4879.25',
  { brutto: 6450, sozialabzuege: 705.75, quellensteuer: 645, andereAbzuege: 300, spesenUndZahlungen: 80, netto: 4879.25, pruefungErforderlich: false },
);
abrechnungsFall(
  'A3',
  'Wie A1, Quellensteuerpflicht ohne eingelesenen Tarif: keine erfundene Zahl, sondern eine Prüfung',
  { status: 'KEIN_TARIF', tarif: 'A0N', kanton: 'BE', grund: 'Kein Tarif für BE A0N im Jahr 2026 eingelesen.' },
  'Quellensteuer 0 und pruefungErforderlich = true; Netto wie A1',
  { brutto: 6450, sozialabzuege: 705.75, quellensteuer: 0, andereAbzuege: 300, spesenUndZahlungen: 80, netto: 5524.25, pruefungErforderlich: true },
);

// ---------------------------------------------------------------------------
//  Abgleich und Ausgabe
// ---------------------------------------------------------------------------

const abweichungen: string[] = [];
for (const f of faelle) {
  for (const [feld, soll] of Object.entries(f.soll)) {
    if (f.ist[feld] !== soll) abweichungen.push(`${f.id} ${feld}: Handrechnung ${String(soll)}, Code ${String(f.ist[feld])}`);
  }
}

const paket = {
  $beschreibung:
    'Maschinenlesbares Prüfpaket der Lohnrechnung für die externe fachliche Prüfung (E-6). Erzeugt aus dem Code von scripts/lohn-pruefpaket.ts — nicht von Hand bearbeiten. Jeder Beispielfall trägt das Ergebnis des Codes (ist) und einen von Hand gerechneten Sollwert (soll) mit Rechenweg; das Skript scheitert, wenn beide abweichen. Alle Sätze sind Vorbelegung und UNGEPRUEFT: Die Prüfung bestätigt oder korrigiert sie.',
  stand: STAND,
  erzeugtVon: 'scripts/lohn-pruefpaket.ts',
  pruefen: 'npx tsx scripts/lohn-pruefpaket.ts --pruefen',
  offeneFachfragen: 'docs/PAYROLL.md §11',
  saetze: SAETZE,
  formeln: FORMELN,
  beispielfaelle: faelle,
};

const inhalt = `${JSON.stringify(paket, null, 2)}\n`;

if (abweichungen.length > 0) {
  console.error('Code und Handrechnung weichen ab — kein Prüfpaket geschrieben:');
  for (const a of abweichungen) console.error(`  ✗ ${a}`);
  process.exit(1);
}

if (process.argv.includes('--pruefen')) {
  let vorhanden = '';
  try {
    vorhanden = readFileSync(ZIEL, 'utf8');
  } catch {
    console.error(`${ZIEL} fehlt. Erzeugen mit: npx tsx scripts/lohn-pruefpaket.ts`);
    process.exit(1);
  }
  if (vorhanden !== inhalt) {
    console.error('docs/lohn/pruefpaket.json ist veraltet — Code, Sätze oder Beispielfälle haben sich geändert. Neu erzeugen: npx tsx scripts/lohn-pruefpaket.ts');
    process.exit(1);
  }
  console.log(`✓ Prüfpaket aktuell: ${SAETZE.length} Sätze, ${FORMELN.length} Formeln, ${faelle.length} Beispielfälle, Code = Handrechnung.`);
} else {
  mkdirSync(join(WURZEL, 'docs', 'lohn'), { recursive: true });
  writeFileSync(ZIEL, inhalt, 'utf8');
  console.log(`✓ docs/lohn/pruefpaket.json geschrieben: ${SAETZE.length} Sätze, ${FORMELN.length} Formeln, ${faelle.length} Beispielfälle, Code = Handrechnung.`);
}
