import 'server-only';

import type { Prisma } from '@prisma/client';

import { audit } from '@/lib/audit';
import { zurichMidnight } from '@/lib/bi/periods';
import { isUniqueConstraintError, prisma, toNumber } from '@/lib/db';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import {
  SAETZE_2026,
  alterImJahr,
  berechneBeitraege,
  rappen,
  type BeitragsSaetze,
} from '@/lib/payroll/beitraege';
import { round2 } from '@/lib/utils';
import type { PayrollSettingsInput } from '@/lib/validation/payroll';

/**
 * Lohnabrechnung.
 *
 * ---------------------------------------------------------------------------
 *  Der Befund
 * ---------------------------------------------------------------------------
 *
 * `Payslip` stand seit der ersten Migration im Schema — samt Spalten für AHV,
 * ALV, BVG und UVG. Zwei Seiten lesen daraus (`/portal/lohn` und die
 * Personalakte), `payslip:create` ist an Rollen vergeben.
 *
 * **Es gab keinen Codepfad, der je eine Abrechnung erzeugt hätte.** Dasselbe
 * Muster wie bei den Automatisierungen und der Zeiterfassung: Felder und
 * Berechtigungen, die eine Zusage machen, die das System nicht einlöst.
 *
 * ---------------------------------------------------------------------------
 *  Die Regeln
 * ---------------------------------------------------------------------------
 *
 * **Nur freigegebene Zeiten zählen.** Das ist der Ertrag aus Wave 8 und die
 * wichtigste Regel dieses Dienstes: Eine Lohnabrechnung, die offene Zeiten
 * mitnimmt, zahlt Stunden aus, die niemand geprüft hat. Wer den Monat
 * abrechnen will, gibt vorher frei — die Reihenfolge ist keine Bequemlichkeit,
 * sondern die Kontrolle.
 *
 * **Eine veröffentlichte Abrechnung ist unveränderlich.** Sie ist bei der
 * angestellten Person angekommen und Grundlage der Auszahlung — dieselbe
 * Überlegung wie bei einer ausgestellten Rechnung. Korrekturen laufen über
 * eine Abrechnung des Folgemonats, nicht über eine stille Änderung.
 *
 * **Die Sätze werden als Momentaufnahme mitgeschrieben.** `breakdown` enthält
 * die angewandten Sätze, den koordinierten Jahreslohn und den
 * BVG-Altersband-Satz. Ändert sich ein Satz im nächsten Jahr, bleibt die alte
 * Abrechnung nachvollziehbar — dieselbe Überlegung wie bei der
 * Empfängeradresse einer Rechnung.
 *
 * **Idempotent je Person und Monat.** `@@unique([employeeId, year, month])`.
 * Ein zweiter Lauf über denselben Monat überschreibt die noch nicht
 * veröffentlichten Abrechnungen mit dem aktuellen Stand und lässt die
 * veröffentlichten unberührt.
 */

// ---------------------------------------------------------------------------
//  Sätze
// ---------------------------------------------------------------------------

function alsSaetze(zeile: {
  ahvIvEo: Prisma.Decimal;
  alv: Prisma.Decimal;
  alvGrenzeJahr: Prisma.Decimal;
  alvUeberGrenze: Prisma.Decimal;
  uvgNbu: Prisma.Decimal;
  ktg: Prisma.Decimal;
  bvgEintrittsschwelle: Prisma.Decimal;
  bvgKoordinationsabzug: Prisma.Decimal;
  bvgMindestKoordiniert: Prisma.Decimal;
  bvgObergrenze: Prisma.Decimal;
  bvgSaetze: Prisma.JsonValue;
  bvgAnteilArbeitnehmer: Prisma.Decimal;
}): BeitragsSaetze {
  /**
   * Die Altersbänder liegen als Json in der Spalte und werden hier geprüft,
   * nicht geglaubt. Ein kaputter Eintrag — von Hand geschrieben, aus einer
   * Migration, aus einem Import — ergäbe sonst einen BVG-Abzug von null, und
   * das fiele erst der betroffenen Person auf.
   */
  const roh = Array.isArray(zeile.bvgSaetze) ? zeile.bvgSaetze : [];
  const baender = roh
    .filter(
      (e): e is { abAlter: number; satz: number } =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as { abAlter?: unknown }).abAlter === 'number' &&
        typeof (e as { satz?: unknown }).satz === 'number',
    )
    .sort((a, b) => a.abAlter - b.abAlter);

  return {
    ahvIvEo: toNumber(zeile.ahvIvEo),
    alv: toNumber(zeile.alv),
    alvGrenzeJahr: toNumber(zeile.alvGrenzeJahr),
    alvUeberGrenze: toNumber(zeile.alvUeberGrenze),
    uvgNbu: toNumber(zeile.uvgNbu),
    ktg: toNumber(zeile.ktg),
    bvgEintrittsschwelle: toNumber(zeile.bvgEintrittsschwelle),
    bvgKoordinationsabzug: toNumber(zeile.bvgKoordinationsabzug),
    bvgMindestKoordiniert: toNumber(zeile.bvgMindestKoordiniert),
    bvgObergrenze: toNumber(zeile.bvgObergrenze),
    bvgSaetze: baender.length > 0 ? baender : SAETZE_2026.bvgSaetze,
    bvgAnteilArbeitnehmer: toNumber(zeile.bvgAnteilArbeitnehmer),
  };
}

/**
 * Die Sätze eines Jahres holen — und anlegen, wenn es sie noch nicht gibt.
 *
 * **Warum angelegt und nicht abgelehnt.** Die Alternative wäre, den ersten
 * Abrechnungslauf eines Jahres mit „bitte zuerst die Sätze erfassen"
 * abzuweisen. Das klingt gründlicher und ist es nicht: Es verschiebt die
 * Arbeit an den ungünstigsten Moment (Monatsende, Abrechnung läuft) und
 * erzeugt dort den Druck, irgendetwas einzutragen.
 *
 * Angelegt werden die gesetzlichen Vorgaben. Die betriebsabhängigen Sätze —
 * UVG und der BVG-Plan — sind darin **Annahmen**, und die Antwort jedes
 * Abrechnungslaufs sagt das auch (`saetzeGeprueft: false`), solange sie
 * niemand bestätigt hat.
 */
export async function getOrCreatePayrollSettings(organizationId: string, year: number) {
  const vorhanden = await prisma.payrollSetting.findUnique({
    where: { organizationId_year: { organizationId, year } },
  });
  if (vorhanden) return vorhanden;

  const vorjahr = await prisma.payrollSetting.findUnique({
    where: { organizationId_year: { organizationId, year: year - 1 } },
  });

  /**
   * Das Vorjahr als Vorlage, wenn es eines gibt — die betriebsabhängigen
   * Sätze (UVG, BVG-Plan) ändern sich selten, die gesetzlichen jährlich. Wer
   * vom Vorjahr abschreibt, übernimmt wenigstens den richtigen UVG-Satz und
   * muss nur die gesetzlichen prüfen.
   */
  return prisma.payrollSetting.create({
    data: {
      organizationId,
      year,
      ...(vorjahr
        ? {
            uvgNbu: vorjahr.uvgNbu,
            ktg: vorjahr.ktg,
            bvgSaetze: vorjahr.bvgSaetze as Prisma.InputJsonValue,
            bvgAnteilArbeitnehmer: vorjahr.bvgAnteilArbeitnehmer,
          }
        : {}),
    },
  });
}

export async function updatePayrollSettings(params: {
  organizationId: string;
  year: number;
  actorId: string;
  ip?: string | null;
  /**
   * Der Typ kommt aus dem Zod-Schema und nicht aus einer eigenen Deklaration.
   * Eine zweite Beschreibung derselben Felder wäre eine, die beim nächsten
   * neuen Satz einseitig gepflegt wird — und an dieser Stelle hiesse das: ein
   * Satz, den die Validierung annimmt und der Dienst stillschweigend fallen
   * lässt.
   */
  input: PayrollSettingsInput;
}) {
  const vorher = await getOrCreatePayrollSettings(params.organizationId, params.year);

  const daten: Prisma.PayrollSettingUpdateInput = {};
  for (const feld of [
    'ahvIvEo',
    'alv',
    'alvGrenzeJahr',
    'alvUeberGrenze',
    'uvgNbu',
    'ktg',
    'bvgEintrittsschwelle',
    'bvgKoordinationsabzug',
    'bvgMindestKoordiniert',
    'bvgObergrenze',
    'bvgAnteilArbeitnehmer',
  ] as const) {
    const wert = params.input[feld];
    if (typeof wert === 'number') {
      (daten as Record<string, unknown>)[feld] = wert;
    }
  }

  if (params.input.bvgSaetze) {
    daten.bvgSaetze = params.input.bvgSaetze as unknown as Prisma.InputJsonValue;
  }

  const nachher = await prisma.payrollSetting.update({
    where: { id: vorher.id },
    data: daten,
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'PayrollSetting',
    entityId: nachher.id,
    summary: `Beitragssätze ${params.year} geändert`,
    changes: Object.fromEntries(
      Object.entries(daten).map(([k, v]) => [
        k,
        { from: (vorher as unknown as Record<string, unknown>)[k], to: v },
      ]),
    ),
    ip: params.ip,
  });

  return nachher;
}

// ---------------------------------------------------------------------------
//  Bruttolohn
// ---------------------------------------------------------------------------

/**
 * Erster und erster **nicht mehr** zugehöriger Moment eines Abrechnungsmonats
 * — Mitternacht in Zürich, nicht in UTC.
 *
 * Bis 2026-09-23 stand hier UTC. Eine Schicht, die am 1. um 00:30 Ortszeit
 * begann, lag in UTC noch am letzten Tag des Vormonats (22:30 bzw. 23:30) und
 * wurde dem falschen Monat zugerechnet — für Nachtreinigung, die in diesem
 * Gewerbe üblich ist, kein Randfall.
 */
export function monatsfenster(year: number, month: number): { von: Date; bis: Date } {
  return {
    von: zurichMidnight(year, month - 1, 1),
    bis: zurichMidnight(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1),
  };
}

/**
 * Der Lohnsatz, der **an einem Tag** galt — aus der Lohnhistorie.
 *
 * Bis 2026-09-23 rechnete jeder Lauf mit dem **heutigen** Satz der
 * Personalakte. Wer eine Abrechnung für einen früheren Monat neu erzeugte,
 * nachdem jemand eine Lohnerhöhung eingetragen hatte, bekam den neuen Lohn
 * für den alten Monat. Die Historie (`SalaryRecord`, `validFrom`) wird bei
 * jeder Lohnänderung geschrieben; sie ist die Quelle. Ohne Eintrag gilt der
 * Satz der Personalakte — der Stand, bevor es eine Historie gab.
 */
function satzAm<
  T extends { validFrom: Date; hourlyRate: Prisma.Decimal | null; monthlySalary: Prisma.Decimal | null; workloadPct: number },
>(historie: readonly T[], tag: Date): T | null {
  let treffer: T | null = null;
  for (const eintrag of historie) {
    if (eintrag.validFrom.getTime() <= tag.getTime()) treffer = eintrag;
  }
  return treffer;
}

export interface BruttoErgebnis {
  brutto: number;
  stunden: number;
  basis: 'HOURLY' | 'MONTHLY';
  /** Wie viele freigegebene Erfassungen eingeflossen sind. */
  erfassungen: number;
  /** Wie viele Erfassungen im Monat **nicht** freigegeben waren. */
  offeneErfassungen: number;
  hochrechnungJahr: number;
}

/**
 * Den Bruttolohn eines Monats ermitteln.
 *
 * **Monatslohn hat Vorrang.** Wer einen Monatslohn hat, bekommt ihn — auch in
 * einem Monat mit wenigen Einsätzen. Die Zeiterfassung dient dort der
 * Einsatzplanung und der Nachkalkulation, nicht der Lohnberechnung. Die
 * Stunden werden trotzdem ausgewiesen, weil sie auf die Abrechnung gehören.
 *
 * **Bei Stundenlohn zählen nur freigegebene Erfassungen.** Die offenen werden
 * gezählt und gemeldet, aber nicht bezahlt — eine Abrechnung, die ungeprüfte
 * Stunden mitnimmt, ist keine Kontrolle mehr.
 */
export async function ermittleBrutto(params: {
  employeeId: string;
  year: number;
  month: number;
}): Promise<BruttoErgebnis> {
  const employee = await prisma.employee.findUniqueOrThrow({
    where: { id: params.employeeId },
    select: {
      hourlyRate: true,
      monthlySalary: true,
      workloadPct: true,
      salaryHistory: {
        orderBy: { validFrom: 'asc' },
        select: { validFrom: true, hourlyRate: true, monthlySalary: true, workloadPct: true },
      },
    },
  });

  const { von, bis } = monatsfenster(params.year, params.month);

  const [freigegeben, offen] = await Promise.all([
    prisma.timeEntry.findMany({
      where: {
        employeeId: params.employeeId,
        approved: true,
        endedAt: { not: null },
        startedAt: { gte: von, lt: bis },
      },
      select: { startedAt: true, minutes: true, hourlyRate: true },
    }),
    prisma.timeEntry.count({
      where: {
        employeeId: params.employeeId,
        approved: false,
        endedAt: { not: null },
        startedAt: { gte: von, lt: bis },
      },
    }),
  ]);

  const minuten = freigegeben.reduce((summe, e) => summe + (e.minutes ?? 0), 0);
  const stunden = round2(minuten / 60);

  /**
   * Monatslohn und Pensum: der Stand am **letzten Tag** des Monats. Eine
   * Erhöhung zum Monatsersten gilt damit für den ganzen Monat — die übliche
   * Vereinbarung. Eine unterjährige Änderung mitten im Monat anteilig zu
   * rechnen, ist eine Frage des Arbeitsvertrags und steht als offener Punkt in
   * `docs/PAYROLL.md`.
   */
  const stand = satzAm(employee.salaryHistory, new Date(bis.getTime() - 1));
  const monatslohn = toNumber(stand ? stand.monthlySalary : employee.monthlySalary);
  const pensum = stand?.workloadPct ?? employee.workloadPct;
  const stundensatzJetzt = toNumber(stand ? stand.hourlyRate : employee.hourlyRate);

  if (monatslohn > 0) {
    const brutto = round2(monatslohn * (pensum / 100));
    return {
      brutto,
      stunden,
      basis: 'MONTHLY',
      erfassungen: freigegeben.length,
      offeneErfassungen: offen,
      hochrechnungJahr: round2(brutto * 12),
    };
  }

  /**
   * Stundenlohn **je Erfassung**: der Satz der Lohnhistorie am Tag der
   * Erfassung; gibt es dort keinen, der bei der Erfassung festgehaltene
   * (`TimeEntry.hourlyRate`); sonst der der Personalakte. Eine Erhöhung zum
   * 15. bezahlt die ersten zwei Wochen zum alten Satz.
   *
   * Die Historie geht dem Schnappschuss vor, weil sie auch **rückwirkend**
   * gepflegt wird: Eine Erhöhung, die im Oktober mit Wirkung ab September
   * eingetragen wird, muss für die Septemberstunden gelten, obwohl diese mit
   * dem alten Satz erfasst wurden.
   */
  const brutto = round2(
    freigegeben.reduce((summe, e) => {
      const ausHistorie = satzAm(employee.salaryHistory, e.startedAt)?.hourlyRate ?? null;
      const satz = toNumber(ausHistorie ?? e.hourlyRate ?? employee.hourlyRate);
      return summe + ((e.minutes ?? 0) / 60) * satz;
    }, 0),
  );
  const stundensatz = stundensatzJetzt;
  const employeeWorkload = pensum;

  /**
   * Die Jahreshochrechnung bei Stundenlohn.
   *
   * **Nicht `brutto × 12`.** Bei schwankenden Stunden wäre das im Spitzenmonat
   * zu hoch und im schwachen zu tief, und der koordinierte Lohn spränge von
   * Monat zu Monat — mit ihm der BVG-Abzug. Gerechnet wird stattdessen mit dem
   * vereinbarten Pensum auf eine 42-Stunden-Woche: eine Grösse, die sich nicht
   * monatlich ändert.
   *
   * Der Wert ist eine Annahme und wird als solche in `breakdown` festgehalten.
   * Genau zu rechnen verlangte eine laufende Jahressumme mit rückwirkender
   * Korrektur — das ist Treuhandarbeit und steht so in `docs/PAYROLL.md`.
   */
  const wochenstunden = 42 * (employeeWorkload / 100);
  const hochrechnungJahr = round2(wochenstunden * 52 * stundensatz);

  return {
    brutto,
    stunden,
    basis: 'HOURLY',
    erfassungen: freigegeben.length,
    offeneErfassungen: offen,
    hochrechnungJahr,
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
}

/**
 * Abrechnungen für einen Monat erzeugen.
 *
 * Läuft über alle aktiven Personalakten oder über eine Auswahl. **Wirft für
 * eine einzelne Person nicht**, sondern meldet sie als übersprungen: Ein Lauf
 * über dreissig Personen soll nicht an einer scheitern, bei der etwas fehlt.
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
  ergebnisse: AbrechnungsErgebnis[];
}> {
  if (params.month < 1 || params.month > 12) {
    throw new BusinessRuleError('Der Monat muss zwischen 1 und 12 liegen.');
  }

  /**
   * Ein Monat, der noch läuft, wird nicht abgerechnet.
   *
   * Der Fall, den das abfängt: Am 12. des Monats einen Lauf starten, weil man
   * „schon mal schauen" will. Das Ergebnis sähe aus wie eine Abrechnung, wäre
   * um zwei Drittel zu tief — und die Idempotenz sorgt dafür, dass ein
   * späterer Lauf sie stillschweigend überschreibt. Wer die Zwischenzahl
   * will, nimmt die Zeiterfassung.
   */
  const { bis } = monatsfenster(params.year, params.month);
  if (bis.getTime() > Date.now()) {
    throw new BusinessRuleError(
      `Der Monat ${String(params.month).padStart(2, '0')}/${params.year} ist noch nicht abgeschlossen. ` +
        'Abgerechnet wird nach dem Monatsende.',
    );
  }

  const settings = await getOrCreatePayrollSettings(params.organizationId, params.year);
  const saetze = alsSaetze(settings);

  const employees = await prisma.employee.findMany({
    where: {
      organizationId: params.organizationId,
      active: true,
      ...(params.employeeIds?.length ? { id: { in: params.employeeIds } } : {}),
    },
    select: {
      id: true,
      employeeNumber: true,
      birthday: true,
      hourlyRate: true,
      monthlySalary: true,
      workloadPct: true,
    },
    orderBy: { employeeNumber: 'asc' },
  });

  const ergebnisse: AbrechnungsErgebnis[] = [];

  for (const employee of employees) {
    const vorhanden = await prisma.payslip.findUnique({
      where: {
        employeeId_year_month: {
          employeeId: employee.id,
          year: params.year,
          month: params.month,
        },
      },
      select: { id: true, published: true },
    });

    if (vorhanden?.published) {
      ergebnisse.push({
        employeeId: employee.id,
        employeeNumber: employee.employeeNumber,
        payslipId: vorhanden.id,
        status: 'UEBERSPRUNGEN',
        grund: 'Bereits veröffentlicht — eine veröffentlichte Abrechnung ist unveränderlich.',
      });
      continue;
    }

    const brutto = await ermittleBrutto({
      employeeId: employee.id,
      year: params.year,
      month: params.month,
    });

    if (brutto.brutto <= 0) {
      ergebnisse.push({
        employeeId: employee.id,
        employeeNumber: employee.employeeNumber,
        status: 'UEBERSPRUNGEN',
        grund:
          brutto.basis === 'HOURLY'
            ? brutto.offeneErfassungen > 0
              ? `Kein freigegebener Lohn — ${brutto.offeneErfassungen} Erfassung(en) warten auf Freigabe.`
              : 'Keine freigegebenen Stunden in diesem Monat.'
            : 'Kein Lohn hinterlegt.',
        offeneErfassungen: brutto.offeneErfassungen,
      });
      continue;
    }

    const alter = alterImJahr(employee.birthday, params.year);
    const beitraege = berechneBeitraege(
      { bruttoMonat: brutto.brutto, bruttoJahr: brutto.hochrechnungJahr, alter },
      saetze,
    );

    const netto = rappen(brutto.brutto - beitraege.summe);

    const daten = {
      hours: brutto.stunden,
      grossPay: brutto.brutto,
      ahvIv: beitraege.ahvIv,
      alv: beitraege.alv,
      bvg: beitraege.bvg,
      uvg: beitraege.uvg,
      ktg: beitraege.ktg,
      otherDeductions: 0,
      netPay: netto,
      basis: brutto.basis,
      createdById: params.actorId,
      /**
       * Die Herleitung als Momentaufnahme. Ändert sich ein Satz im nächsten
       * Jahr, bleibt diese Abrechnung nachvollziehbar.
       */
      breakdown: {
        saetze,
        alter,
        erfassungen: brutto.erfassungen,
        offeneErfassungen: brutto.offeneErfassungen,
        hochrechnungJahr: brutto.hochrechnungJahr,
        ...beitraege.herleitung,
        /**
         * Der Umweg über `unknown` ist nötig, weil `InputJsonValue` eine
         * rekursive Vereinigung ist, in die TypeScript ein Objektliteral mit
         * optionalen Feldern nicht direkt einordnet. Der Inhalt ist
         * nachweislich Json — Zahlen, Zeichenketten, Wahrheitswerte und
         * einfache Objekte — und die Zusicherung sagt genau das.
         */
      } as unknown as Prisma.InputJsonValue,
    };

    /**
     * **Nie über eine veröffentlichte Abrechnung.** Bis 2026-09-23 stand hier
     * ein `upsert` — und ein Veröffentlichen, das zwischen der Prüfung oben
     * und diesem Schreiben geschah, wurde still überschrieben. Jetzt steht
     * `published: false` in der Bedingung des Schreibens selbst; trifft es
     * keine Zeile, hat jemand anderes gerade veröffentlicht, und die
     * Abrechnung bleibt, wie sie veröffentlicht wurde.
     */
    let payslipId: string;
    if (vorhanden) {
      const geaendert = await prisma.payslip.updateMany({
        where: { id: vorhanden.id, published: false },
        data: daten,
      });
      if (geaendert.count === 0) {
        ergebnisse.push({
          employeeId: employee.id,
          employeeNumber: employee.employeeNumber,
          payslipId: vorhanden.id,
          status: 'UEBERSPRUNGEN',
          grund: 'Inzwischen veröffentlicht — eine veröffentlichte Abrechnung ist unveränderlich.',
        });
        continue;
      }
      payslipId = vorhanden.id;
    } else {
      try {
        payslipId = (
          await prisma.payslip.create({
            data: { employeeId: employee.id, year: params.year, month: params.month, ...daten },
            select: { id: true },
          })
        ).id;
      } catch (error) {
        // Ein gleichzeitiger Lauf war schneller — seine Abrechnung gilt.
        if (!isUniqueConstraintError(error)) throw error;
        ergebnisse.push({
          employeeId: employee.id,
          employeeNumber: employee.employeeNumber,
          status: 'UEBERSPRUNGEN',
          grund: 'Ein gleichzeitiger Lauf hat diese Abrechnung eben erzeugt.',
        });
        continue;
      }
    }

    ergebnisse.push({
      employeeId: employee.id,
      employeeNumber: employee.employeeNumber,
      payslipId,
      status: vorhanden ? 'AKTUALISIERT' : 'ERSTELLT',
      brutto: brutto.brutto,
      netto,
      offeneErfassungen: brutto.offeneErfassungen,
    });
  }

  await audit.created({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Payslip',
    summary:
      `Lohnlauf ${String(params.month).padStart(2, '0')}/${params.year}: ` +
      `${ergebnisse.filter((e) => e.status !== 'UEBERSPRUNGEN').length} Abrechnung(en), ` +
      `${ergebnisse.filter((e) => e.status === 'UEBERSPRUNGEN').length} übersprungen`,
    ip: params.ip,
  });

  return {
    jahr: params.year,
    monat: params.month,
    /**
     * Solange niemand die Sätze bestätigt hat, sind die betriebsabhängigen
     * Werte (UVG, BVG-Plan) Vorbelegungen. Die Antwort sagt das, statt es der
     * Oberfläche zu überlassen.
     */
    saetzeGeprueft: settings.updatedAt.getTime() !== settings.createdAt.getTime(),
    ergebnisse,
  };
}

/**
 * Eine Abrechnung veröffentlichen.
 *
 * Damit wird sie für die angestellte Person sichtbar (`/portal/lohn`) und
 * **unveränderlich**. Das ist dieselbe Schwelle wie beim Ausstellen einer
 * Rechnung, und aus demselben Grund: Ab hier ist sie bei jemandem angekommen.
 *
 * Korrekturen laufen danach über eine Abrechnung des Folgemonats, nicht über
 * eine stille Änderung. Ein `unpublish` gibt es bewusst nicht — eine
 * Abrechnung, die wieder verschwindet, ist schlimmer als eine falsche, die
 * korrigiert wird.
 */
export async function publishPayslips(params: {
  organizationId: string;
  payslipIds: string[];
  actorId: string;
  ip?: string | null;
}): Promise<{ veroeffentlicht: number; uebersprungen: number }> {
  const vorhanden = await prisma.payslip.findMany({
    where: {
      id: { in: params.payslipIds },
      employee: { organizationId: params.organizationId },
    },
    select: { id: true, published: true, netPay: true },
  });

  const offen = vorhanden.filter((p) => !p.published).map((p) => p.id);
  if (offen.length === 0) {
    return { veroeffentlicht: 0, uebersprungen: vorhanden.length };
  }

  const treffer = await prisma.payslip.updateMany({
    where: { id: { in: offen }, published: false },
    data: { published: true, publishedAt: new Date() },
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Payslip',
    summary: `${treffer.count} Lohnabrechnung(en) veröffentlicht`,
    changes: { payslipIds: offen },
    ip: params.ip,
  });

  return { veroeffentlicht: treffer.count, uebersprungen: vorhanden.length - treffer.count };
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
        netPay: true,
        basis: true,
        published: true,
        publishedAt: true,
        employee: {
          select: {
            id: true,
            employeeNumber: true,
            user: { select: { firstName: true, lastName: true } },
          },
        },
      },
    }),
    prisma.payslip.aggregate({ where, _sum: { grossPay: true, netPay: true } }),
  ]);

  return {
    eintraege,
    summeBrutto: toNumber(summe._sum.grossPay),
    summeNetto: toNumber(summe._sum.netPay),
  };
}

/**
 * Eine einzelne Abrechnung samt Herleitung.
 *
 * Die Herleitung ist der Grund, warum es diesen Endpunkt gibt: Eine
 * Lohnabrechnung, bei der sich der BVG-Abzug nicht nachrechnen lässt, erzeugt
 * genau eine Rückfrage je Monat und je Person.
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
      /**
       * Wer die eigene Abrechnung liest, sieht nur veröffentlichte. Eine
       * unveröffentlichte ist ein Entwurf — sie kann sich noch ändern, und
       * eine Zahl, die sich ändert, nachdem sie jemand gesehen hat, ist
       * schlimmer als keine Zahl.
       */
      ...(params.employeeId ? { published: true } : {}),
    },
    include: {
      employee: {
        select: {
          id: true,
          employeeNumber: true,
          user: { select: { firstName: true, lastName: true } },
        },
      },
    },
  });

  if (!payslip) throw new NotFoundError('Lohnabrechnung');
  return payslip;
}
