import 'server-only';

import type { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db';
import { audit } from '@/lib/audit';
import type { SessionUser } from '@/lib/auth/session';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { riskBand, riskSeverity } from '@/lib/bi/math';
import { addDays, today } from '@/lib/bi/periods';
import type {
  ControlReviewInput,
  CreateActionInput,
  CreateControlInput,
  CreateRiskInput,
  RiskReviewInput,
  UpdateActionInput,
  UpdateControlInput,
  UpdateRiskInput,
} from '@/lib/validation/bi-governance';
import { notify } from './notification.service';

/**
 * Risiko, Kontrollen und Massnahmen.
 *
 * `severity` wird bei jedem Schreibvorgang aus `probability × impact`
 * gesetzt — in *einer* Funktion, damit es keine zweite Rechnung geben kann.
 * Prüfungen verschieben `nextReviewAt` um den Zyklus und hängen die Notiz an
 * ein Verlaufsfeld: wer wann was festgestellt hat, bleibt sichtbar.
 */

interface ReviewLogEntry {
  at: string;
  by: string | null;
  note: string | null;
  outcome?: string;
}

function appendLog(existing: unknown, entry: ReviewLogEntry): Prisma.InputJsonValue {
  const log = Array.isArray(existing) ? (existing as ReviewLogEntry[]) : [];
  return [entry, ...log].slice(0, 50) as unknown as Prisma.InputJsonValue;
}

const riskInclude = {
  owner: { select: { id: true, firstName: true, lastName: true } },
  _count: { select: { actions: true, files: true } },
} satisfies Prisma.RiskEntryInclude;

// ---------------------------------------------------------------------------
//  Risiken
// ---------------------------------------------------------------------------

export async function listRisks(
  organizationId: string,
  query: { q?: string; category?: string; status?: string; ownerId?: string; faellig?: string; page: number; pageSize: number; sort?: string; order: 'asc' | 'desc' },
) {
  const where: Prisma.RiskEntryWhereInput = {
    organizationId,
    deletedAt: null,
    ...(query.category ? { category: query.category as never } : {}),
    ...(query.status ? { status: query.status as never } : {}),
    ...(query.ownerId ? { ownerId: query.ownerId } : {}),
    ...(query.faellig === '1' ? { nextReviewAt: { lt: today() }, status: { not: 'CLOSED' } } : {}),
    ...(query.q ? { title: { contains: query.q, mode: 'insensitive' } } : {}),
  };
  const allowed = ['severity', 'title', 'nextReviewAt', 'category', 'status', 'updatedAt'];
  const field = query.sort && allowed.includes(query.sort) ? query.sort : 'severity';
  const [items, total] = await Promise.all([
    prisma.riskEntry.findMany({
      where,
      include: riskInclude,
      orderBy: [{ [field]: query.order }, { title: 'asc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.riskEntry.count({ where }),
  ]);
  return { items: items.map((r) => ({ ...r, band: riskBand(r.severity) })), total };
}

export async function getRisk(organizationId: string, id: string) {
  const risk = await prisma.riskEntry.findFirst({
    where: { id, organizationId, deletedAt: null },
    include: {
      ...riskInclude,
      actions: { orderBy: [{ completedAt: 'asc' }, { dueOn: 'asc' }], include: { task: { select: { id: true, status: true, assignee: { select: { firstName: true, lastName: true } } } } } },
      files: { orderBy: { createdAt: 'desc' } },
    },
  });
  if (!risk) throw new NotFoundError('Risiko');
  return { ...risk, band: riskBand(risk.severity), residualBand: risk.residualSeverity ? riskBand(risk.residualSeverity) : null };
}

export async function createRisk(session: SessionUser, organizationId: string, input: CreateRiskInput) {
  const residual = input.residualProbability && input.residualImpact ? riskSeverity(input.residualProbability, input.residualImpact) : null;
  const risk = await prisma.riskEntry.create({
    data: {
      organizationId,
      title: input.title,
      description: input.description ?? null,
      category: input.category,
      status: input.status,
      probability: input.probability,
      impact: input.impact,
      severity: riskSeverity(input.probability, input.impact),
      residualProbability: input.residualProbability ?? null,
      residualImpact: input.residualImpact ?? null,
      residualSeverity: residual,
      potentialLoss: input.potentialLoss ?? null,
      mitigationPlan: input.mitigationPlan ?? null,
      ownerId: input.ownerId ?? null,
      reviewIntervalDays: input.reviewIntervalDays,
      nextReviewAt: addDays(today(), input.reviewIntervalDays),
      createdById: session.id,
    },
  });
  await audit.created({ organizationId, userId: session.id, entity: 'RiskEntry', entityId: risk.id, summary: `Risiko „${risk.title}" erfasst (Schwere ${risk.severity})` });
  if (risk.ownerId && risk.ownerId !== session.id) {
    await notify({ userId: risk.ownerId, channels: ['IN_APP'], title: 'Risiko in Ihrer Verantwortung', body: risk.title, link: `/admin/fuehrung/risiken/${risk.id}`, entity: 'RiskEntry', entityId: risk.id });
  }
  return risk;
}

export async function updateRisk(session: SessionUser, organizationId: string, id: string, input: UpdateRiskInput) {
  const before = await prisma.riskEntry.findFirst({ where: { id, organizationId, deletedAt: null } });
  if (!before) throw new NotFoundError('Risiko');
  const probability = input.probability ?? before.probability;
  const impact = input.impact ?? before.impact;
  const rp = input.residualProbability === undefined ? before.residualProbability : input.residualProbability;
  const ri = input.residualImpact === undefined ? before.residualImpact : input.residualImpact;
  const risk = await prisma.riskEntry.update({
    where: { id },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description || null } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.status !== undefined ? { status: input.status, closedAt: input.status === 'CLOSED' ? new Date() : null } : {}),
      probability,
      impact,
      severity: riskSeverity(probability, impact),
      residualProbability: rp ?? null,
      residualImpact: ri ?? null,
      residualSeverity: rp && ri ? riskSeverity(rp, ri) : null,
      ...(input.potentialLoss !== undefined ? { potentialLoss: input.potentialLoss } : {}),
      ...(input.mitigationPlan !== undefined ? { mitigationPlan: input.mitigationPlan || null } : {}),
      ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
      ...(input.reviewIntervalDays !== undefined ? { reviewIntervalDays: input.reviewIntervalDays, nextReviewAt: addDays(before.lastReviewedAt ?? today(), input.reviewIntervalDays) } : {}),
    },
  });
  await audit.updated({ organizationId, userId: session.id, entity: 'RiskEntry', entityId: id, summary: `Risiko „${risk.title}" geändert`, changes: input });
  return risk;
}

export async function reviewRisk(session: SessionUser, organizationId: string, id: string, input: RiskReviewInput) {
  const before = await prisma.riskEntry.findFirst({ where: { id, organizationId, deletedAt: null } });
  if (!before) throw new NotFoundError('Risiko');
  const probability = input.probability ?? before.probability;
  const impact = input.impact ?? before.impact;
  const rp = input.residualProbability === undefined ? before.residualProbability : input.residualProbability;
  const ri = input.residualImpact === undefined ? before.residualImpact : input.residualImpact;
  const now = today();
  const risk = await prisma.riskEntry.update({
    where: { id },
    data: {
      probability,
      impact,
      severity: riskSeverity(probability, impact),
      residualProbability: rp ?? null,
      residualImpact: ri ?? null,
      residualSeverity: rp && ri ? riskSeverity(rp, ri) : null,
      ...(input.status ? { status: input.status, closedAt: input.status === 'CLOSED' ? new Date() : null } : before.status === 'IDENTIFIED' ? { status: 'ASSESSED' } : {}),
      lastReviewedAt: now,
      nextReviewAt: addDays(now, before.reviewIntervalDays),
      reviewLog: appendLog(before.reviewLog, { at: new Date().toISOString(), by: session.name, note: input.note ?? null }),
    },
  });
  await audit.updated({ organizationId, userId: session.id, entity: 'RiskEntry', entityId: id, summary: `Risiko „${risk.title}" geprüft` });
  return risk;
}

export async function deleteRisk(session: SessionUser, organizationId: string, id: string) {
  const risk = await prisma.riskEntry.findFirst({ where: { id, organizationId, deletedAt: null } });
  if (!risk) throw new NotFoundError('Risiko');
  await prisma.riskEntry.update({ where: { id }, data: { deletedAt: new Date() } });
  await audit.deleted({ organizationId, userId: session.id, entity: 'RiskEntry', entityId: id, summary: `Risiko „${risk.title}" gelöscht` });
}

/** 5×5-Matrix: Anzahl offener Risiken je Zelle, mit den Titeln für die Anzeige. */
export async function getRiskMatrix(organizationId: string) {
  const risks = await prisma.riskEntry.findMany({
    where: { organizationId, deletedAt: null, status: { not: 'CLOSED' } },
    select: { id: true, title: true, probability: true, impact: true, severity: true, category: true, status: true },
    orderBy: { severity: 'desc' },
  });
  const cells: Record<string, { probability: number; impact: number; risks: typeof risks }> = {};
  for (let p = 1; p <= 5; p += 1) for (let i = 1; i <= 5; i += 1) cells[`${p}-${i}`] = { probability: p, impact: i, risks: [] };
  for (const r of risks) cells[`${r.probability}-${r.impact}`].risks.push(r);
  const bands = { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
  for (const r of risks) bands[riskBand(r.severity)] += 1;
  return { cells: Object.values(cells), bands, total: risks.length, top: risks.slice(0, 5).map((r) => ({ ...r, band: riskBand(r.severity) })) };
}

// ---------------------------------------------------------------------------
//  Kontrollen
// ---------------------------------------------------------------------------

const controlInclude = {
  owner: { select: { id: true, firstName: true, lastName: true } },
  _count: { select: { actions: true, files: true } },
} satisfies Prisma.ControlEntryInclude;

export async function listControls(
  organizationId: string,
  query: { q?: string; kind?: string; status?: string; faellig?: string; page: number; pageSize: number },
) {
  const where: Prisma.ControlEntryWhereInput = {
    organizationId,
    deletedAt: null,
    ...(query.kind ? { kind: query.kind as never } : {}),
    ...(query.status ? { status: query.status as never } : {}),
    ...(query.faellig === '1' ? { nextReviewAt: { lt: today() }, status: { not: 'RETIRED' } } : {}),
    ...(query.q ? { OR: [{ title: { contains: query.q, mode: 'insensitive' } }, { reference: { contains: query.q, mode: 'insensitive' } }] } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.controlEntry.findMany({
      where,
      include: controlInclude,
      orderBy: [{ kind: 'asc' }, { nextReviewAt: 'asc' }, { title: 'asc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.controlEntry.count({ where }),
  ]);
  return { items, total };
}

export async function getControl(organizationId: string, id: string) {
  const control = await prisma.controlEntry.findFirst({
    where: { id, organizationId, deletedAt: null },
    include: {
      ...controlInclude,
      actions: { orderBy: [{ completedAt: 'asc' }, { dueOn: 'asc' }], include: { task: { select: { id: true, status: true } } } },
      files: { orderBy: { createdAt: 'desc' } },
    },
  });
  if (!control) throw new NotFoundError('Kontrolle');
  return control;
}

export async function createControl(session: SessionUser, organizationId: string, input: CreateControlInput) {
  const control = await prisma.controlEntry.create({
    data: {
      organizationId,
      kind: input.kind,
      status: input.status,
      reference: input.reference ?? null,
      title: input.title,
      description: input.description ?? null,
      evidenceNote: input.evidenceNote ?? null,
      ownerId: input.ownerId ?? null,
      reviewIntervalDays: input.reviewIntervalDays,
      nextReviewAt: addDays(today(), input.reviewIntervalDays),
    },
  });
  await audit.created({ organizationId, userId: session.id, entity: 'ControlEntry', entityId: control.id, summary: `Kontrolle „${control.title}" angelegt` });
  return control;
}

export async function updateControl(session: SessionUser, organizationId: string, id: string, input: UpdateControlInput) {
  const before = await prisma.controlEntry.findFirst({ where: { id, organizationId, deletedAt: null } });
  if (!before) throw new NotFoundError('Kontrolle');
  const control = await prisma.controlEntry.update({
    where: { id },
    data: {
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.reference !== undefined ? { reference: input.reference || null } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description || null } : {}),
      ...(input.evidenceNote !== undefined ? { evidenceNote: input.evidenceNote || null } : {}),
      ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
      ...(input.reviewIntervalDays !== undefined ? { reviewIntervalDays: input.reviewIntervalDays, nextReviewAt: addDays(before.lastReviewedAt ?? today(), input.reviewIntervalDays) } : {}),
    },
  });
  await audit.updated({ organizationId, userId: session.id, entity: 'ControlEntry', entityId: id, summary: `Kontrolle „${control.title}" geändert`, changes: input });
  return control;
}

export async function reviewControl(session: SessionUser, organizationId: string, id: string, input: ControlReviewInput) {
  const before = await prisma.controlEntry.findFirst({ where: { id, organizationId, deletedAt: null } });
  if (!before) throw new NotFoundError('Kontrolle');
  const now = today();
  const control = await prisma.controlEntry.update({
    where: { id },
    data: {
      status: input.outcome === 'NON_COMPLIANT' ? 'NON_COMPLIANT' : before.status === 'RETIRED' ? 'RETIRED' : 'ACTIVE',
      lastReviewedAt: now,
      nextReviewAt: addDays(now, before.reviewIntervalDays),
      reviewLog: appendLog(before.reviewLog, { at: new Date().toISOString(), by: session.name, note: input.note ?? null, outcome: input.outcome }),
    },
  });
  await audit.updated({ organizationId, userId: session.id, entity: 'ControlEntry', entityId: id, summary: `Kontrolle „${control.title}" geprüft: ${input.outcome === 'COMPLIANT' ? 'in Ordnung' : 'Abweichung'}` });
  return control;
}

export async function deleteControl(session: SessionUser, organizationId: string, id: string) {
  const control = await prisma.controlEntry.findFirst({ where: { id, organizationId, deletedAt: null } });
  if (!control) throw new NotFoundError('Kontrolle');
  await prisma.controlEntry.update({ where: { id }, data: { deletedAt: new Date() } });
  await audit.deleted({ organizationId, userId: session.id, entity: 'ControlEntry', entityId: id, summary: `Kontrolle „${control.title}" gelöscht` });
}

// ---------------------------------------------------------------------------
//  Massnahmen (CAPA)
// ---------------------------------------------------------------------------

const actionInclude = {
  risk: { select: { id: true, title: true } },
  control: { select: { id: true, title: true } },
  review: { select: { id: true, authorName: true, rating: true } },
  task: { select: { id: true, status: true, dueAt: true, assignee: { select: { id: true, firstName: true, lastName: true } } } },
} satisfies Prisma.CorrectiveActionInclude;

export async function listActions(organizationId: string, filter: { riskId?: string; controlId?: string; reviewId?: string; status: 'offen' | 'alle' }) {
  return prisma.correctiveAction.findMany({
    where: {
      organizationId,
      ...(filter.riskId ? { riskId: filter.riskId } : {}),
      ...(filter.controlId ? { controlId: filter.controlId } : {}),
      ...(filter.reviewId ? { reviewId: filter.reviewId } : {}),
      ...(filter.status === 'offen' ? { completedAt: null } : {}),
    },
    include: actionInclude,
    orderBy: [{ completedAt: 'asc' }, { dueOn: 'asc' }, { createdAt: 'desc' }],
  });
}

export async function createAction(session: SessionUser, organizationId: string, input: CreateActionInput) {
  // Die Bezugsobjekte müssen zum Mandanten gehören — sonst liesse sich eine
  // Massnahme an ein fremdes Risiko hängen.
  if (input.riskId && !(await prisma.riskEntry.findFirst({ where: { id: input.riskId, organizationId } }))) throw new NotFoundError('Risiko');
  if (input.controlId && !(await prisma.controlEntry.findFirst({ where: { id: input.controlId, organizationId } }))) throw new NotFoundError('Kontrolle');
  if (input.reviewId && !(await prisma.review.findFirst({ where: { id: input.reviewId, organizationId } }))) throw new NotFoundError('Bewertung');

  const action = await prisma.$transaction(async (tx) => {
    // Die Durchführung läuft über `Task`: Frist, Zuweisung, Erinnerung und
    // Benachrichtigung sind dort gelöst. Ein zweites Aufgabensystem hätte zwei
    // Pendenzenlisten bedeutet, von denen eine immer übersehen wird.
    const task = input.assigneeId
      ? await tx.task.create({
          data: {
            title: `Massnahme: ${input.title}`,
            description: input.description ?? null,
            priority: input.priority,
            dueAt: input.dueOn ?? null,
            reminderAt: input.dueOn ? new Date(input.dueOn.getTime() - 2 * 86_400_000) : null,
            assigneeId: input.assigneeId,
            creatorId: session.id,
          },
        })
      : null;
    return tx.correctiveAction.create({
      data: {
        organizationId,
        kind: input.kind,
        title: input.title,
        rootCause: input.rootCause ?? null,
        description: input.description ?? null,
        riskId: input.riskId ?? null,
        controlId: input.controlId ?? null,
        reviewId: input.reviewId ?? null,
        taskId: task?.id ?? null,
        dueOn: input.dueOn ?? null,
        createdById: session.id,
      },
      include: actionInclude,
    });
  });
  if (input.assigneeId && input.assigneeId !== session.id) {
    await notify({ userId: input.assigneeId, channels: ['IN_APP'], title: 'Neue Massnahme', body: action.title, link: '/admin/fuehrung/massnahmen', entity: 'CorrectiveAction', entityId: action.id });
  }
  await audit.created({ organizationId, userId: session.id, entity: 'CorrectiveAction', entityId: action.id, summary: `Massnahme „${action.title}" eröffnet` });
  return action;
}

export async function updateAction(session: SessionUser, organizationId: string, id: string, input: UpdateActionInput) {
  const before = await prisma.correctiveAction.findFirst({ where: { id, organizationId }, include: { task: true } });
  if (!before) throw new NotFoundError('Massnahme');
  if (input.effectivenessChecked && !(input.completed ?? Boolean(before.completedAt))) {
    throw new BusinessRuleError('Die Wirksamkeit lässt sich erst prüfen, wenn die Massnahme abgeschlossen ist.');
  }
  const action = await prisma.$transaction(async (tx) => {
    if (before.task && (input.completed !== undefined || input.title !== undefined || input.dueOn !== undefined)) {
      await tx.task.update({
        where: { id: before.task.id },
        data: {
          ...(input.title !== undefined ? { title: `Massnahme: ${input.title}` } : {}),
          ...(input.dueOn !== undefined ? { dueAt: input.dueOn } : {}),
          ...(input.completed !== undefined ? { status: input.completed ? 'DONE' : 'OPEN', completedAt: input.completed ? new Date() : null } : {}),
        },
      });
    }
    return tx.correctiveAction.update({
      where: { id },
      data: {
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.rootCause !== undefined ? { rootCause: input.rootCause } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.dueOn !== undefined ? { dueOn: input.dueOn } : {}),
        ...(input.completed !== undefined ? { completedAt: input.completed ? (before.completedAt ?? new Date()) : null } : {}),
        ...(input.effectivenessChecked !== undefined ? { effectivenessCheckedAt: input.effectivenessChecked ? today() : null } : {}),
        ...(input.effectivenessNote !== undefined ? { effectivenessNote: input.effectivenessNote } : {}),
      },
      include: actionInclude,
    });
  });
  await audit.updated({ organizationId, userId: session.id, entity: 'CorrectiveAction', entityId: id, summary: `Massnahme „${action.title}" geändert`, changes: input });
  return action;
}

export async function getQualitySummary(organizationId: string) {
  const now = today();
  const [byKind, due, nonCompliant, openActions, overdueActions, complaints] = await Promise.all([
    prisma.controlEntry.groupBy({ by: ['kind'], where: { organizationId, deletedAt: null, status: { not: 'RETIRED' } }, _count: { _all: true } }),
    prisma.controlEntry.count({ where: { organizationId, deletedAt: null, status: { not: 'RETIRED' }, nextReviewAt: { lt: now } } }),
    prisma.controlEntry.count({ where: { organizationId, deletedAt: null, status: 'NON_COMPLIANT' } }),
    prisma.correctiveAction.count({ where: { organizationId, completedAt: null } }),
    prisma.correctiveAction.count({ where: { organizationId, completedAt: null, dueOn: { lt: now } } }),
    prisma.review.count({ where: { organizationId, rating: { lte: 2 }, createdAt: { gte: addDays(now, -90) } } }),
  ]);
  return {
    byKind: Object.fromEntries(byKind.map((k) => [k.kind, k._count._all])) as Record<string, number>,
    due,
    nonCompliant,
    openActions,
    overdueActions,
    complaints,
  };
}
