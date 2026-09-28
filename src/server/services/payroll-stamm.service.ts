import 'server-only';

import { randomUUID } from 'node:crypto';

import type { Prisma } from '@prisma/client';

import { audit, diff } from '@/lib/audit';
import { isUniqueConstraintError, prisma, toNumber } from '@/lib/db';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { ueberstundenBetrag } from '@/lib/payroll/lohnbestandteile';
import type {
  PayrollItemCreateInput,
  PayrollItemUpdateInput,
  PayrollProfileInput,
  WithholdingProfileCreateInput,
  WithholdingProfileUpdateInput,
  WithholdingRateImportInput,
} from '@/lib/validation/payroll';

import { markiereVeraltet } from './payroll-veraltet';

/**
 * Lohnstammdaten neben der Personalakte (Wave 9, 2026-09-23): Vereinbarungen
 * je Person, Lohnpositionen eines Monats, Quellensteuerprofil und -tarif.
 *
 * **Warum nicht in der Personalakte.** Die Akte lesen Rollen ohne Lohneinblick
 * (die Betriebsleitung plant Einsätze). Was hier steht — Kirchensteuer,
 * Kinderzahl, Lohnpfändung, Vorschuss —, gehört nur zur Lohnverarbeitung und
 * ist nur über die Lohnschnittstelle mit `payslip:create` erreichbar.
 *
 * **Nach dem Veröffentlichen unveränderlich.** Eine Position, die in eine
 * veröffentlichte Abrechnung eingeflossen ist, lässt sich weder ändern noch
 * löschen (Dienst und Trigger). Eine Korrektur ist eine neue Position in
 * einem offenen Monat, mit Verweis auf die korrigierte Abrechnung.
 *
 * **Jede Änderung macht eine berechnete Abrechnung desselben Monats
 * veraltet** (`payroll-veraltet.ts`) — sonst würde die alte Zahl
 * veröffentlicht.
 */

async function akteDerOrganisation(organizationId: string, employeeId: string) {
  const akte = await prisma.employee.findFirst({
    where: { id: employeeId, organizationId },
    select: { id: true, employeeNumber: true },
  });
  if (!akte) throw new NotFoundError('Personalakte');
  return akte;
}

async function monatVeroeffentlicht(employeeId: string, year: number, month: number): Promise<boolean> {
  const abrechnung = await prisma.payslip.findUnique({
    where: { employeeId_year_month: { employeeId, year, month } },
    select: { published: true },
  });
  return abrechnung?.published === true;
}

const monatText = (jahr: number, monat: number) => `${String(monat).padStart(2, '0')}/${jahr}`;

// ---------------------------------------------------------------------------
//  Vereinbarungen je Person
// ---------------------------------------------------------------------------

export async function getPayrollProfile(organizationId: string, employeeId: string) {
  await akteDerOrganisation(organizationId, employeeId);
  const profil = await prisma.employeePayrollProfile.findUnique({ where: { employeeId } });
  /**
   * Ohne Eintrag gilt: kein 13. Monatslohn, keine Ferien- oder
   * Feiertagsentschädigung mit dem Lohn. Das ist **keine** Aussage über die
   * gesetzliche Lage, sondern der Stand „nichts vereinbart erfasst".
   */
  return (
    profil ?? {
      employeeId,
      thirteenthMode: 'NONE' as const,
      thirteenthPayoutMonth: 12,
      vacationPayInWage: false,
      holidayPayPct: null,
      note: null,
    }
  );
}

export async function upsertPayrollProfile(params: {
  organizationId: string;
  employeeId: string;
  actorId: string;
  ip?: string | null;
  input: PayrollProfileInput;
}) {
  await akteDerOrganisation(params.organizationId, params.employeeId);
  const vorher = await prisma.employeePayrollProfile.findUnique({ where: { employeeId: params.employeeId } });
  const daten = {
    thirteenthMode: params.input.thirteenthMode,
    thirteenthPayoutMonth: params.input.thirteenthPayoutMonth,
    vacationPayInWage: params.input.vacationPayInWage,
    holidayPayPct: params.input.holidayPayPct ?? null,
    note: params.input.note ?? null,
    updatedById: params.actorId,
  };
  const nachher = await prisma.employeePayrollProfile.upsert({
    where: { employeeId: params.employeeId },
    create: { employeeId: params.employeeId, ...daten },
    update: daten,
  });
  await markiereVeraltet({ employeeId: params.employeeId }, 'Lohnvereinbarung geändert');
  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'EmployeePayrollProfile',
    entityId: nachher.id,
    summary: 'Lohnvereinbarungen einer Personalakte geändert',
    changes: diff(
      vorher ? { ...vorher, holidayPayPct: vorher.holidayPayPct === null ? null : toNumber(vorher.holidayPayPct) } : null,
      { ...nachher, holidayPayPct: nachher.holidayPayPct === null ? null : toNumber(nachher.holidayPayPct) },
      'EmployeePayrollProfile',
    ),
    ip: params.ip,
  });
  return nachher;
}

// ---------------------------------------------------------------------------
//  Lohnpositionen
// ---------------------------------------------------------------------------

export async function listPayrollItems(params: {
  organizationId: string;
  year?: number;
  month?: number;
  employeeId?: string;
}) {
  return prisma.payrollItem.findMany({
    where: {
      organizationId: params.organizationId,
      deletedAt: null,
      ...(params.year ? { year: params.year } : {}),
      ...(params.month ? { month: params.month } : {}),
      ...(params.employeeId ? { employeeId: params.employeeId } : {}),
    },
    orderBy: [{ year: 'desc' }, { month: 'desc' }, { createdAt: 'asc' }],
    take: 1000,
    include: {
      employee: { select: { id: true, employeeNumber: true, user: { select: { firstName: true, lastName: true } } } },
      payslip: { select: { id: true, published: true } },
    },
  });
}

/**
 * Eine Lohnposition erfassen.
 *
 * **Nicht in einen veröffentlichten Monat.** Der Monat ist bei der Person
 * angekommen; eine Korrektur gehört in einen offenen Monat und verweist auf
 * die korrigierte Abrechnung (`correctsPayslipId`). So bleibt die Kette
 * sichtbar: alte Zahl, Korrektur, neue Auszahlung.
 */
export async function createPayrollItem(params: {
  organizationId: string;
  actorId: string;
  ip?: string | null;
  input: PayrollItemCreateInput;
}) {
  const { input } = params;
  const akte = await akteDerOrganisation(params.organizationId, input.employeeId);
  if (await monatVeroeffentlicht(akte.id, input.year, input.month)) {
    throw new BusinessRuleError(
      `Die Abrechnung ${monatText(input.year, input.month)} ist veröffentlicht. ` +
        'Erfassen Sie die Position als Korrektur in einem offenen Monat.',
    );
  }
  if (input.correctsPayslipId) {
    const korrigiert = await prisma.payslip.findFirst({
      where: { id: input.correctsPayslipId, employeeId: akte.id, published: true },
      select: { year: true, month: true },
    });
    if (!korrigiert) {
      throw new BusinessRuleError('Korrigiert werden kann nur eine veröffentlichte Abrechnung derselben Person.');
    }
    if (korrigiert.year * 12 + korrigiert.month >= input.year * 12 + input.month) {
      throw new BusinessRuleError('Die Korrektur gehört in einen späteren Monat als die korrigierte Abrechnung.');
    }
  }

  const betrag =
    input.type === 'OVERTIME'
      ? ueberstundenBetrag(input.quantity ?? 0, input.rate ?? 0, input.surchargePct ?? 0)
      : (input.amount as number);

  let neu;
  try {
    neu = await prisma.payrollItem.create({
      data: {
        organizationId: params.organizationId,
        employeeId: akte.id,
        year: input.year,
        month: input.month,
        type: input.type,
        label: input.label,
        quantity: input.quantity ?? null,
        rate: input.rate ?? null,
        surchargePct: input.type === 'OVERTIME' ? (input.surchargePct ?? 0) : null,
        amount: betrag,
        note: input.note ?? null,
        correctsPayslipId: input.correctsPayslipId ?? null,
        createdById: params.actorId,
      },
    });
  } catch (fehler) {
    if (isUniqueConstraintError(fehler)) {
      throw new BusinessRuleError('Für diesen Monat ist bereits eine Quellensteuer von Hand erfasst.');
    }
    throw fehler;
  }

  await markiereVeraltet({ employeeId: akte.id, year: input.year, month: input.month }, 'Lohnposition erfasst');
  await audit.created({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'PayrollItem',
    entityId: neu.id,
    summary: `Lohnposition (${input.type}) für ${akte.employeeNumber}, ${monatText(input.year, input.month)} erfasst`,
    changes: { type: neu.type, amount: neu.amount, label: neu.label, quantity: neu.quantity },
    ip: params.ip,
  });
  return neu;
}

async function positionZumAendern(organizationId: string, id: string) {
  const position = await prisma.payrollItem.findFirst({
    where: { id, organizationId, deletedAt: null },
    include: { payslip: { select: { published: true } } },
  });
  if (!position) throw new NotFoundError('Lohnposition');
  if (position.payslip?.published || (await monatVeroeffentlicht(position.employeeId, position.year, position.month))) {
    throw new BusinessRuleError(
      'Die Position ist in eine veröffentlichte Abrechnung eingeflossen und bleibt, wie sie ist. ' +
        'Eine Korrektur erfassen Sie als neue Position in einem offenen Monat.',
    );
  }
  return position;
}

export async function updatePayrollItem(params: {
  organizationId: string;
  id: string;
  actorId: string;
  ip?: string | null;
  input: PayrollItemUpdateInput;
}) {
  const vorher = await positionZumAendern(params.organizationId, params.id);
  const { input } = params;

  const daten: Prisma.PayrollItemUpdateInput = {};
  if (input.label !== undefined) daten.label = input.label;
  if (input.note !== undefined) daten.note = input.note;
  if (vorher.type === 'OVERTIME') {
    if (input.amount !== undefined) throw new BusinessRuleError('Den Betrag der Überstunden rechnet der Server.');
    const stunden = input.quantity ?? toNumber(vorher.quantity);
    const ansatz = input.rate ?? toNumber(vorher.rate);
    const zuschlag = input.surchargePct ?? toNumber(vorher.surchargePct);
    if (!stunden || !ansatz) throw new BusinessRuleError('Überstunden brauchen Stunden und Ansatz.');
    Object.assign(daten, { quantity: stunden, rate: ansatz, surchargePct: zuschlag, amount: ueberstundenBetrag(stunden, ansatz, zuschlag) });
  } else if (input.amount !== undefined) {
    const vorzeichenErlaubt = vorher.type === 'CORRECTION' || vorher.type === 'NET_CORRECTION';
    if (input.amount === 0 || (!vorzeichenErlaubt && input.amount < 0)) {
      throw new BusinessRuleError(vorzeichenErlaubt ? 'Eine Position über null Franken ist keine Position.' : 'Nur Korrekturen dürfen negativ sein.');
    }
    daten.amount = input.amount;
  }

  const nachher = await prisma.payrollItem.update({ where: { id: vorher.id }, data: daten });
  await markiereVeraltet({ employeeId: vorher.employeeId, year: vorher.year, month: vorher.month }, 'Lohnposition geändert');
  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'PayrollItem',
    entityId: nachher.id,
    summary: `Lohnposition ${monatText(vorher.year, vorher.month)} geändert`,
    changes: diff(vorher as unknown as Record<string, unknown>, nachher as unknown as Record<string, unknown>, 'PayrollItem'),
    ip: params.ip,
  });
  return nachher;
}

/**
 * Löschen heisst hier ausblenden (`deletedAt`) — die Position bleibt als
 * Beleg, dass sie einmal erfasst war, und fällt aus dem nächsten Lauf.
 */
export async function deletePayrollItem(params: { organizationId: string; id: string; actorId: string; ip?: string | null }) {
  const vorher = await positionZumAendern(params.organizationId, params.id);
  await prisma.payrollItem.update({ where: { id: vorher.id }, data: { deletedAt: new Date(), payslipId: null } });
  await markiereVeraltet({ employeeId: vorher.employeeId, year: vorher.year, month: vorher.month }, 'Lohnposition entfernt');
  await audit.deleted({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'PayrollItem',
    entityId: vorher.id,
    summary: `Lohnposition ${monatText(vorher.year, vorher.month)} entfernt`,
    ip: params.ip,
  });
  return { id: vorher.id, deleted: true };
}

// ---------------------------------------------------------------------------
//  Quellensteuer: Profil
// ---------------------------------------------------------------------------

const datum = (text: string) => new Date(`${text}T00:00:00Z`);

export async function listWithholdingProfiles(params: { organizationId: string; employeeId?: string }) {
  return prisma.withholdingTaxProfile.findMany({
    where: { organizationId: params.organizationId, ...(params.employeeId ? { employeeId: params.employeeId } : {}) },
    orderBy: [{ employeeId: 'asc' }, { validFrom: 'asc' }],
    take: 500,
    include: { employee: { select: { id: true, employeeNumber: true, user: { select: { firstName: true, lastName: true } } } } },
  });
}

/** Gibt es eine veröffentlichte Abrechnung im Zeitraum des Profils? */
async function veroeffentlichtImZeitraum(employeeId: string, von: Date, bis: Date | null): Promise<boolean> {
  const vonIndex = von.getUTCFullYear() * 12 + von.getUTCMonth() + 1;
  const bisIndex = bis ? bis.getUTCFullYear() * 12 + bis.getUTCMonth() + 1 : Number.MAX_SAFE_INTEGER;
  const veroeffentlicht = await prisma.payslip.findMany({
    where: { employeeId, published: true },
    select: { year: true, month: true },
  });
  return veroeffentlicht.some((p) => {
    const i = p.year * 12 + p.month;
    return i >= vonIndex && i <= bisIndex;
  });
}

function ueberlappungsFehler(fehler: unknown): boolean {
  const text = String(fehler);
  return text.includes('withholding_tax_profiles_ueberlappungsfrei') || text.includes('23P01');
}

export async function createWithholdingProfile(params: {
  organizationId: string;
  actorId: string;
  ip?: string | null;
  input: WithholdingProfileCreateInput;
}) {
  const { input } = params;
  const akte = await akteDerOrganisation(params.organizationId, input.employeeId);
  const von = datum(input.validFrom);
  const bis = input.validUntil ? datum(input.validUntil) : null;
  if (bis && bis < von) throw new BusinessRuleError('Das Ende liegt vor dem Beginn.');

  let neu;
  try {
    neu = await prisma.withholdingTaxProfile.create({
      data: {
        organizationId: params.organizationId,
        employeeId: akte.id,
        validFrom: von,
        validUntil: bis,
        canton: input.canton,
        tariffCode: input.tariffCode,
        churchTax: input.churchTax,
        children: input.children,
        note: input.note ?? null,
        createdById: params.actorId,
      },
    });
  } catch (fehler) {
    if (ueberlappungsFehler(fehler)) {
      throw new BusinessRuleError('Für diesen Zeitraum besteht bereits ein Quellensteuerprofil. Beenden Sie zuerst das bisherige.');
    }
    throw fehler;
  }
  await markiereVeraltet({ employeeId: akte.id }, 'Quellensteuerprofil erfasst');
  await audit.created({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'WithholdingTaxProfile',
    entityId: neu.id,
    summary: `Quellensteuerprofil für ${akte.employeeNumber} ab ${input.validFrom} erfasst`,
    changes: { canton: neu.canton, tariffCode: neu.tariffCode, churchTax: neu.churchTax, children: neu.children },
    ip: params.ip,
  });
  return neu;
}

/**
 * Ein Profil ändern. Liegt eine veröffentlichte Abrechnung in seinem
 * Zeitraum, sind nur noch das Ende und die Notiz änderbar — sonst stünde
 * hinter einer veröffentlichten Quellensteuer ein Tarif, mit dem sie nicht
 * gerechnet wurde. Ein Tarifwechsel ist ein neues Profil ab dem Wechseltag.
 */
export async function updateWithholdingProfile(params: {
  organizationId: string;
  id: string;
  actorId: string;
  ip?: string | null;
  input: WithholdingProfileUpdateInput;
}) {
  const vorher = await prisma.withholdingTaxProfile.findFirst({ where: { id: params.id, organizationId: params.organizationId } });
  if (!vorher) throw new NotFoundError('Quellensteuerprofil');
  const { input } = params;
  const bis = input.validUntil === undefined ? vorher.validUntil : input.validUntil ? datum(input.validUntil) : null;
  if (bis && bis < vorher.validFrom) throw new BusinessRuleError('Das Ende liegt vor dem Beginn.');

  const inhaltlich = ['canton', 'tariffCode', 'churchTax', 'children'].some((k) => (input as Record<string, unknown>)[k] !== undefined);
  if (inhaltlich && (await veroeffentlichtImZeitraum(vorher.employeeId, vorher.validFrom, vorher.validUntil))) {
    throw new BusinessRuleError(
      'In diesem Zeitraum gibt es bereits veröffentlichte Abrechnungen. Beenden Sie das Profil und erfassen Sie ab dem Wechsel ein neues.',
    );
  }
  if (input.validUntil !== undefined && bis && (await veroeffentlichtNach(vorher.employeeId, bis, vorher.validUntil))) {
    throw new BusinessRuleError('Nach dem neuen Ende liegen bereits veröffentlichte Abrechnungen mit diesem Profil.');
  }

  let nachher;
  try {
    nachher = await prisma.withholdingTaxProfile.update({
      where: { id: vorher.id },
      data: {
        validUntil: bis,
        ...(input.canton !== undefined ? { canton: input.canton } : {}),
        ...(input.tariffCode !== undefined ? { tariffCode: input.tariffCode } : {}),
        ...(input.churchTax !== undefined ? { churchTax: input.churchTax } : {}),
        ...(input.children !== undefined ? { children: input.children } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
      },
    });
  } catch (fehler) {
    if (ueberlappungsFehler(fehler)) throw new BusinessRuleError('Der Zeitraum überschneidet sich mit einem anderen Profil.');
    throw fehler;
  }
  await markiereVeraltet({ employeeId: vorher.employeeId }, 'Quellensteuerprofil geändert');
  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'WithholdingTaxProfile',
    entityId: nachher.id,
    summary: 'Quellensteuerprofil geändert',
    changes: diff(vorher as unknown as Record<string, unknown>, nachher as unknown as Record<string, unknown>, 'WithholdingTaxProfile'),
    ip: params.ip,
  });
  return nachher;
}

/** Wurde nach `ab` (ausschliesslich) bis zum bisherigen Ende schon veröffentlicht? */
async function veroeffentlichtNach(employeeId: string, ab: Date, bisher: Date | null): Promise<boolean> {
  const naechsterTag = new Date(ab.getTime() + 86_400_000);
  if (bisher && naechsterTag > bisher) return false;
  // Ein Monat zählt, wenn sein letzter Tag nach dem neuen Ende liegt.
  const abIndex = ab.getUTCFullYear() * 12 + ab.getUTCMonth() + 1;
  const monatsletzter = new Date(Date.UTC(ab.getUTCFullYear(), ab.getUTCMonth() + 1, 0));
  const vonIndex = ab.getTime() < monatsletzter.getTime() ? abIndex : abIndex + 1;
  const bisIndex = bisher ? bisher.getUTCFullYear() * 12 + bisher.getUTCMonth() + 1 : Number.MAX_SAFE_INTEGER;
  const veroeffentlicht = await prisma.payslip.findMany({ where: { employeeId, published: true }, select: { year: true, month: true } });
  return veroeffentlicht.some((p) => {
    const i = p.year * 12 + p.month;
    return i >= vonIndex && i <= bisIndex;
  });
}

export async function deleteWithholdingProfile(params: { organizationId: string; id: string; actorId: string; ip?: string | null }) {
  const vorher = await prisma.withholdingTaxProfile.findFirst({ where: { id: params.id, organizationId: params.organizationId } });
  if (!vorher) throw new NotFoundError('Quellensteuerprofil');
  if (await veroeffentlichtImZeitraum(vorher.employeeId, vorher.validFrom, vorher.validUntil)) {
    throw new BusinessRuleError('In diesem Zeitraum gibt es veröffentlichte Abrechnungen — das Profil bleibt als Beleg. Beenden statt löschen.');
  }
  await prisma.withholdingTaxProfile.delete({ where: { id: vorher.id } });
  await markiereVeraltet({ employeeId: vorher.employeeId }, 'Quellensteuerprofil entfernt');
  await audit.deleted({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'WithholdingTaxProfile',
    entityId: vorher.id,
    summary: 'Quellensteuerprofil entfernt',
    ip: params.ip,
  });
  return { id: vorher.id, deleted: true };
}

// ---------------------------------------------------------------------------
//  Quellensteuer: Tarif
// ---------------------------------------------------------------------------

export async function listWithholdingRates(params: { organizationId: string; canton?: string; year?: number; tariffCode?: string }) {
  const where: Prisma.WithholdingTaxRateWhereInput = {
    organizationId: params.organizationId,
    ...(params.canton ? { canton: params.canton } : {}),
    ...(params.year ? { year: params.year } : {}),
    ...(params.tariffCode ? { tariffCode: params.tariffCode } : {}),
  };
  const [zeilen, stapel] = await Promise.all([
    prisma.withholdingTaxRate.findMany({
      where,
      orderBy: [{ year: 'desc' }, { canton: 'asc' }, { tariffCode: 'asc' }, { incomeFrom: 'asc' }],
      take: 1000,
    }),
    prisma.withholdingTaxRate.groupBy({
      by: ['importBatch', 'canton', 'year', 'source', 'verification'],
      where,
      _count: { _all: true },
    }),
  ]);
  return {
    zeilen,
    stapel: stapel.map((s) => ({
      importBatch: s.importBatch,
      canton: s.canton,
      year: s.year,
      source: s.source,
      verification: s.verification,
      zeilen: s._count._all,
    })),
  };
}

/**
 * Einen Tarifausschnitt einlesen — als ein Stapel, ungeprüft.
 *
 * **Kein Überschreiben.** Liegt für Kanton, Jahr, Tarif und Einkommensstufe
 * schon eine Zeile vor, wird der ganze Stapel abgelehnt: Ein neuer Tarif
 * während des Jahres wäre eine Zeile, die frühere Monate rückwirkend anders
 * aussehen liesse. Die Kantone veröffentlichen einen Tarif je Jahr.
 */
export async function importWithholdingRates(params: {
  organizationId: string;
  actorId: string;
  ip?: string | null;
  input: WithholdingRateImportInput;
}) {
  const { input } = params;
  const stapel = randomUUID();
  try {
    await prisma.withholdingTaxRate.createMany({
      data: input.rows.map((z) => ({
        organizationId: params.organizationId,
        canton: input.canton,
        year: input.year,
        tariffCode: z.tariffCode,
        incomeFrom: z.incomeFrom,
        incomeTo: z.incomeTo ?? null,
        ratePct: z.ratePct,
        source: input.source,
        reference: input.reference ?? null,
        importBatch: stapel,
        createdById: params.actorId,
      })),
    });
  } catch (fehler) {
    if (isUniqueConstraintError(fehler)) {
      throw new BusinessRuleError('Für mindestens eine Tarifstufe liegt bereits eine Zeile vor. Der Stapel wurde nicht eingelesen.');
    }
    throw fehler;
  }
  await markiereVeraltet(
    { year: input.year, employee: { organizationId: params.organizationId, withholdingProfiles: { some: { canton: input.canton } } } },
    'Quellensteuertarif eingelesen',
  );
  await audit.created({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'WithholdingTaxRate',
    entityId: stapel,
    summary: `Quellensteuertarif ${input.canton} ${input.year} eingelesen: ${input.rows.length} Zeile(n), Quelle: ${input.source}`,
    ip: params.ip,
  });
  return { importBatch: stapel, zeilen: input.rows.length };
}

export async function verifyWithholdingRates(params: {
  organizationId: string;
  importBatch: string;
  note: string;
  actorId: string;
  ip?: string | null;
}) {
  const treffer = await prisma.withholdingTaxRate.updateMany({
    where: { organizationId: params.organizationId, importBatch: params.importBatch },
    data: { verification: 'GEPRUEFT' },
  });
  if (treffer.count === 0) throw new NotFoundError('Tarifstapel');
  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'WithholdingTaxRate',
    entityId: params.importBatch,
    summary: `Quellensteuertarif (${treffer.count} Zeilen) als geprüft bestätigt: ${params.note}`,
    ip: params.ip,
  });
  return { importBatch: params.importBatch, geprueft: treffer.count };
}
