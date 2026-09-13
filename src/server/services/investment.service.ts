import 'server-only';

import type { Prisma } from '@prisma/client';

import { prisma, toNumber } from '@/lib/db';
import { audit } from '@/lib/audit';
import type { SessionUser } from '@/lib/auth/session';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { depreciation, depreciationSchedule, paybackYears, roiPct, type DepreciationResult } from '@/lib/bi/math';
import { today, wholeMonthsBetween } from '@/lib/bi/periods';
import type { CreateInvestmentInput, UpdateInvestmentInput } from '@/lib/validation/bi-finance';

/**
 * Investitionen — zugleich das Anlagenverzeichnis.
 *
 * Der Abschreibungsplan wird gerechnet, nicht gespeichert (`lib/bi/math`).
 * Dieser Dienst holt die Daten, prüft die Regeln und reicht an den Rechenkern
 * weiter.
 */

const include = {
  supplier: { select: { id: true, name: true } },
  owner: { select: { id: true, firstName: true, lastName: true } },
  _count: { select: { files: true } },
} satisfies Prisma.InvestmentInclude;

export type InvestmentRow = Prisma.InvestmentGetPayload<{ include: typeof include }>;

export interface InvestmentValuation extends DepreciationResult {
  monthsInService: number;
  paybackYears: number | null;
  roiPct: number | null;
}

export function valueInvestment(investment: {
  purchaseAmount: Prisma.Decimal | number;
  residualValue: Prisma.Decimal | number;
  usefulLifeYears: number | null;
  method: string;
  commissionedOn: Date | null;
  expectedAnnualBenefit: Prisma.Decimal | number | null;
  status: string;
}, asOf = today()): InvestmentValuation | null {
  const purchase = toNumber(investment.purchaseAmount);
  const residual = toNumber(investment.residualValue);
  // Ohne Inbetriebnahme gibt es nichts abzuschreiben — das Anlagenverzeichnis
  // zeigt den Anschaffungswert und den Hinweis, dass die Anlage noch nicht
  // läuft.
  const months = investment.commissionedOn ? wholeMonthsBetween(investment.commissionedOn, asOf) : 0;
  try {
    const result = depreciation({
      purchaseAmount: purchase,
      residualValue: residual,
      usefulLifeYears: investment.usefulLifeYears,
      method: investment.method as 'NONE' | 'STRAIGHT_LINE' | 'DECLINING',
      monthsInService: investment.commissionedOn ? months : 0,
    });
    return {
      ...result,
      monthsInService: months,
      paybackYears: paybackYears(purchase, investment.expectedAnnualBenefit === null ? null : toNumber(investment.expectedAnnualBenefit)),
      roiPct: roiPct(purchase, investment.expectedAnnualBenefit === null ? null : toNumber(investment.expectedAnnualBenefit)),
    };
  } catch {
    return null;
  }
}

export async function listInvestments(organizationId: string, filter: { status?: string; category?: string; q?: string }) {
  const items = await prisma.investment.findMany({
    where: {
      organizationId,
      deletedAt: null,
      ...(filter.status ? { status: filter.status as never } : {}),
      ...(filter.category ? { category: filter.category as never } : {}),
      ...(filter.q ? { OR: [{ name: { contains: filter.q, mode: 'insensitive' } }, { assetTag: { contains: filter.q, mode: 'insensitive' } }, { location: { contains: filter.q, mode: 'insensitive' } }] } : {}),
    },
    include,
    orderBy: [{ status: 'asc' }, { name: 'asc' }],
  });
  return items.map((item) => ({ ...item, valuation: valueInvestment(item) }));
}

export async function getInvestment(organizationId: string, id: string) {
  const investment = await prisma.investment.findFirst({
    where: { id, organizationId, deletedAt: null },
    include: { ...include, files: { orderBy: { createdAt: 'desc' } } },
  });
  if (!investment) throw new NotFoundError('Investition');
  return { ...investment, valuation: valueInvestment(investment) };
}

export function getDepreciationPlan(investment: { purchaseAmount: Prisma.Decimal | number; residualValue: Prisma.Decimal | number; usefulLifeYears: number | null; method: string }) {
  return depreciationSchedule({
    purchaseAmount: toNumber(investment.purchaseAmount),
    residualValue: toNumber(investment.residualValue),
    usefulLifeYears: investment.usefulLifeYears,
    method: investment.method as 'NONE' | 'STRAIGHT_LINE' | 'DECLINING',
  });
}

function assertMethodRules(input: { method: string; usefulLifeYears: number | null | undefined; residualValue: number; purchaseAmount: number }) {
  if (input.method !== 'NONE' && !input.usefulLifeYears) {
    throw new BusinessRuleError('Für eine lineare oder degressive Abschreibung braucht es die Nutzungsdauer in Jahren.');
  }
  if (input.method === 'DECLINING' && input.residualValue <= 0) {
    throw new BusinessRuleError('Die degressive Abschreibung braucht einen Restwert über null — sonst wäre die Anlage im ersten Monat abgeschrieben.');
  }
  if (input.residualValue > input.purchaseAmount) {
    throw new BusinessRuleError('Der Restwert darf den Anschaffungswert nicht übersteigen.');
  }
}

export async function createInvestment(session: SessionUser, organizationId: string, input: CreateInvestmentInput) {
  assertMethodRules({ method: input.method, usefulLifeYears: input.usefulLifeYears, residualValue: input.residualValue, purchaseAmount: input.purchaseAmount });
  const investment = await prisma.investment.create({
    data: {
      organizationId,
      name: input.name,
      category: input.category,
      status: input.status,
      description: input.description ?? null,
      supplierId: input.supplierId ?? null,
      purchaseAmount: input.purchaseAmount,
      plannedOn: input.plannedOn ?? null,
      purchasedOn: input.purchasedOn ?? null,
      commissionedOn: input.commissionedOn ?? null,
      disposedOn: input.disposedOn ?? null,
      disposalProceeds: input.disposalProceeds ?? null,
      method: input.method,
      usefulLifeYears: input.usefulLifeYears ?? null,
      residualValue: input.residualValue,
      expectedAnnualBenefit: input.expectedAnnualBenefit ?? null,
      assetTag: input.assetTag || null,
      location: input.location ?? null,
      ownerId: input.ownerId ?? null,
    },
  });
  await audit.created({ organizationId, userId: session.id, entity: 'Investment', entityId: investment.id, summary: `Investition „${investment.name}" über CHF ${toNumber(investment.purchaseAmount).toFixed(2)}` });
  return investment;
}

export async function updateInvestment(session: SessionUser, organizationId: string, id: string, input: UpdateInvestmentInput) {
  const before = await prisma.investment.findFirst({ where: { id, organizationId, deletedAt: null } });
  if (!before) throw new NotFoundError('Investition');
  assertMethodRules({
    method: input.method ?? before.method,
    usefulLifeYears: input.usefulLifeYears === undefined ? before.usefulLifeYears : input.usefulLifeYears,
    residualValue: input.residualValue ?? toNumber(before.residualValue),
    purchaseAmount: input.purchaseAmount ?? toNumber(before.purchaseAmount),
  });
  const investment = await prisma.investment.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.description !== undefined ? { description: input.description || null } : {}),
      ...(input.supplierId !== undefined ? { supplierId: input.supplierId } : {}),
      ...(input.purchaseAmount !== undefined ? { purchaseAmount: input.purchaseAmount } : {}),
      ...(input.plannedOn !== undefined ? { plannedOn: input.plannedOn } : {}),
      ...(input.purchasedOn !== undefined ? { purchasedOn: input.purchasedOn } : {}),
      ...(input.commissionedOn !== undefined ? { commissionedOn: input.commissionedOn } : {}),
      ...(input.disposedOn !== undefined ? { disposedOn: input.disposedOn } : {}),
      ...(input.disposalProceeds !== undefined ? { disposalProceeds: input.disposalProceeds } : {}),
      ...(input.method !== undefined ? { method: input.method } : {}),
      ...(input.usefulLifeYears !== undefined ? { usefulLifeYears: input.usefulLifeYears } : {}),
      ...(input.residualValue !== undefined ? { residualValue: input.residualValue } : {}),
      ...(input.expectedAnnualBenefit !== undefined ? { expectedAnnualBenefit: input.expectedAnnualBenefit } : {}),
      ...(input.assetTag !== undefined ? { assetTag: input.assetTag || null } : {}),
      ...(input.location !== undefined ? { location: input.location } : {}),
      ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
      // Wer eine Anlage ausbucht, ohne das Datum zu setzen, meint heute.
      ...(input.status === 'DISPOSED' && !input.disposedOn && !before.disposedOn ? { disposedOn: today() } : {}),
      ...(input.status === 'ACTIVE' && !input.commissionedOn && !before.commissionedOn ? { commissionedOn: today() } : {}),
    },
  });
  await audit.updated({ organizationId, userId: session.id, entity: 'Investment', entityId: id, summary: `Investition „${investment.name}" geändert`, changes: input });
  return investment;
}

export async function deleteInvestment(session: SessionUser, organizationId: string, id: string) {
  const investment = await prisma.investment.findFirst({ where: { id, organizationId, deletedAt: null } });
  if (!investment) throw new NotFoundError('Investition');
  await prisma.investment.update({ where: { id }, data: { deletedAt: new Date() } });
  await audit.deleted({ organizationId, userId: session.id, entity: 'Investment', entityId: id, summary: `Investition „${investment.name}" gelöscht` });
}

/** Anlagenverzeichnis: alle in Betrieb befindlichen Anlagen mit Restwert. */
export async function getAssetRegister(organizationId: string, asOf = today()) {
  const items = await prisma.investment.findMany({
    where: { organizationId, deletedAt: null, status: { in: ['ACTIVE', 'DISPOSED'] } },
    include,
    orderBy: [{ category: 'asc' }, { name: 'asc' }],
  });
  const rows = items.map((item) => ({ ...item, valuation: valueInvestment(item, asOf) }));
  const active = rows.filter((r) => r.status === 'ACTIVE');
  return {
    asOf,
    rows,
    totals: {
      purchase: active.reduce((s, r) => s + toNumber(r.purchaseAmount), 0),
      bookValue: active.reduce((s, r) => s + (r.valuation?.bookValue ?? toNumber(r.purchaseAmount)), 0),
      accumulated: active.reduce((s, r) => s + (r.valuation?.accumulated ?? 0), 0),
      annualCharge: active.reduce((s, r) => s + (r.valuation?.annualCharge ?? 0), 0),
    },
  };
}
