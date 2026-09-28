import 'server-only';

import type { PayrollRate, PayrollRateCode, Prisma } from '@prisma/client';

import { audit, diff } from '@/lib/audit';
import { prisma, toNumber } from '@/lib/db';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { SAETZE_2026, type ArbeitgeberSaetze, type BeitragsSaetze } from '@/lib/payroll/beitraege';
import type { PayrollRateCreateInput, PayrollRateUpdateInput } from '@/lib/validation/payroll';

import { markiereVeraltet } from './payroll-veraltet';

/**
 * Versionierte Beitragssätze (Wave 9, 2026-09-23).
 *
 * ---------------------------------------------------------------------------
 *  Was vorher war
 * ---------------------------------------------------------------------------
 *
 * Eine Zeile je Jahr (`PayrollSetting`) — ohne Arbeitgeberanteile, ohne
 * Herkunft, und „geprüft" hiess „irgendwann einmal bearbeitet"
 * (`updatedAt !== createdAt`). Ein Satzwechsel mitten im Jahr war nicht
 * abbildbar, und eine spätere Änderung hätte die Herleitung veröffentlichter
 * Abrechnungen verfälscht.
 *
 * ---------------------------------------------------------------------------
 *  Was jetzt gilt
 * ---------------------------------------------------------------------------
 *
 *  • **Je Beitragsart Versionen mit `validFrom`/`validUntil`**, ohne
 *    Überschneidung (Ausschlussbedingung in der Datenbank). Gerechnet wird mit
 *    der Version, die am **letzten Tag** des Abrechnungsmonats gilt.
 *  • **Arbeitnehmer- und Arbeitgeberanteil**, Schwellen, BVG-Parameter.
 *  • **Herkunft und Prüfstand** je Version: `source`, `reference`,
 *    `verification`. Eine Änderung der Werte setzt den Prüfstand zurück.
 *  • **Unveränderlich, sobald benutzt:** Eine Version, mit der eine
 *    veröffentlichte Abrechnung gerechnet wurde, behält ihre Werte (Dienst und
 *    Trigger). Der Weg ist eine neue Version mit späterem Beginn.
 *  • **Fehlt eine Version**, legt der Lauf eine **ungeprüfte** Vorbelegung an
 *    — mit der Herkunft im Text. Sie abzulehnen hiesse, die Arbeit an den
 *    Monatsletzten zu verschieben und dort Druck zu erzeugen, irgendetwas
 *    einzutragen. Veröffentlicht werden kann mit ungeprüften Sätzen nur mit
 *    ausdrücklicher Bestätigung.
 */

export const ALLE_ARTEN: readonly PayrollRateCode[] = [
  'AHV_IV_EO',
  'ALV',
  'ALV_SOLIDARITY',
  'UVG_NBU',
  'UVG_BU',
  'KTG',
  'FAK',
  'VK',
  'BVG',
];

export const ART_BESCHRIFTUNG: Record<PayrollRateCode, string> = {
  AHV_IV_EO: 'AHV/IV/EO',
  ALV: 'ALV bis Grenze',
  ALV_SOLIDARITY: 'ALV über Grenze (Solidarität)',
  UVG_NBU: 'UVG Nichtberufsunfall',
  UVG_BU: 'UVG Berufsunfall',
  KTG: 'Krankentaggeld',
  FAK: 'Familienausgleichskasse',
  VK: 'Verwaltungskosten Ausgleichskasse',
  BVG: 'Berufliche Vorsorge',
};

interface BvgParameter {
  eintrittsschwelle: number;
  koordinationsabzug: number;
  mindestKoordiniert: number;
  obergrenze: number;
  baender: { abAlter: number; satz: number }[];
}

const VORBELEGUNG_QUELLE = 'Vorbelegung Clenaris (Stand 2026) — ungeprüft, fachlich zu bestätigen';

/**
 * Die Vorbelegung je Art. **Keine Wahrheit** — dieselben Werte, die bisher als
 * Jahresvorgabe galten (`SAETZE_2026`), und für die bisher nicht erfassten
 * Arbeitgeberarten (UVG-BU, FAK, VK) **null**: Ein Satz, den niemand kennt,
 * wird nicht geraten, sondern bleibt 0 und ungeprüft sichtbar.
 */
function vorbelegung(code: PayrollRateCode): {
  employeePct: number;
  employerPct: number;
  thresholdMin?: number;
  thresholdMax?: number;
  parameters?: BvgParameter;
} {
  switch (code) {
    case 'AHV_IV_EO':
      return { employeePct: SAETZE_2026.ahvIvEo, employerPct: SAETZE_2026.ahvIvEo };
    case 'ALV':
      return { employeePct: SAETZE_2026.alv, employerPct: SAETZE_2026.alv, thresholdMax: SAETZE_2026.alvGrenzeJahr };
    case 'ALV_SOLIDARITY':
      return { employeePct: SAETZE_2026.alvUeberGrenze, employerPct: SAETZE_2026.alvUeberGrenze, thresholdMin: SAETZE_2026.alvGrenzeJahr };
    case 'UVG_NBU':
      return { employeePct: SAETZE_2026.uvgNbu, employerPct: 0 };
    case 'BVG':
      return {
        employeePct: SAETZE_2026.bvgAnteilArbeitnehmer,
        employerPct: 100 - SAETZE_2026.bvgAnteilArbeitnehmer,
        parameters: {
          eintrittsschwelle: SAETZE_2026.bvgEintrittsschwelle,
          koordinationsabzug: SAETZE_2026.bvgKoordinationsabzug,
          mindestKoordiniert: SAETZE_2026.bvgMindestKoordiniert,
          obergrenze: SAETZE_2026.bvgObergrenze,
          baender: SAETZE_2026.bvgSaetze,
        },
      };
    default:
      return { employeePct: 0, employerPct: 0 };
  }
}

/** Ein Kalendertag als UTC-Mitternacht (`@db.Date`). */
function tag(jahr: number, monat0: number, tagImMonat: number): Date {
  return new Date(Date.UTC(jahr, monat0, tagImMonat));
}

function plusTage(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

export function letzterTagDesMonats(jahr: number, monat: number): Date {
  return tag(jahr, monat, 0);
}

function gilt(v: { validFrom: Date; validUntil: Date | null }, stichtag: Date): boolean {
  return v.validFrom.getTime() <= stichtag.getTime() && (v.validUntil === null || v.validUntil.getTime() >= stichtag.getTime());
}

function bvgParameter(v: PayrollRate): BvgParameter {
  const p = (v.parameters ?? {}) as Partial<BvgParameter>;
  const baender = Array.isArray(p.baender)
    ? p.baender
        .filter((b): b is { abAlter: number; satz: number } => typeof b?.abAlter === 'number' && typeof b?.satz === 'number')
        .sort((a, b) => a.abAlter - b.abAlter)
    : [];
  return {
    eintrittsschwelle: Number(p.eintrittsschwelle ?? SAETZE_2026.bvgEintrittsschwelle),
    koordinationsabzug: Number(p.koordinationsabzug ?? SAETZE_2026.bvgKoordinationsabzug),
    mindestKoordiniert: Number(p.mindestKoordiniert ?? SAETZE_2026.bvgMindestKoordiniert),
    obergrenze: Number(p.obergrenze ?? SAETZE_2026.bvgObergrenze),
    baender: baender.length > 0 ? baender : SAETZE_2026.bvgSaetze,
  };
}

/**
 * Eine fehlende Version für den Stichtag anlegen — als ungeprüfte Lückenfüllung
 * zwischen der vorigen und der nächsten Version, höchstens für das Jahr des
 * Stichtags. Werte: die der vorigen Version, sonst die Vorbelegung.
 */
async function lueckeFuellen(organizationId: string, code: PayrollRateCode, stichtag: Date): Promise<PayrollRate> {
  const jahr = stichtag.getUTCFullYear();
  const [vorige, naechste] = await Promise.all([
    prisma.payrollRate.findFirst({
      where: { organizationId, code, validUntil: { lt: stichtag } },
      orderBy: { validUntil: 'desc' },
    }),
    prisma.payrollRate.findFirst({
      where: { organizationId, code, validFrom: { gt: stichtag } },
      orderBy: { validFrom: 'asc' },
    }),
  ]);
  const jahresbeginn = tag(jahr, 0, 1);
  const jahresende = tag(jahr, 11, 31);
  const von =
    vorige?.validUntil && vorige.validUntil.getTime() >= jahresbeginn.getTime() ? plusTage(vorige.validUntil, 1) : jahresbeginn;
  const bis = naechste && naechste.validFrom.getTime() <= jahresende.getTime() ? plusTage(naechste.validFrom, -1) : jahresende;

  const werte = vorige
    ? {
        employeePct: vorige.employeePct,
        employerPct: vorige.employerPct,
        thresholdMin: vorige.thresholdMin,
        thresholdMax: vorige.thresholdMax,
        parameters: (vorige.parameters ?? undefined) as Prisma.InputJsonValue | undefined,
        source: `Übernommen aus der Version ab ${vorige.validFrom.toISOString().slice(0, 10)} — ungeprüft, für ${jahr} zu bestätigen`,
      }
    : (() => {
        const v = vorbelegung(code);
        return {
          employeePct: v.employeePct,
          employerPct: v.employerPct,
          thresholdMin: v.thresholdMin ?? null,
          thresholdMax: v.thresholdMax ?? null,
          parameters: v.parameters as unknown as Prisma.InputJsonValue | undefined,
          source: VORBELEGUNG_QUELLE,
        };
      })();

  try {
    return await prisma.payrollRate.create({
      data: { organizationId, code, validFrom: von, validUntil: bis, verification: 'UNGEPRUEFT', ...werte },
    });
  } catch (fehler) {
    // Ein gleichzeitiger Lauf hat die Lücke eben gefüllt (Ausschlussbedingung).
    const vorhanden = await prisma.payrollRate.findFirst({
      where: { organizationId, code, validFrom: { lte: stichtag }, OR: [{ validUntil: null }, { validUntil: { gte: stichtag } }] },
    });
    if (vorhanden) return vorhanden;
    throw fehler;
  }
}

export interface SaetzeZumStichtag {
  saetze: BeitragsSaetze;
  arbeitgeber: ArbeitgeberSaetze;
  versionIds: string[];
  ungeprueft: PayrollRateCode[];
  momentaufnahme: Record<string, unknown>;
}

/**
 * Die Sätze, die am Stichtag gelten — mit den Versionskennungen für die
 * Abrechnung und der Liste der ungeprüften Arten.
 */
export async function saetzeZumStichtag(organizationId: string, stichtag: Date): Promise<SaetzeZumStichtag> {
  const gueltig = await prisma.payrollRate.findMany({
    where: { organizationId, validFrom: { lte: stichtag }, OR: [{ validUntil: null }, { validUntil: { gte: stichtag } }] },
  });
  const jeArt = new Map<PayrollRateCode, PayrollRate>();
  for (const v of gueltig) jeArt.set(v.code, v);
  for (const code of ALLE_ARTEN) {
    if (!jeArt.has(code)) jeArt.set(code, await lueckeFuellen(organizationId, code, stichtag));
  }

  const v = (code: PayrollRateCode) => jeArt.get(code)!;
  const bvg = bvgParameter(v('BVG'));
  const alvGrenze = toNumber(v('ALV').thresholdMax) || SAETZE_2026.alvGrenzeJahr;

  const saetze: BeitragsSaetze = {
    ahvIvEo: toNumber(v('AHV_IV_EO').employeePct),
    alv: toNumber(v('ALV').employeePct),
    alvGrenzeJahr: alvGrenze,
    alvUeberGrenze: toNumber(v('ALV_SOLIDARITY').employeePct),
    uvgNbu: toNumber(v('UVG_NBU').employeePct),
    ktg: toNumber(v('KTG').employeePct),
    bvgEintrittsschwelle: bvg.eintrittsschwelle,
    bvgKoordinationsabzug: bvg.koordinationsabzug,
    bvgMindestKoordiniert: bvg.mindestKoordiniert,
    bvgObergrenze: bvg.obergrenze,
    bvgSaetze: bvg.baender,
    bvgAnteilArbeitnehmer: toNumber(v('BVG').employeePct),
  };
  const arbeitgeber: ArbeitgeberSaetze = {
    ahvIvEo: toNumber(v('AHV_IV_EO').employerPct),
    alv: toNumber(v('ALV').employerPct),
    alvUeberGrenze: toNumber(v('ALV_SOLIDARITY').employerPct),
    uvgNbu: toNumber(v('UVG_NBU').employerPct),
    uvgBu: toNumber(v('UVG_BU').employerPct),
    ktg: toNumber(v('KTG').employerPct),
    fak: toNumber(v('FAK').employerPct),
    vk: toNumber(v('VK').employerPct),
  };

  const versionen = ALLE_ARTEN.map((code) => v(code));
  return {
    saetze,
    arbeitgeber,
    versionIds: versionen.map((x) => x.id),
    ungeprueft: versionen.filter((x) => x.verification !== 'GEPRUEFT').map((x) => x.code),
    momentaufnahme: Object.fromEntries(
      versionen.map((x) => [
        x.code,
        {
          id: x.id,
          gueltigAb: x.validFrom.toISOString().slice(0, 10),
          gueltigBis: x.validUntil?.toISOString().slice(0, 10) ?? null,
          arbeitnehmerPct: toNumber(x.employeePct),
          arbeitgeberPct: toNumber(x.employerPct),
          quelle: x.source,
          referenz: x.reference,
          pruefstand: x.verification,
        },
      ]),
    ),
  };
}

// ---------------------------------------------------------------------------
//  Pflege
// ---------------------------------------------------------------------------

/** Wurde die Version für eine veröffentlichte Abrechnung benutzt? Mit dem spätesten Monat. */
async function benutzung(id: string): Promise<{ benutzt: boolean; spaetestesMonatsende: Date | null }> {
  const abrechnungen = await prisma.payslip.findMany({
    where: { published: true, rateVersionIds: { has: id } },
    select: { year: true, month: true },
    orderBy: [{ year: 'desc' }, { month: 'desc' }],
    take: 1,
  });
  const letzte = abrechnungen[0];
  return { benutzt: Boolean(letzte), spaetestesMonatsende: letzte ? letzterTagDesMonats(letzte.year, letzte.month) : null };
}

export async function listPayrollRates(params: { organizationId: string; year?: number; code?: PayrollRateCode }) {
  const where: Prisma.PayrollRateWhereInput = { organizationId: params.organizationId };
  if (params.code) where.code = params.code;
  if (params.year) {
    where.validFrom = { lte: tag(params.year, 11, 31) };
    where.OR = [{ validUntil: null }, { validUntil: { gte: tag(params.year, 0, 1) } }];
  }
  const versionen = await prisma.payrollRate.findMany({ where, orderBy: [{ code: 'asc' }, { validFrom: 'asc' }] });
  return Promise.all(
    versionen.map(async (v) => ({ ...v, benutzt: (await benutzung(v.id)).benutzt, beschriftung: ART_BESCHRIFTUNG[v.code] })),
  );
}

function werteAusEingabe(input: PayrollRateCreateInput | PayrollRateUpdateInput) {
  const daten: Prisma.PayrollRateUncheckedUpdateInput = {};
  if (input.employeePct !== undefined) daten.employeePct = input.employeePct;
  if (input.employerPct !== undefined) daten.employerPct = input.employerPct;
  if (input.thresholdMin !== undefined) daten.thresholdMin = input.thresholdMin;
  if (input.thresholdMax !== undefined) daten.thresholdMax = input.thresholdMax;
  if (input.parameters !== undefined) daten.parameters = (input.parameters ?? undefined) as Prisma.InputJsonValue | undefined;
  if (input.source !== undefined) daten.source = input.source;
  if (input.reference !== undefined) daten.reference = input.reference ?? null;
  return daten;
}

/**
 * Eine neue Version anlegen. Eine offene oder überlappende Vorgängerin wird
 * am Vortag geschlossen — aber nur, wenn dadurch kein veröffentlichter Monat
 * seine Version verliert.
 */
export async function createPayrollRate(params: {
  organizationId: string;
  actorId: string;
  ip?: string | null;
  input: PayrollRateCreateInput;
}) {
  const { input } = params;
  const beginn = new Date(`${input.validFrom}T00:00:00Z`);
  const ende = input.validUntil ? new Date(`${input.validUntil}T00:00:00Z`) : null;
  if (ende && ende < beginn) throw new BusinessRuleError('Das Ende liegt vor dem Beginn.');
  if (input.code === 'BVG' && input.employeePct !== undefined && input.employeePct > 50) {
    throw new BusinessRuleError('Der Betrieb trägt gesetzlich mindestens die Hälfte der Altersgutschrift (Art. 66 BVG).');
  }

  const vorgaengerin = await prisma.payrollRate.findFirst({
    where: {
      organizationId: params.organizationId,
      code: input.code,
      validFrom: { lt: beginn },
      OR: [{ validUntil: null }, { validUntil: { gte: beginn } }],
    },
  });
  if (vorgaengerin) {
    const { spaetestesMonatsende } = await benutzung(vorgaengerin.id);
    if (spaetestesMonatsende && spaetestesMonatsende.getTime() >= beginn.getTime()) {
      throw new BusinessRuleError(
        `Die bisherige Version gilt für bereits veröffentlichte Abrechnungen bis ${spaetestesMonatsende.toISOString().slice(0, 10)}. ` +
          'Eine neue Version kann frühestens am Tag danach beginnen.',
      );
    }
  }

  const neu = await prisma.$transaction(async (tx) => {
    if (vorgaengerin) {
      await tx.payrollRate.update({ where: { id: vorgaengerin.id }, data: { validUntil: plusTage(beginn, -1) } });
    }
    try {
      return await tx.payrollRate.create({
        data: {
          organizationId: params.organizationId,
          code: input.code,
          validFrom: beginn,
          validUntil: ende,
          employeePct: input.employeePct ?? 0,
          employerPct: input.employerPct ?? 0,
          thresholdMin: input.thresholdMin ?? null,
          thresholdMax: input.thresholdMax ?? null,
          parameters: (input.parameters ?? undefined) as Prisma.InputJsonValue | undefined,
          source: input.source,
          reference: input.reference ?? null,
          createdById: params.actorId,
        },
      });
    } catch (fehler) {
      if (String(fehler).includes('payroll_rates_ueberlappungsfrei') || String(fehler).includes('23P01')) {
        throw new BusinessRuleError('Für diesen Zeitraum gibt es bereits eine spätere Version. Passen Sie deren Beginn an oder wählen Sie ein Ende.');
      }
      throw fehler;
    }
  });

  // Unveröffentlichte Monate ab dem Beginn rechnen mit einer anderen Version als gespeichert.
  const ab = { jahr: beginn.getUTCFullYear(), monat: beginn.getUTCMonth() + 1 };
  await markiereVeraltet(
    {
      employee: { organizationId: params.organizationId },
      OR: [{ year: { gt: ab.jahr } }, { year: ab.jahr, month: { gte: ab.monat } }],
    },
    `neue Satzversion ${ART_BESCHRIFTUNG[neu.code]}`,
  );

  await audit.created({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'PayrollRate',
    entityId: neu.id,
    summary: `Satzversion ${ART_BESCHRIFTUNG[neu.code]} ab ${input.validFrom} angelegt (${input.source})`,
    ip: params.ip,
  });
  return neu;
}

/** Eine noch nicht benutzte Version ändern. Setzt den Prüfstand zurück. */
export async function updatePayrollRate(params: {
  organizationId: string;
  id: string;
  actorId: string;
  ip?: string | null;
  input: PayrollRateUpdateInput;
}) {
  const vorher = await prisma.payrollRate.findFirst({ where: { id: params.id, organizationId: params.organizationId } });
  if (!vorher) throw new NotFoundError('Satzversion');
  if ((await benutzung(vorher.id)).benutzt) {
    throw new BusinessRuleError(
      'Mit dieser Version wurde bereits eine veröffentlichte Abrechnung gerechnet. Legen Sie eine neue Version mit späterem Beginn an.',
    );
  }
  if (vorher.code === 'BVG' && params.input.employeePct !== undefined && params.input.employeePct > 50) {
    throw new BusinessRuleError('Der Betrieb trägt gesetzlich mindestens die Hälfte der Altersgutschrift (Art. 66 BVG).');
  }
  const daten = werteAusEingabe(params.input);
  const nachher = await prisma.payrollRate.update({
    where: { id: vorher.id },
    data: { ...daten, verification: 'UNGEPRUEFT', verifiedAt: null, verifiedById: null, verificationNote: null },
  });
  await markiereVeraltet({ rateVersionIds: { has: nachher.id } }, `Satz ${ART_BESCHRIFTUNG[nachher.code]} geändert`);
  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'PayrollRate',
    entityId: nachher.id,
    summary: `Satzversion ${ART_BESCHRIFTUNG[nachher.code]} ab ${nachher.validFrom.toISOString().slice(0, 10)} geändert — Prüfstand zurückgesetzt`,
    changes: diff(
      Object.fromEntries(Object.keys(daten).map((k) => [k, (vorher as unknown as Record<string, unknown>)[k]])),
      daten as Record<string, unknown>,
      'PayrollRate',
    ),
    ip: params.ip,
  });
  return nachher;
}

/**
 * Eine Version als fachlich geprüft bestätigen — mit Vermerk, wer und worauf
 * gestützt. Ändert keinen Betrag; deshalb auch an einer benutzten Version
 * zulässig.
 */
export async function verifyPayrollRate(params: {
  organizationId: string;
  id: string;
  actorId: string;
  ip?: string | null;
  note: string;
}) {
  const vorher = await prisma.payrollRate.findFirst({ where: { id: params.id, organizationId: params.organizationId } });
  if (!vorher) throw new NotFoundError('Satzversion');
  const nachher = await prisma.payrollRate.update({
    where: { id: vorher.id },
    data: { verification: 'GEPRUEFT', verifiedAt: new Date(), verifiedById: params.actorId, verificationNote: params.note },
  });
  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'PayrollRate',
    entityId: nachher.id,
    summary: `Satzversion ${ART_BESCHRIFTUNG[nachher.code]} ab ${nachher.validFrom.toISOString().slice(0, 10)} als geprüft bestätigt: ${params.note}`,
    ip: params.ip,
  });
  return nachher;
}

export { gilt as versionGiltAm };
