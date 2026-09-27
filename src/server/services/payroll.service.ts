import 'server-only';

import type { Prisma } from '@prisma/client';

import { audit } from '@/lib/audit';
import { toDateOnly, zurichMidnight } from '@/lib/bi/periods';
import { sha256Hex } from '@/lib/crypto';
import { isUniqueConstraintError, prisma, toNumber } from '@/lib/db';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { alterImJahr } from '@/lib/payroll/beitraege';
import {
  ermittleLohnteil,
  monatslohnAnteilig,
  schliesseAbrechnungAb,
  tageImMonat,
  werktage,
  type Abrechnung,
  type AbrechnungsEingabe,
  type DreizehnterGrundlage,
  type Lohnabschnitt,
  type Position,
  type QuellensteuerGrundlage,
} from '@/lib/payroll/lohnbestandteile';
import { renderPayslipPdf } from '@/lib/pdf/render';
import { deleteFile, readAssetBytes, uploadBuffer } from '@/lib/storage';
import { round2 } from '@/lib/utils';
import { alsZahl, geld, produkt, prozentVon, summe } from '@/lib/money';

import { letzterTagDesMonats, saetzeZumStichtag } from './payroll-rates.service';
import { VERALTET_PRAEFIX } from './payroll-veraltet';

const log = logger('payroll');

/**
 * Lohnabrechnung.
 *
 * ---------------------------------------------------------------------------
 *  Der Befund
 * ---------------------------------------------------------------------------
 *
 * `Payslip` stand seit der ersten Migration im Schema — samt Spalten für AHV,
 * ALV, BVG und UVG. **Es gab keinen Codepfad, der je eine Abrechnung erzeugt
 * hätte.** Wave 9 hat den Lauf gebaut; der Ausbau vom 2026-09-23 macht aus
 * zwei Zahlen (Brutto, Sozialabzüge) eine Abrechnung in Zeilen.
 *
 * ---------------------------------------------------------------------------
 *  Die Regeln
 * ---------------------------------------------------------------------------
 *
 * **Nur freigegebene Zeiten zählen.** Eine Lohnabrechnung, die offene Zeiten
 * mitnimmt, zahlt Stunden aus, die niemand geprüft hat.
 *
 * **Monatslohn nach Kalendertagen.** Eintritt am 20., Austritt am 10., eine
 * Lohnerhöhung am 16.: Jeder Tag zählt mit dem Lohn, der an ihm galt. Bis
 * 2026-09-23 zahlte der Lauf immer einen ganzen Monatslohn zum Stand des
 * Monatsletzten — und liess wer im Monat ausgetreten war (`active=false`)
 * ganz weg.
 *
 * **Eine veröffentlichte Abrechnung ist unveränderlich** — im Dienst, und seit
 * der Migration `20260923130000_lohn_ausbau` auch in der Datenbank (Trigger
 * auf Abrechnung, Zeilen und eingeflossenen Positionen). Korrekturen laufen
 * über eine Position in einem späteren Monat.
 *
 * **Sätze mit Herkunft.** Gerechnet wird mit den Satzversionen, die am
 * Monatsletzten gelten (`payroll-rates.service.ts`). Die Abrechnung merkt sich
 * deren Kennungen; ab dem Veröffentlichen sind diese Versionen gesperrt.
 * Ungeprüfte Sätze verhindern das Veröffentlichen nicht, verlangen aber eine
 * ausdrückliche Bestätigung.
 *
 * **Quellensteuer nie geraten.** Gerechnet wird sie nur aus einer eingelesenen
 * Tarifzeile oder von Hand. Fehlt beides bei einer quellensteuerpflichtigen
 * Person, wird die Abrechnung zur Prüfung markiert und lässt sich erst nach
 * dieser Prüfung veröffentlichen.
 *
 * **Idempotent je Person und Monat.** `@@unique([employeeId, year, month])`.
 * Ein zweiter Lauf schreibt die unveröffentlichten Abrechnungen neu und lässt
 * die veröffentlichten unberührt.
 */

// ---------------------------------------------------------------------------
//  Kalender
// ---------------------------------------------------------------------------

/**
 * Erster und erster **nicht mehr** zugehöriger Moment eines Abrechnungsmonats
 * — Mitternacht in Zürich, nicht in UTC.
 *
 * Bis 2026-09-23 stand hier UTC. Eine Schicht, die am 1. um 00:30 Ortszeit
 * begann, lag in UTC noch am letzten Tag des Vormonats und wurde dem falschen
 * Monat zugerechnet — für Nachtreinigung, die in diesem Gewerbe üblich ist,
 * kein Randfall.
 */
export function monatsfenster(year: number, month: number): { von: Date; bis: Date } {
  return {
    von: zurichMidnight(year, month - 1, 1),
    bis: zurichMidnight(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1),
  };
}

const tagDatum = (jahr: number, monat: number, tag: number) => new Date(Date.UTC(jahr, monat - 1, tag));

/**
 * Der Lohnstand, der **an einem Tag** galt — aus der Lohnhistorie.
 *
 * Die Historie (`SalaryRecord`, `validFrom`) wird bei jeder Lohnänderung
 * geschrieben und auch rückwirkend gepflegt; sie ist die Quelle. Ohne Eintrag
 * gilt der Satz der Personalakte — der Stand, bevor es eine Historie gab.
 */
function satzAm<T extends { validFrom: Date }>(historie: readonly T[], tag: Date): T | null {
  let treffer: T | null = null;
  for (const eintrag of historie) {
    if (eintrag.validFrom.getTime() <= tag.getTime()) treffer = eintrag;
  }
  return treffer;
}

interface Lohnstand {
  monthlySalary: Prisma.Decimal | null;
  hourlyRate: Prisma.Decimal | null;
  workloadPct: number;
}

function monatslohnVoll(stand: Lohnstand): number {
  return prozentVon(stand.monthlySalary, stand.workloadPct);
}

/** Angestellte Tage im Monat (1-basiert, einschliesslich) — oder `null`, wenn gar nicht angestellt. */
export function anstellungImMonat(
  hiredAt: Date,
  terminatedAt: Date | null,
  jahr: number,
  monat: number,
): { ersterTag: number; letzterTag: number } | null {
  const beginn = tagDatum(jahr, monat, 1);
  const ende = tagDatum(jahr, monat, tageImMonat(jahr, monat));
  if (hiredAt.getTime() > ende.getTime()) return null;
  if (terminatedAt && terminatedAt.getTime() < beginn.getTime()) return null;
  return {
    ersterTag: hiredAt.getTime() >= beginn.getTime() ? hiredAt.getUTCDate() : 1,
    letzterTag: terminatedAt && terminatedAt.getTime() <= ende.getTime() ? terminatedAt.getUTCDate() : tageImMonat(jahr, monat),
  };
}

// ---------------------------------------------------------------------------
//  Eingaben einer Abrechnung sammeln
// ---------------------------------------------------------------------------

type Akte = Prisma.EmployeeGetPayload<{
  select: {
    id: true;
    employeeNumber: true;
    birthday: true;
    hiredAt: true;
    terminatedAt: true;
    hourlyRate: true;
    monthlySalary: true;
    workloadPct: true;
    vacationDaysPerYear: true;
    salaryHistory: { select: { validFrom: true; hourlyRate: true; monthlySalary: true; workloadPct: true } };
    payrollProfile: true;
  };
}>;

const AKTE_SELECT = {
  id: true,
  employeeNumber: true,
  birthday: true,
  hiredAt: true,
  terminatedAt: true,
  hourlyRate: true,
  monthlySalary: true,
  workloadPct: true,
  vacationDaysPerYear: true,
  salaryHistory: {
    orderBy: { validFrom: 'asc' },
    select: { validFrom: true, hourlyRate: true, monthlySalary: true, workloadPct: true },
  },
  payrollProfile: true,
} satisfies Prisma.EmployeeSelect;

interface Grundlohn {
  eingabe: AbrechnungsEingabe['grundlohn'];
  stunden: number;
  erfassungen: number;
  offeneErfassungen: number;
  hochrechnungJahr: number;
  basis: 'HOURLY' | 'MONTHLY';
  monatslohnVollEnde: number | null;
}

/**
 * Grundlohn des Monats: Monatslohn anteilig nach Kalendertagen, Stundenlohn
 * aus freigegebenen Zeiten — und im Monat eines Wechsels beides.
 */
async function ermittleGrundlohn(
  akte: Akte,
  jahr: number,
  monat: number,
  anstellung: { ersterTag: number; letzterTag: number } | null,
): Promise<Grundlohn> {
  const akteStand: Lohnstand = { monthlySalary: akte.monthlySalary, hourlyRate: akte.hourlyRate, workloadPct: akte.workloadPct };
  const standAm = (tag: Date): Lohnstand => satzAm(akte.salaryHistory, tag) ?? akteStand;

  // Monatslohn in Abschnitten — ein neuer Abschnitt an jedem Tag, an dem die Historie wechselt.
  const abschnitte: Lohnabschnitt[] = [{ abTag: 1, monatslohnVoll: monatslohnVoll(standAm(tagDatum(jahr, monat, 1))) }];
  for (const eintrag of akte.salaryHistory) {
    if (eintrag.validFrom.getUTCFullYear() === jahr && eintrag.validFrom.getUTCMonth() + 1 === monat && eintrag.validFrom.getUTCDate() > 1) {
      abschnitte.push({ abTag: eintrag.validFrom.getUTCDate(), monatslohnVoll: monatslohnVoll(eintrag) });
    }
  }
  const monatlich = anstellung
    ? monatslohnAnteilig({ jahr, monat, abschnitte, ersterTag: anstellung.ersterTag, letzterTag: anstellung.letzterTag })
    : { betrag: 0, tage: 0, voll: false };

  // Zeiten -----------------------------------------------------------------
  const { von, bis } = monatsfenster(jahr, monat);
  const [freigegeben, offen] = await Promise.all([
    prisma.timeEntry.findMany({
      where: { employeeId: akte.id, approved: true, endedAt: { not: null }, startedAt: { gte: von, lt: bis } },
      select: { startedAt: true, minutes: true, hourlyRate: true },
    }),
    prisma.timeEntry.count({
      where: { employeeId: akte.id, approved: false, endedAt: { not: null }, startedAt: { gte: von, lt: bis } },
    }),
  ]);

  /*
    Minuten × Satz ÷ 60, dezimal und erst am Ende gerundet (Phase 25,
    2026-09-27). Vorher `minutes / 60` als Gleitkommazahl — 20 Minuten sind
    0.333…, binär nicht darstellbar — mal Satz, dann über alle Erfassungen
    summiert: Der Stundenlohn des Monats hing an der Reihenfolge der Addition.
  */
  let stunden = 0;
  let stundenBezahlt = 0;
  let stundenBetrag = geld(0);
  for (const e of freigegeben) {
    const h = (e.minutes ?? 0) / 60;
    stunden += h;
    /**
     * Der Tag einer Erfassung ist der **Zürcher** Kalendertag ihres Beginns.
     * An einem Tag mit Monatslohn sind die Stunden bereits bezahlt; sie
     * erscheinen nur als Menge.
     */
    const tag = toDateOnly(e.startedAt);
    const stand = standAm(tag);
    if (toNumber(stand.monthlySalary) > 0) continue;
    const ausHistorie = satzAm(akte.salaryHistory, tag)?.hourlyRate ?? null;
    stundenBezahlt += h;
    stundenBetrag = stundenBetrag.plus(geld(e.minutes ?? 0).times(geld(ausHistorie ?? e.hourlyRate ?? akte.hourlyRate)).dividedBy(60));
  }
  stunden = round2(stunden);
  const stundenlohn = alsZahl(stundenBetrag);

  const letzterTag = anstellung ? tagDatum(jahr, monat, anstellung.letzterTag) : letzterTagDesMonats(jahr, monat);
  const ende = standAm(letzterTag);
  const vollEnde = monatslohnVoll(ende);
  const mitDreizehntem = (akte.payrollProfile?.thirteenthMode ?? 'NONE') !== 'NONE';

  if (monatlich.betrag > 0) {
    return {
      eingabe: {
        art: 'MONTHLY',
        betrag: monatlich.betrag,
        tage: monatlich.tage,
        voll: monatlich.voll,
        monatslohnVoll: vollEnde > 0 ? vollEnde : Math.max(...abschnitte.map((a) => a.monatslohnVoll)),
        stundenAnteil: stundenlohn > 0 ? { betrag: stundenlohn, stunden: round2(stundenBezahlt) } : undefined,
      },
      stunden,
      erfassungen: freigegeben.length,
      offeneErfassungen: offen,
      /**
       * Jahreslohn für ALV-Grenze und BVG: der vertragliche Monatslohn zum
       * Monatsende mal 12 — mal 13, wenn ein 13. Monatslohn vereinbart ist,
       * weil er zum massgebenden Jahreslohn gehört.
       */
      hochrechnungJahr: produkt(vollEnde, mitDreizehntem ? 13 : 12),
      basis: 'MONTHLY',
      monatslohnVollEnde: vollEnde > 0 ? vollEnde : null,
    };
  }

  /**
   * Stundenlohn: Jahreshochrechnung mit dem vereinbarten Pensum auf eine
   * 42-Stunden-Woche, nicht `brutto × 12` — sonst spränge der koordinierte
   * Lohn und mit ihm der BVG-Abzug von Monat zu Monat. Eine Annahme, als
   * solche in der Herleitung festgehalten.
   */
  const satz = toNumber(ende.hourlyRate ?? akte.hourlyRate);
  return {
    eingabe: { art: 'HOURLY', betrag: stundenlohn, stunden: round2(stundenBezahlt) },
    stunden,
    erfassungen: freigegeben.length,
    offeneErfassungen: offen,
    // 42 Std. × Pensum × 52 Wochen × Satz — dezimal, gerundet einmal am Ende.
    hochrechnungJahr: alsZahl(geld(42 * 52).times(geld(ende.workloadPct)).dividedBy(100).times(geld(satz))),
    basis: 'HOURLY',
    monatslohnVollEnde: null,
  };
}

/** Bewilligter unbezahlter Urlaub in Werktagen innerhalb der Anstellung im Monat. */
async function unbezahlteTageIm(
  employeeId: string,
  jahr: number,
  monat: number,
  anstellung: { ersterTag: number; letzterTag: number },
): Promise<number> {
  const von = tagDatum(jahr, monat, anstellung.ersterTag);
  const bis = tagDatum(jahr, monat, anstellung.letzterTag);
  const abwesenheiten = await prisma.absence.findMany({
    where: { employeeId, type: 'UNPAID', status: 'APPROVED', startDate: { lte: bis }, endDate: { gte: von } },
    select: { startDate: true, endDate: true, halfDay: true },
  });
  let tage = 0;
  for (const a of abwesenheiten) {
    const beginn = a.startDate.getTime() > von.getTime() ? a.startDate : von;
    const ende = a.endDate.getTime() < bis.getTime() ? a.endDate : bis;
    tage += werktage(beginn, ende) * (a.halfDay ? 0.5 : 1);
  }
  return tage;
}

/** Was vom 13. Monatslohn in früheren Monaten schon geschehen ist. */
async function dreizehnterKontext(
  akte: Akte,
  jahr: number,
  monat: number,
  monatslohnVollEnde: number | null,
): Promise<DreizehnterGrundlage> {
  const profil = akte.payrollProfile;
  const art = profil?.thirteenthMode ?? 'NONE';
  const leer: DreizehnterGrundlage = {
    art,
    auszahlungsmonat: profil?.thirteenthPayoutMonth ?? 12,
    grundlohnBisherImJahr: 0,
    bereitsAusbezahlt: 0,
    monatslohnVoll: monatslohnVollEnde,
    anstellungstageImJahr: 0,
    tageImJahr: 0,
    austrittImMonat: false,
  };
  if (art === 'NONE') return leer;

  const frueher = await prisma.payslipLine.findMany({
    where: {
      payslip: { employeeId: akte.id, year: jahr, month: { lt: monat } },
      type: { in: ['BASE', 'UNPAID_LEAVE', 'THIRTEENTH'] },
    },
    select: { type: true, amount: true },
  });
  const grundlohn = summe(frueher.filter((z) => z.type !== 'THIRTEENTH').map((z) => z.amount)).toNumber();
  const bereits = summe(frueher.filter((z) => z.type === 'THIRTEENTH').map((z) => z.amount)).toNumber();

  const jahresbeginn = tagDatum(jahr, 1, 1);
  const jahresende = tagDatum(jahr, 12, 31);
  const beginn = akte.hiredAt.getTime() > jahresbeginn.getTime() ? akte.hiredAt : jahresbeginn;
  const ende = akte.terminatedAt && akte.terminatedAt.getTime() < jahresende.getTime() ? akte.terminatedAt : jahresende;
  const anstellungstage = Math.max(0, Math.round((ende.getTime() - beginn.getTime()) / 86_400_000) + 1);
  const tageImJahr = Math.round((jahresende.getTime() - jahresbeginn.getTime()) / 86_400_000) + 1;
  const austritt =
    akte.terminatedAt !== null && akte.terminatedAt.getUTCFullYear() === jahr && akte.terminatedAt.getUTCMonth() + 1 === monat;

  return {
    ...leer,
    grundlohnBisherImJahr: grundlohn,
    bereitsAusbezahlt: bereits,
    anstellungstageImJahr: anstellungstage,
    tageImJahr,
    austrittImMonat: austritt,
  };
}

/**
 * Quellensteuer: Profil zum Stichtag → Tarifzeile nach Bemessung.
 *
 * **Keine Zeile, kein Satz.** Die Tarife der Kantone sind umfangreich und
 * ändern jährlich; ein eingebauter Satz wäre ein erfundener. Ohne eingelesene
 * Zeile entsteht `KEIN_TARIF`, und die Abrechnung wartet auf eine Prüfung
 * oder eine von Hand erfasste Quellensteuer.
 */
async function quellensteuerFuer(
  organizationId: string,
  employeeId: string,
  jahr: number,
  stichtag: Date,
  bemessung: number,
): Promise<{ grundlage: QuellensteuerGrundlage; ungeprueft: boolean }> {
  const profil = await prisma.withholdingTaxProfile.findFirst({
    where: {
      organizationId,
      employeeId,
      validFrom: { lte: stichtag },
      OR: [{ validUntil: null }, { validUntil: { gte: stichtag } }],
    },
  });
  if (!profil || bemessung <= 0) return { grundlage: { status: 'KEINE' }, ungeprueft: false };

  const zeile = await prisma.withholdingTaxRate.findFirst({
    where: {
      organizationId,
      canton: profil.canton,
      year: jahr,
      tariffCode: profil.tariffCode,
      incomeFrom: { lte: bemessung },
      OR: [{ incomeTo: null }, { incomeTo: { gt: bemessung } }],
    },
    orderBy: { incomeFrom: 'desc' },
  });
  if (!zeile) {
    return {
      grundlage: {
        status: 'KEIN_TARIF',
        tarif: profil.tariffCode,
        kanton: profil.canton,
        grund:
          `Quellensteuerpflichtig (${profil.canton}, Tarif ${profil.tariffCode}), aber für ${jahr} ist keine Tarifzeile ` +
          `für ein steuerbares Einkommen von CHF ${bemessung.toFixed(2)} eingelesen. Tarif einlesen oder die ` +
          'Quellensteuer dieses Monats von Hand erfassen.',
      },
      ungeprueft: false,
    };
  }
  return {
    grundlage: {
      status: 'SATZ',
      satzPct: toNumber(zeile.ratePct),
      tarif: profil.tariffCode,
      kanton: profil.canton,
      quelle: zeile.source,
      satzId: zeile.id,
    },
    ungeprueft: zeile.verification !== 'GEPRUEFT',
  };
}

// ---------------------------------------------------------------------------
//  Abrechnen
// ---------------------------------------------------------------------------

export interface AbrechnungsErgebnis {
  employeeId: string;
  employeeNumber: string;
  payslipId?: string;
  status: 'ERSTELLT' | 'AKTUALISIERT' | 'UEBERSPRUNGEN';
  grund?: string;
  brutto?: number;
  netto?: number;
  offeneErfassungen?: number;
  pruefungErforderlich?: boolean;
}

class InzwischenVeroeffentlicht extends Error {}

/**
 * Abrechnungen für einen Monat erzeugen.
 *
 * Läuft über alle Personen, die im Monat angestellt waren — **auch die im
 * Monat ausgetretenen** — sowie über jede Person mit offenen Lohnpositionen
 * dieses Monats (eine Korrektur nach dem Austritt). **Wirft für eine einzelne
 * Person nicht**, sondern meldet sie als übersprungen.
 */
export async function generatePayslips(params: {
  organizationId: string;
  year: number;
  month: number;
  employeeIds?: string[];
  actorId: string;
  ip?: string | null;
}): Promise<{
  jahr: number;
  monat: number;
  saetzeGeprueft: boolean;
  ungepruefteSaetze: string[];
  ergebnisse: AbrechnungsErgebnis[];
}> {
  if (params.month < 1 || params.month > 12) {
    throw new BusinessRuleError('Der Monat muss zwischen 1 und 12 liegen.');
  }

  /**
   * Ein Monat, der noch läuft, wird nicht abgerechnet. Am 12. „schon mal
   * schauen" ergäbe etwas, das wie eine Abrechnung aussieht und um zwei
   * Drittel zu tief ist.
   */
  const { bis } = monatsfenster(params.year, params.month);
  if (bis.getTime() > Date.now()) {
    throw new BusinessRuleError(
      `Der Monat ${String(params.month).padStart(2, '0')}/${params.year} ist noch nicht abgeschlossen. ` +
        'Abgerechnet wird nach dem Monatsende.',
    );
  }

  const monatsbeginn = tagDatum(params.year, params.month, 1);
  const monatsende = letzterTagDesMonats(params.year, params.month);
  const saetze = await saetzeZumStichtag(params.organizationId, monatsende);

  const akten = await prisma.employee.findMany({
    where: {
      organizationId: params.organizationId,
      ...(params.employeeIds?.length ? { id: { in: params.employeeIds } } : {}),
      OR: [
        {
          hiredAt: { lte: monatsende },
          OR: [{ terminatedAt: null }, { terminatedAt: { gte: monatsbeginn } }],
          // Eine inaktive Akte ohne Austrittsdatum ist ein Altbestand — nicht abrechnen.
          AND: [{ OR: [{ active: true }, { terminatedAt: { not: null } }] }],
        },
        { payrollItems: { some: { year: params.year, month: params.month, deletedAt: null, payslipId: null } } },
      ],
    },
    select: AKTE_SELECT,
    orderBy: { employeeNumber: 'asc' },
  });

  const ergebnisse: AbrechnungsErgebnis[] = [];
  for (const akte of akten) {
    try {
      ergebnisse.push(await abrechnenFuer(params, akte, saetze));
    } catch (fehler) {
      if (fehler instanceof InzwischenVeroeffentlicht) {
        ergebnisse.push({
          employeeId: akte.id,
          employeeNumber: akte.employeeNumber,
          status: 'UEBERSPRUNGEN',
          grund: 'Inzwischen veröffentlicht — eine veröffentlichte Abrechnung ist unveränderlich.',
        });
        continue;
      }
      if (isUniqueConstraintError(fehler)) {
        ergebnisse.push({
          employeeId: akte.id,
          employeeNumber: akte.employeeNumber,
          status: 'UEBERSPRUNGEN',
          grund: 'Ein gleichzeitiger Lauf hat diese Abrechnung eben erzeugt.',
        });
        continue;
      }
      throw fehler;
    }
  }

  await audit.created({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Payslip',
    summary:
      `Lohnlauf ${String(params.month).padStart(2, '0')}/${params.year}: ` +
      `${ergebnisse.filter((e) => e.status !== 'UEBERSPRUNGEN').length} Abrechnung(en), ` +
      `${ergebnisse.filter((e) => e.status === 'UEBERSPRUNGEN').length} übersprungen` +
      (saetze.ungeprueft.length > 0 ? `; ungeprüfte Sätze: ${saetze.ungeprueft.join(', ')}` : ''),
    ip: params.ip,
  });

  return {
    jahr: params.year,
    monat: params.month,
    saetzeGeprueft: saetze.ungeprueft.length === 0,
    ungepruefteSaetze: saetze.ungeprueft,
    ergebnisse,
  };
}

async function abrechnenFuer(
  params: { organizationId: string; year: number; month: number; actorId: string },
  akte: Akte,
  saetze: Awaited<ReturnType<typeof saetzeZumStichtag>>,
): Promise<AbrechnungsErgebnis> {
  const { year: jahr, month: monat } = params;
  const vorhanden = await prisma.payslip.findUnique({
    where: { employeeId_year_month: { employeeId: akte.id, year: jahr, month: monat } },
    select: { id: true, published: true },
  });
  if (vorhanden?.published) {
    return {
      employeeId: akte.id,
      employeeNumber: akte.employeeNumber,
      payslipId: vorhanden.id,
      status: 'UEBERSPRUNGEN',
      grund: 'Bereits veröffentlicht — eine veröffentlichte Abrechnung ist unveränderlich.',
    };
  }

  const anstellung = anstellungImMonat(akte.hiredAt, akte.terminatedAt, jahr, monat);
  const grundlohn = await ermittleGrundlohn(akte, jahr, monat, anstellung);
  const unbezahlt = anstellung && grundlohn.basis === 'MONTHLY' ? await unbezahlteTageIm(akte.id, jahr, monat, anstellung) : 0;

  const positionenRoh = await prisma.payrollItem.findMany({
    where: {
      organizationId: params.organizationId,
      employeeId: akte.id,
      year: jahr,
      month: monat,
      deletedAt: null,
      OR: [{ payslipId: null }, ...(vorhanden ? [{ payslipId: vorhanden.id }] : [])],
    },
    orderBy: { createdAt: 'asc' },
  });
  const positionen: Position[] = positionenRoh.map((p) => ({
    id: p.id,
    type: p.type,
    label: p.label,
    quantity: p.quantity === null ? null : toNumber(p.quantity),
    rate: p.rate === null ? null : toNumber(p.rate),
    surchargePct: p.surchargePct === null ? null : toNumber(p.surchargePct),
    amount: toNumber(p.amount),
  }));

  const profil = akte.payrollProfile;
  const eingabe: AbrechnungsEingabe = {
    jahr,
    monat,
    grundlohn: grundlohn.eingabe,
    unbezahlteTage: unbezahlt,
    werktageImMonat: werktage(tagDatum(jahr, monat, 1), letzterTagDesMonats(jahr, monat)),
    positionen,
    ferienImLohn: profil?.vacationPayInWage ?? false,
    ferientageJeJahr: toNumber(akte.vacationDaysPerYear),
    feiertagsanteilPct: profil?.holidayPayPct ? toNumber(profil.holidayPayPct) : null,
    dreizehnter: await dreizehnterKontext(akte, jahr, monat, grundlohn.monatslohnVollEnde),
    saetze: saetze.saetze,
    arbeitgeber: saetze.arbeitgeber,
    alter: alterImJahr(akte.birthday, jahr),
    bruttoJahrHochrechnung: grundlohn.hochrechnungJahr,
  };

  const teil = ermittleLohnteil(eingabe);
  const stichtag = anstellung ? tagDatum(jahr, monat, anstellung.letzterTag) : letzterTagDesMonats(jahr, monat);
  const qst = await quellensteuerFuer(params.organizationId, akte.id, jahr, stichtag, teil.quellensteuerBemessung);
  const abrechnung = schliesseAbrechnungAb(eingabe, teil, qst.grundlage);

  if (abrechnung.brutto <= 0 && abrechnung.spesenUndZahlungen === 0 && positionen.length === 0) {
    return {
      employeeId: akte.id,
      employeeNumber: akte.employeeNumber,
      status: 'UEBERSPRUNGEN',
      grund:
        grundlohn.basis === 'HOURLY'
          ? grundlohn.offeneErfassungen > 0
            ? `Kein freigegebener Lohn — ${grundlohn.offeneErfassungen} Erfassung(en) warten auf Freigabe.`
            : 'Keine freigegebenen Stunden in diesem Monat.'
          : 'Kein Lohn hinterlegt.',
      offeneErfassungen: grundlohn.offeneErfassungen,
    };
  }

  const pruefgruende: string[] = [];
  if (abrechnung.pruefungErforderlich && abrechnung.pruefungsgrund) pruefgruende.push(abrechnung.pruefungsgrund);
  if (abrechnung.netto < 0) {
    pruefgruende.push(`Die Auszahlung wäre negativ (CHF ${abrechnung.netto.toFixed(2)}) — Abzüge übersteigen den Lohn.`);
  }

  const payslipId = await schreibeAbrechnung({
    vorhandenId: vorhanden?.id ?? null,
    employeeId: akte.id,
    jahr,
    monat,
    actorId: params.actorId,
    abrechnung,
    stunden: grundlohn.stunden,
    basis: grundlohn.basis,
    rateVersionIds: saetze.versionIds,
    unverifiedRates: saetze.ungeprueft.length > 0 || qst.ungeprueft,
    pruefgrund: pruefgruende.length > 0 ? pruefgruende.join(' ') : null,
    itemIds: positionen.map((p) => p.id),
    herleitung: {
      ...abrechnung.herleitung,
      saetze: saetze.saetze,
      satzversionen: saetze.momentaufnahme,
      alter: eingabe.alter,
      erfassungen: grundlohn.erfassungen,
      offeneErfassungen: grundlohn.offeneErfassungen,
      hochrechnungJahr: grundlohn.hochrechnungJahr,
      anstellung,
      arbeitgeber: abrechnung.arbeitgeber,
      quellensteuerSatzUngeprueft: qst.ungeprueft,
    },
  });

  return {
    employeeId: akte.id,
    employeeNumber: akte.employeeNumber,
    payslipId,
    status: vorhanden ? 'AKTUALISIERT' : 'ERSTELLT',
    brutto: abrechnung.brutto,
    netto: abrechnung.netto,
    offeneErfassungen: grundlohn.offeneErfassungen,
    pruefungErforderlich: pruefgruende.length > 0,
  };
}

/**
 * Abrechnung, Zeilen und Positionsverknüpfung in **einer** Transaktion.
 *
 * **Nie über eine veröffentlichte Abrechnung.** `published: false` steht in
 * der Bedingung des Schreibens selbst; trifft es keine Zeile, hat jemand
 * anderes gerade veröffentlicht. Die Zeilen werden ersetzt, nicht ergänzt —
 * ein zweiter Lauf ergibt dieselbe Abrechnung, nicht eine doppelte.
 *
 * Eine Neuberechnung setzt eine frühere Prüffreigabe zurück: Geprüft wurde
 * eine andere Zahl.
 */
async function schreibeAbrechnung(p: {
  vorhandenId: string | null;
  employeeId: string;
  jahr: number;
  monat: number;
  actorId: string;
  abrechnung: Abrechnung;
  stunden: number;
  basis: 'HOURLY' | 'MONTHLY';
  rateVersionIds: string[];
  unverifiedRates: boolean;
  pruefgrund: string | null;
  itemIds: string[];
  herleitung: Record<string, unknown>;
}): Promise<string> {
  const a = p.abrechnung;
  const daten = {
    hours: p.stunden,
    grossPay: a.brutto,
    ahvIv: a.beitraege.ahvIv,
    alv: a.beitraege.alv,
    bvg: a.beitraege.bvg,
    uvg: a.beitraege.uvg,
    ktg: a.beitraege.ktg,
    otherDeductions: a.andereAbzuege,
    withholdingTax: a.quellensteuer,
    expenses: a.spesenUndZahlungen,
    employerContributions: a.arbeitgeber.summe,
    netPay: a.netto,
    basis: p.basis,
    createdById: p.actorId,
    rateVersionIds: p.rateVersionIds,
    unverifiedRates: p.unverifiedRates,
    reviewRequired: p.pruefgrund !== null,
    reviewReason: p.pruefgrund,
    reviewResolvedAt: null,
    reviewResolvedById: null,
    reviewNote: null,
    /**
     * Die Herleitung als Momentaufnahme. Der Umweg über `unknown` ist nötig,
     * weil `InputJsonValue` eine rekursive Vereinigung ist, in die TypeScript
     * ein Objektliteral mit optionalen Feldern nicht direkt einordnet; der
     * Inhalt ist nachweislich Json.
     */
    breakdown: p.herleitung as unknown as Prisma.InputJsonValue,
  };

  return prisma.$transaction(async (tx) => {
    let id: string;
    if (p.vorhandenId) {
      const geaendert = await tx.payslip.updateMany({ where: { id: p.vorhandenId, published: false }, data: daten });
      if (geaendert.count === 0) throw new InzwischenVeroeffentlicht();
      id = p.vorhandenId;
      await tx.payslipLine.deleteMany({ where: { payslipId: id } });
      await tx.payrollItem.updateMany({ where: { payslipId: id }, data: { payslipId: null } });
    } else {
      id = (
        await tx.payslip.create({
          data: { employeeId: p.employeeId, year: p.jahr, month: p.monat, ...daten },
          select: { id: true },
        })
      ).id;
    }
    await tx.payslipLine.createMany({
      data: a.zeilen.map((z, i) => ({
        payslipId: id,
        position: i + 1,
        type: z.type,
        kind: z.kind,
        label: z.label,
        quantity: z.quantity,
        rate: z.rate,
        amount: z.amount,
        taxable: z.taxable,
        certificateField: z.certificateField,
        sourceItemId: z.sourceItemId,
      })),
    });
    if (p.itemIds.length > 0) {
      await tx.payrollItem.updateMany({ where: { id: { in: p.itemIds }, payslipId: null }, data: { payslipId: id } });
    }
    return id;
  });
}

// ---------------------------------------------------------------------------
//  Prüfung
// ---------------------------------------------------------------------------

/**
 * Eine zur Prüfung markierte Abrechnung freigeben — mit Notiz. Die Freigabe
 * sagt: „Die Zahl ist so gewollt" (etwa: die Quellensteuer wird diesen Monat
 * ausserhalb abgerechnet). Sie ändert keinen Betrag.
 */
export async function resolvePayslipReview(params: {
  organizationId: string;
  payslipId: string;
  actorId: string;
  note: string;
  ip?: string | null;
}) {
  const abrechnung = await prisma.payslip.findFirst({
    where: { id: params.payslipId, employee: { organizationId: params.organizationId } },
    select: { id: true, published: true, reviewRequired: true, reviewReason: true, year: true, month: true },
  });
  if (!abrechnung) throw new NotFoundError('Lohnabrechnung');
  if (abrechnung.published) throw new BusinessRuleError('Die Abrechnung ist bereits veröffentlicht.');
  if (!abrechnung.reviewRequired) throw new BusinessRuleError('Diese Abrechnung ist nicht zur Prüfung markiert.');
  if (abrechnung.reviewReason?.startsWith(VERALTET_PRAEFIX)) {
    throw new BusinessRuleError('Die Grundlagen haben sich seit der Berechnung geändert. Bitte den Monat neu rechnen statt freigeben.');
  }

  const geaendert = await prisma.payslip.updateMany({
    where: { id: abrechnung.id, published: false, reviewRequired: true },
    data: { reviewResolvedAt: new Date(), reviewResolvedById: params.actorId, reviewNote: params.note },
  });
  if (geaendert.count === 0) throw new BusinessRuleError('Die Abrechnung hat sich eben geändert — bitte neu laden.');

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Payslip',
    entityId: abrechnung.id,
    summary: `Prüfung der Lohnabrechnung ${String(abrechnung.month).padStart(2, '0')}/${abrechnung.year} freigegeben`,
    ip: params.ip,
  });
  return { id: abrechnung.id, reviewResolved: true };
}

// ---------------------------------------------------------------------------
//  Veröffentlichen
// ---------------------------------------------------------------------------

export interface VeroeffentlichungsErgebnis {
  veroeffentlicht: number;
  uebersprungen: number;
  gruende: { payslipId: string; grund: string }[];
}

/**
 * Abrechnungen veröffentlichen.
 *
 * Damit werden sie für die angestellte Person sichtbar und **unveränderlich**
 * — dieselbe Schwelle wie beim Ausstellen einer Rechnung. Ein `unpublish`
 * gibt es bewusst nicht.
 *
 * **Das PDF entsteht hier, einmal.** Aus den Zeilen der Abrechnung gerendert,
 * abgelegt (Bereich `PAYROLL`, nicht öffentlich) und mit Prüfsumme an die
 * Abrechnung gehängt — im selben bedingten Schreiben, das veröffentlicht.
 * Beim Herunterladen wird nichts neu gerechnet.
 *
 * **Die Bedingung enthält `updatedAt`.** Ein Nachlauf zwischen dem Lesen der
 * Zeilen und dem Veröffentlichen hätte sonst ein PDF der alten Zeilen an eine
 * Abrechnung mit neuen Zeilen gehängt.
 */
export async function publishPayslips(params: {
  organizationId: string;
  payslipIds: string[];
  actorId: string;
  trotzUngepruefterSaetze?: boolean;
  ip?: string | null;
}): Promise<VeroeffentlichungsErgebnis> {
  const kandidaten = await prisma.payslip.findMany({
    where: { id: { in: params.payslipIds }, employee: { organizationId: params.organizationId } },
    include: {
      lines: { orderBy: { position: 'asc' } },
      employee: {
        select: {
          employeeNumber: true,
          street: true,
          postalCode: true,
          city: true,
          user: { select: { firstName: true, lastName: true } },
        },
      },
    },
  });

  const offen = kandidaten.filter((k) => !k.published);
  const ungeprueft = offen.filter((k) => k.unverifiedRates);
  if (ungeprueft.length > 0 && !params.trotzUngepruefterSaetze) {
    throw new BusinessRuleError(
      `${ungeprueft.length} Abrechnung(en) wurden mit ungeprüften Beitragssätzen gerechnet. ` +
        'Sätze fachlich bestätigen und neu rechnen — oder das Veröffentlichen ausdrücklich bestätigen.',
    );
  }

  const gruende: { payslipId: string; grund: string }[] = kandidaten
    .filter((k) => k.published)
    .map((k) => ({ payslipId: k.id, grund: 'Bereits veröffentlicht.' }));
  let veroeffentlicht = 0;

  for (const k of offen) {
    if (k.reviewRequired && !k.reviewResolvedAt) {
      gruende.push({ payslipId: k.id, grund: `Prüfung ausstehend: ${k.reviewReason ?? 'ohne Begründung'}` });
      continue;
    }
    if (k.lines.length === 0) {
      gruende.push({ payslipId: k.id, grund: 'Die Abrechnung hat keine Zeilen — bitte den Monat neu rechnen.' });
      continue;
    }

    const jetzt = new Date();
    const bytes = await renderPayslipPdf(params.organizationId, {
      person: {
        name: `${k.employee.user.firstName} ${k.employee.user.lastName}`,
        employeeNumber: k.employee.employeeNumber,
        street: k.employee.street,
        postalCode: k.employee.postalCode,
        city: k.employee.city,
      },
      year: k.year,
      month: k.month,
      publishedAt: jetzt,
      lines: k.lines.map((z) => ({
        kind: z.kind,
        label: z.label,
        quantity: z.quantity === null ? null : toNumber(z.quantity),
        rate: z.rate === null ? null : toNumber(z.rate),
        amount: toNumber(z.amount),
      })),
      grossPay: toNumber(k.grossPay),
      netPay: toNumber(k.netPay),
      hours: toNumber(k.hours),
      unverifiedRates: k.unverifiedRates,
    });
    const { assetId, checksum } = await lohnPdfAblegen({
      organizationId: params.organizationId,
      pfadOhneEndung: `${params.organizationId}/payroll/payslips/${k.id}`,
      filename: `Lohnabrechnung-${k.year}-${String(k.month).padStart(2, '0')}-${k.employee.employeeNumber}.pdf`,
      bytes,
    });

    const treffer = await prisma.payslip.updateMany({
      where: { id: k.id, published: false, updatedAt: k.updatedAt },
      data: { published: true, publishedAt: jetzt, pdfFileId: assetId, pdfChecksum: checksum },
    });
    if (treffer.count === 0) {
      // Verloren — die eigene, nie referenzierte Fassung wieder wegräumen.
      // Die des Gewinners liegt unter einem anderen Pfad und bleibt unberührt.
      await lohnPdfVerwerfen(params.organizationId, assetId);
      gruende.push({ payslipId: k.id, grund: 'Die Abrechnung hat sich während des Veröffentlichens geändert — bitte erneut versuchen.' });
      continue;
    }
    veroeffentlicht += 1;
  }

  if (veroeffentlicht > 0) {
    await audit.updated({
      organizationId: params.organizationId,
      userId: params.actorId,
      entity: 'Payslip',
      summary:
        `${veroeffentlicht} Lohnabrechnung(en) veröffentlicht` +
        (ungeprueft.length > 0 ? ' — mit ausdrücklicher Bestätigung ungeprüfter Sätze' : ''),
      changes: { payslipIds: offen.map((k) => k.id) },
      ip: params.ip,
    });
  }

  return { veroeffentlicht, uebersprungen: kandidaten.length - veroeffentlicht, gruende };
}

/**
 * Ein erzeugtes Lohndokument ablegen und als privates `FileAsset` im Bereich
 * `PAYROLL` registrieren — dasselbe Muster wie die Signaturartefakte.
 *
 * `uploadedById` bleibt leer: Wer ein Asset „hochgeladen" hat, darf es über
 * den allgemeinen Dateiweg lesen. Hier hat niemand hochgeladen; der Zugriff
 * entscheidet sich allein an `payslip:read_all` bzw. an der eigenen Abrechnung.
 */
export async function lohnPdfAblegen(p: {
  organizationId: string;
  /** Pfad ohne Endung; die Prüfsumme wird angehängt — jede Fassung hat ihren eigenen. */
  pfadOhneEndung: string;
  filename: string;
  bytes: Buffer;
}): Promise<{ assetId: string; checksum: string }> {
  /*
    Unveränderlich ablegen (2026-09-27). Bis dahin lag jede Fassung unter
    demselben Pfad, mit `upsert`, und das bestehende Asset wurde
    überschrieben — **bevor** das Veröffentlichen gewonnen war. Zwei
    gleichzeitige Veröffentlichungen schrieben nacheinander dieselbe Datei;
    die Abrechnung trug danach die Prüfsumme des Gewinners und die Bytes des
    Verlierers und liess sich nie wieder herunterladen („stimmt nicht mit der
    veröffentlichten Fassung überein"). Jetzt: eigener Pfad je Inhalt, nie
    überschreiben, immer ein neues Asset. Referenziert wird nur, was das
    Veröffentlichen gewinnt; der Verlierer räumt seine Fassung weg.
  */
  const checksum = sha256Hex(p.bytes);
  const path = `${p.pfadOhneEndung}-${checksum.slice(0, 16)}.pdf`;
  const stored = await uploadBuffer({
    organizationId: p.organizationId,
    path,
    content: p.bytes,
    contentType: 'application/pdf',
    upsert: false,
  });
  const asset = await prisma.fileAsset.create({
    data: {
      organizationId: p.organizationId,
      scope: 'PAYROLL',
      path,
      // Beim externen Speicher der Pfad, nicht die öffentliche Adresse: Eine
      // Lohnabrechnung ist privat, und eine gespeicherte öffentliche Adresse
      // wäre eine Einladung, den Behälter einmal falsch einzustellen.
      url: stored.storedFileId ? stored.publicUrl : path,
      filename: p.filename,
      mimeType: 'application/pdf',
      sizeBytes: p.bytes.byteLength,
      checksum,
      isPublic: false,
      storedFileId: stored.storedFileId ?? null,
      uploadedById: null,
      // Aus dem eigenen Renderer und eigenen Daten — kein fremder Inhalt.
      provenance: 'SYSTEM_GENERATED',
    },
    select: { id: true },
  });
  return { assetId: asset.id, checksum };
}

/** Eine nie referenzierte Fassung wegräumen — nur wenn nichts auf sie zeigt. */
export async function lohnPdfVerwerfen(organizationId: string, assetId: string): Promise<void> {
  const asset = await prisma.fileAsset.findFirst({ where: { id: assetId, organizationId, scope: 'PAYROLL' }, select: { id: true, path: true } });
  if (!asset) return;
  const verwendet =
    (await prisma.payslip.count({ where: { pdfFileId: asset.id } })) +
    (await prisma.salaryCertificate.count({ where: { pdfFileId: asset.id } }));
  if (verwendet > 0) return;
  await prisma.fileAsset.delete({ where: { id: asset.id } });
  await deleteFile(asset.path).catch((error) => log.warn('Verworfene Lohnfassung liess sich nicht löschen', { error }));
}

/** Die gespeicherten Bytes eines Lohndokuments — mit Prüfsummenvergleich. */
export async function lohnPdfLesen(organizationId: string, assetId: string, erwartet: string | null): Promise<Buffer> {
  const asset = await prisma.fileAsset.findFirst({
    where: { id: assetId, organizationId, scope: 'PAYROLL' },
    select: { url: true, path: true, storedFile: { select: { id: true, path: true, driver: true } } },
  });
  if (!asset) throw new NotFoundError('Dokument');
  // Ein Weg für beide Treiber (`readAssetBytes`) — vorher nur lokal lesbar.
  const bytes = await readAssetBytes(asset);
  if (!bytes) throw new NotFoundError('Dokument');
  /**
   * Weicht die Prüfsumme ab, wird **nicht** ausgeliefert. Eine veränderte
   * Lohnabrechnung, die ausgeliefert wird, als wäre sie die veröffentlichte,
   * ist schlimmer als ein Fehler, der gemeldet wird.
   */
  if (erwartet && sha256Hex(bytes) !== erwartet) {
    log.error('Prüfsumme eines Lohndokuments weicht ab', { assetId });
    throw new BusinessRuleError('Das gespeicherte Dokument stimmt nicht mit der veröffentlichten Fassung überein.');
  }
  return bytes;
}

/**
 * Das PDF einer veröffentlichten Abrechnung. Wer nur die eigenen sehen darf,
 * übergibt `employeeId`; die Bedingung steht in der Abfrage.
 */
export async function getPayslipPdf(params: {
  organizationId: string;
  payslipId: string;
  employeeId?: string;
  actorId: string;
  ip?: string | null;
}): Promise<{ bytes: Buffer; filename: string }> {
  const abrechnung = await prisma.payslip.findFirst({
    where: {
      id: params.payslipId,
      published: true,
      employee: { organizationId: params.organizationId, ...(params.employeeId ? { id: params.employeeId } : {}) },
    },
    select: { id: true, year: true, month: true, pdfFileId: true, pdfChecksum: true, employee: { select: { employeeNumber: true } } },
  });
  if (!abrechnung || !abrechnung.pdfFileId) throw new NotFoundError('Lohnabrechnung');
  const bytes = await lohnPdfLesen(params.organizationId, abrechnung.pdfFileId, abrechnung.pdfChecksum);
  await audit.exported({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Payslip',
    entityId: abrechnung.id,
    summary: `Lohnabrechnung ${String(abrechnung.month).padStart(2, '0')}/${abrechnung.year} als PDF abgerufen`,
    ip: params.ip,
  });
  return {
    bytes,
    filename: `Lohnabrechnung-${abrechnung.year}-${String(abrechnung.month).padStart(2, '0')}-${abrechnung.employee.employeeNumber}.pdf`,
  };
}

// ---------------------------------------------------------------------------
//  Lesen
// ---------------------------------------------------------------------------

export async function listPayslips(params: {
  organizationId: string;
  year?: number;
  month?: number;
  employeeId?: string;
  published?: boolean;
}) {
  const where: Prisma.PayslipWhereInput = {
    employee: { organizationId: params.organizationId },
    ...(params.year ? { year: params.year } : {}),
    ...(params.month ? { month: params.month } : {}),
    ...(params.employeeId ? { employeeId: params.employeeId } : {}),
    ...(params.published !== undefined ? { published: params.published } : {}),
  };

  const [eintraege, summe] = await prisma.$transaction([
    prisma.payslip.findMany({
      where,
      orderBy: [{ year: 'desc' }, { month: 'desc' }, { employeeId: 'asc' }],
      take: 500,
      select: {
        id: true,
        year: true,
        month: true,
        hours: true,
        grossPay: true,
        ahvIv: true,
        alv: true,
        bvg: true,
        uvg: true,
        ktg: true,
        otherDeductions: true,
        withholdingTax: true,
        expenses: true,
        employerContributions: true,
        netPay: true,
        basis: true,
        published: true,
        publishedAt: true,
        unverifiedRates: true,
        reviewRequired: true,
        reviewReason: true,
        reviewResolvedAt: true,
        pdfFileId: true,
        employee: {
          select: { id: true, employeeNumber: true, user: { select: { firstName: true, lastName: true } } },
        },
      },
    }),
    prisma.payslip.aggregate({ where, _sum: { grossPay: true, netPay: true, employerContributions: true } }),
  ]);

  return {
    eintraege,
    summeBrutto: toNumber(summe._sum.grossPay),
    summeNetto: toNumber(summe._sum.netPay),
    summeArbeitgeber: toNumber(summe._sum.employerContributions),
  };
}

/**
 * Eine einzelne Abrechnung samt Zeilen und Herleitung.
 *
 * Wer die eigene Abrechnung liest, sieht nur veröffentlichte. Eine
 * unveröffentlichte ist ein Entwurf — sie kann sich noch ändern, und eine
 * Zahl, die sich ändert, nachdem sie jemand gesehen hat, ist schlimmer als
 * keine Zahl.
 */
export async function getPayslip(params: {
  organizationId: string;
  payslipId: string;
  /** Wenn gesetzt, muss die Abrechnung zu dieser Personalakte gehören. */
  employeeId?: string;
}) {
  const payslip = await prisma.payslip.findFirst({
    where: {
      id: params.payslipId,
      employee: {
        organizationId: params.organizationId,
        ...(params.employeeId ? { id: params.employeeId } : {}),
      },
      ...(params.employeeId ? { published: true } : {}),
    },
    include: {
      lines: { orderBy: { position: 'asc' } },
      employee: {
        select: { id: true, employeeNumber: true, user: { select: { firstName: true, lastName: true } } },
      },
    },
  });

  if (!payslip) throw new NotFoundError('Lohnabrechnung');
  return payslip;
}
