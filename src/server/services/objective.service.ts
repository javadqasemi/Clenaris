import 'server-only';

import type { KpiPeriod, ObjectiveStatus, Prisma } from '@prisma/client';

import { prisma, toNumber } from '@/lib/db';
import { audit } from '@/lib/audit';
import { can } from '@/lib/auth/rbac';
import type { SessionUser } from '@/lib/auth/session';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { keyResultProgress } from '@/lib/bi/math';
import { addDays, periodOf, today, type PeriodName } from '@/lib/bi/periods';
import type {
  CreateKeyResultInput,
  CreateObjectiveInput,
  KeyResultCheckinInput,
  ObjectiveListQuery,
  ObjectiveTaskInput,
  UpdateKeyResultInput,
  UpdateObjectiveInput,
} from '@/lib/validation/bi-objectives';
import { notify } from './notification.service';

/**
 * Ziele — Strategie, OKR und Roadmap in einem Modell.
 *
 * Sichtbarkeit: das Büro (`objective:read`) sieht alles; Mitarbeitende
 * (`objective:read_own`) sehen die eigenen Ziele und die freigegebenen
 * Firmenziele — nicht die Bereichs- oder persönlichen Ziele anderer. Die
 * Einschränkung steht in der `where`-Klausel, nie im Rendering.
 */

export function objectiveVisibilityWhere(session: SessionUser, organizationId: string): Prisma.ObjectiveWhereInput {
  const base: Prisma.ObjectiveWhereInput = { organizationId, deletedAt: null };
  if (can(session.role, 'objective:read')) return base;
  if (can(session.role, 'objective:read_own')) {
    return {
      ...base,
      OR: [{ ownerId: session.id }, { level: 'COMPANY', status: { in: ['ACTIVE', 'AT_RISK', 'ACHIEVED'] } }],
    };
  }
  return { ...base, id: '__keines__' };
}

const ARCHIVED: ObjectiveStatus[] = ['ACHIEVED', 'MISSED', 'CANCELLED'];

const listInclude = {
  owner: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
  parent: { select: { id: true, title: true, horizon: true } },
  _count: { select: { keyResults: true, children: true, tasks: true } },
} satisfies Prisma.ObjectiveInclude;

export async function listObjectives(session: SessionUser, organizationId: string, query: ObjectiveListQuery) {
  const where: Prisma.ObjectiveWhereInput = {
    AND: [
      objectiveVisibilityWhere(session, organizationId),
      query.horizon ? { horizon: query.horizon } : {},
      query.level ? { level: query.level } : {},
      query.status ? { status: query.status } : query.archiv === '1' ? {} : { status: { notIn: ARCHIVED } },
      query.fiscalYear ? { fiscalYear: query.fiscalYear } : {},
      query.quarter ? { quarter: query.quarter } : {},
      query.ownerId ? { ownerId: query.ownerId } : {},
      query.parentId ? { parentId: query.parentId } : {},
      query.q ? { OR: [{ title: { contains: query.q, mode: 'insensitive' } }, { department: { contains: query.q, mode: 'insensitive' } }] } : {},
    ],
  };
  const [items, total] = await Promise.all([
    prisma.objective.findMany({
      where,
      include: listInclude,
      orderBy: [{ horizon: 'asc' }, { priority: 'desc' }, { endsOn: 'asc' }, { createdAt: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.objective.count({ where }),
  ]);
  return { items, total };
}

export async function getObjective(session: SessionUser, organizationId: string, id: string) {
  const objective = await prisma.objective.findFirst({
    where: { ...objectiveVisibilityWhere(session, organizationId), id },
    include: {
      ...listInclude,
      keyResults: {
        orderBy: { sortOrder: 'asc' },
        include: {
          definition: { select: { id: true, key: true, label: true, unit: true } },
          checkins: { orderBy: { recordedAt: 'desc' }, take: 12, include: { author: { select: { firstName: true, lastName: true } } } },
        },
      },
      children: { where: { deletedAt: null }, include: listInclude, orderBy: { endsOn: 'asc' } },
      tasks: { orderBy: [{ status: 'asc' }, { dueAt: 'asc' }], include: { assignee: { select: { firstName: true, lastName: true } } } },
      files: { orderBy: { createdAt: 'desc' } },
      meetings: { where: { deletedAt: null }, orderBy: { heldAt: 'desc' }, take: 10, select: { id: true, title: true, heldAt: true } },
    },
  });
  if (!objective) throw new NotFoundError('Ziel');
  return objective;
}

function nextReview(intervalDays: number | null | undefined, from = today()): Date | null {
  return intervalDays ? addDays(from, intervalDays) : null;
}

export async function createObjective(session: SessionUser, organizationId: string, input: CreateObjectiveInput) {
  if (input.parentId) {
    const parent = await prisma.objective.findFirst({ where: { id: input.parentId, organizationId, deletedAt: null } });
    if (!parent) throw new NotFoundError('Übergeordnetes Ziel');
  }
  const objective = await prisma.objective.create({
    data: {
      organizationId,
      horizon: input.horizon,
      level: input.level,
      status: input.status,
      title: input.title,
      description: input.description ?? null,
      department: input.department ?? null,
      priority: input.priority,
      parentId: input.parentId ?? null,
      ownerId: input.ownerId ?? null,
      fiscalYear: input.fiscalYear ?? null,
      quarter: input.quarter ?? null,
      startsOn: input.startsOn ?? null,
      endsOn: input.endsOn ?? null,
      reviewIntervalDays: input.reviewIntervalDays ?? null,
      nextReviewAt: nextReview(input.reviewIntervalDays),
      budgetAmount: input.budgetAmount ?? null,
      expectedRoiPct: input.expectedRoiPct ?? null,
      createdById: session.id,
    },
  });
  await audit.created({ organizationId, userId: session.id, entity: 'Objective', entityId: objective.id, summary: `Ziel „${objective.title}" angelegt` });
  if (objective.ownerId && objective.ownerId !== session.id) {
    await notify({
      userId: objective.ownerId,
      channels: ['IN_APP'],
      title: 'Neues Ziel in Ihrer Verantwortung',
      body: objective.title,
      link: `/admin/fuehrung/ziele/${objective.id}`,
      entity: 'Objective',
      entityId: objective.id,
    });
  }
  return objective;
}

export async function updateObjective(session: SessionUser, organizationId: string, id: string, input: UpdateObjectiveInput) {
  const before = await prisma.objective.findFirst({ where: { id, organizationId, deletedAt: null } });
  if (!before) throw new NotFoundError('Ziel');
  if (input.parentId === id) throw new BusinessRuleError('Ein Ziel kann nicht sein eigenes übergeordnetes Ziel sein.');

  const objective = await prisma.objective.update({
    where: { id },
    data: {
      ...(input.horizon !== undefined ? { horizon: input.horizon } : {}),
      ...(input.level !== undefined ? { level: input.level } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description || null } : {}),
      ...(input.department !== undefined ? { department: input.department || null } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
      ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
      ...(input.fiscalYear !== undefined ? { fiscalYear: input.fiscalYear } : {}),
      ...(input.quarter !== undefined ? { quarter: input.quarter } : {}),
      ...(input.startsOn !== undefined ? { startsOn: input.startsOn } : {}),
      ...(input.endsOn !== undefined ? { endsOn: input.endsOn } : {}),
      ...(input.reviewIntervalDays !== undefined
        ? { reviewIntervalDays: input.reviewIntervalDays, nextReviewAt: nextReview(input.reviewIntervalDays) }
        : {}),
      ...(input.budgetAmount !== undefined ? { budgetAmount: input.budgetAmount } : {}),
      ...(input.expectedRoiPct !== undefined ? { expectedRoiPct: input.expectedRoiPct } : {}),
    },
  });
  await audit.updated({
    organizationId,
    userId: session.id,
    entity: 'Objective',
    entityId: id,
    summary: `Ziel „${objective.title}" geändert`,
    changes: input,
  });
  if (input.ownerId && input.ownerId !== before.ownerId && input.ownerId !== session.id) {
    await notify({
      userId: input.ownerId,
      channels: ['IN_APP'],
      title: 'Ziel Ihnen zugewiesen',
      body: objective.title,
      link: `/admin/fuehrung/ziele/${objective.id}`,
      entity: 'Objective',
      entityId: objective.id,
    });
  }
  return objective;
}

/** Papierkorb statt Löschung — Ziele hängen an Sitzungen, Aufgaben und Check-ins. */
export async function deleteObjective(session: SessionUser, organizationId: string, id: string) {
  const objective = await prisma.objective.findFirst({ where: { id, organizationId, deletedAt: null } });
  if (!objective) throw new NotFoundError('Ziel');
  await prisma.objective.update({ where: { id }, data: { deletedAt: new Date() } });
  await audit.deleted({ organizationId, userId: session.id, entity: 'Objective', entityId: id, summary: `Ziel „${objective.title}" gelöscht` });
}

/** Kopie als Entwurf — mit Schlüsselergebnissen, ohne Verlauf. */
export async function duplicateObjective(session: SessionUser, organizationId: string, id: string) {
  const source = await prisma.objective.findFirst({
    where: { id, organizationId, deletedAt: null },
    include: { keyResults: true },
  });
  if (!source) throw new NotFoundError('Ziel');
  const copy = await prisma.objective.create({
    data: {
      organizationId,
      horizon: source.horizon,
      level: source.level,
      status: 'DRAFT',
      title: `${source.title} (Kopie)`,
      description: source.description,
      department: source.department,
      priority: source.priority,
      parentId: source.parentId,
      ownerId: source.ownerId,
      fiscalYear: source.fiscalYear,
      quarter: source.quarter,
      startsOn: source.startsOn,
      endsOn: source.endsOn,
      reviewIntervalDays: source.reviewIntervalDays,
      nextReviewAt: nextReview(source.reviewIntervalDays),
      budgetAmount: source.budgetAmount,
      expectedRoiPct: source.expectedRoiPct,
      createdById: session.id,
      keyResults: {
        create: source.keyResults.map((kr) => ({
          title: kr.title,
          kpiDefinitionId: kr.kpiDefinitionId,
          kpiPeriod: kr.kpiPeriod,
          unit: kr.unit,
          direction: kr.direction,
          startValue: kr.startValue,
          targetValue: kr.targetValue,
          currentValue: kr.startValue,
          progressPct: 0,
          sortOrder: kr.sortOrder,
        })),
      },
    },
  });
  await audit.created({ organizationId, userId: session.id, entity: 'Objective', entityId: copy.id, summary: `Ziel „${source.title}" dupliziert` });
  return copy;
}

/** Prüfung abschliessen — der nächste Termin rückt um den Zyklus nach hinten. */
export async function markObjectiveReviewed(session: SessionUser, organizationId: string, id: string, note?: string) {
  const objective = await prisma.objective.findFirst({ where: { id, organizationId, deletedAt: null } });
  if (!objective) throw new NotFoundError('Ziel');
  const updated = await prisma.objective.update({
    where: { id },
    data: { lastReviewedAt: today(), nextReviewAt: nextReview(objective.reviewIntervalDays) },
  });
  await audit.updated({ organizationId, userId: session.id, entity: 'Objective', entityId: id, summary: `Ziel „${objective.title}" geprüft${note ? `: ${note}` : ''}` });
  return updated;
}

// ---------------------------------------------------------------------------
//  Zeitachse
// ---------------------------------------------------------------------------

export async function getObjectiveTimeline(
  session: SessionUser,
  organizationId: string,
  filter: { from?: Date; to?: Date; horizon?: string; status?: string },
) {
  return prisma.objective.findMany({
    where: {
      ...objectiveVisibilityWhere(session, organizationId),
      ...(filter.horizon ? { horizon: filter.horizon as never } : {}),
      ...(filter.status ? { status: filter.status as never } : { status: { notIn: ['CANCELLED'] } }),
      OR: [
        { AND: [{ startsOn: { not: null } }, ...(filter.to ? [{ startsOn: { lte: filter.to } }] : []), ...(filter.from ? [{ endsOn: { gte: filter.from } }] : [])] },
        { AND: [{ startsOn: null }, { fiscalYear: { not: null } }] },
      ],
    },
    include: listInclude,
    orderBy: [{ startsOn: 'asc' }, { fiscalYear: 'asc' }, { quarter: 'asc' }],
  });
}

// ---------------------------------------------------------------------------
//  Schlüsselergebnisse
// ---------------------------------------------------------------------------

/**
 * Fortschritt des Ziels aus seinen Schlüsselergebnissen nachführen; ohne
 * Schlüsselergebnisse aus den untergeordneten Zielen. Als Spalte, weil
 * Listen und Zeitachse sonst je Zeile nachladen müssten.
 */
export async function recomputeObjectiveProgress(objectiveId: string): Promise<number> {
  const objective = await prisma.objective.findUnique({
    where: { id: objectiveId },
    include: {
      keyResults: { select: { progressPct: true } },
      children: { where: { deletedAt: null, status: { not: 'CANCELLED' } }, select: { progressPct: true } },
    },
  });
  if (!objective) return 0;
  const source = objective.keyResults.length > 0 ? objective.keyResults : objective.children;
  const progress = source.length > 0 ? Math.round(source.reduce((sum, x) => sum + x.progressPct, 0) / source.length) : objective.progressPct;
  await prisma.objective.update({ where: { id: objectiveId }, data: { progressPct: progress } });
  if (objective.parentId) await recomputeObjectiveProgress(objective.parentId);
  return progress;
}

async function requireObjectiveForWrite(session: SessionUser, organizationId: string, objectiveId: string) {
  const objective = await prisma.objective.findFirst({
    where: { ...objectiveVisibilityWhere(session, organizationId), id: objectiveId },
  });
  if (!objective) throw new NotFoundError('Ziel');
  return objective;
}

export async function createKeyResult(session: SessionUser, organizationId: string, objectiveId: string, input: CreateKeyResultInput) {
  await requireObjectiveForWrite(session, organizationId, objectiveId);
  let unit = input.unit;
  let direction = input.direction;
  if (input.kpiDefinitionId) {
    const definition = await prisma.kpiDefinition.findFirst({ where: { id: input.kpiDefinitionId, organizationId } });
    if (!definition) throw new NotFoundError('Kennzahl');
    unit = definition.unit;
    direction = definition.direction;
  }
  const current = input.currentValue ?? input.startValue;
  const keyResult = await prisma.keyResult.create({
    data: {
      objectiveId,
      title: input.title,
      kpiDefinitionId: input.kpiDefinitionId ?? null,
      kpiPeriod: (input.kpiPeriod ?? null) as KpiPeriod | null,
      unit,
      direction,
      startValue: input.startValue,
      targetValue: input.targetValue,
      currentValue: current,
      progressPct: keyResultProgress(input.startValue, input.targetValue, current, direction),
      sortOrder: input.sortOrder,
    },
  });
  if (keyResult.kpiDefinitionId) await syncAutomaticKeyResult(keyResult.id);
  await recomputeObjectiveProgress(objectiveId);
  return keyResult;
}

export async function updateKeyResult(session: SessionUser, organizationId: string, id: string, input: UpdateKeyResultInput) {
  const keyResult = await prisma.keyResult.findFirst({
    where: { id, objective: objectiveVisibilityWhere(session, organizationId) },
  });
  if (!keyResult) throw new NotFoundError('Schlüsselergebnis');
  const start = input.startValue ?? toNumber(keyResult.startValue);
  const target = input.targetValue ?? toNumber(keyResult.targetValue);
  const current = input.currentValue ?? toNumber(keyResult.currentValue);
  const direction = input.direction ?? keyResult.direction;
  const updated = await prisma.keyResult.update({
    where: { id },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.kpiDefinitionId !== undefined ? { kpiDefinitionId: input.kpiDefinitionId } : {}),
      ...(input.kpiPeriod !== undefined ? { kpiPeriod: input.kpiPeriod as KpiPeriod | null } : {}),
      ...(input.unit !== undefined ? { unit: input.unit } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      direction,
      startValue: start,
      targetValue: target,
      currentValue: current,
      progressPct: keyResultProgress(start, target, current, direction),
    },
  });
  await recomputeObjectiveProgress(keyResult.objectiveId);
  return updated;
}

export async function deleteKeyResult(session: SessionUser, organizationId: string, id: string) {
  const keyResult = await prisma.keyResult.findFirst({
    where: { id, objective: objectiveVisibilityWhere(session, organizationId) },
  });
  if (!keyResult) throw new NotFoundError('Schlüsselergebnis');
  await prisma.keyResult.delete({ where: { id } });
  await recomputeObjectiveProgress(keyResult.objectiveId);
}

/**
 * Check-in: ein Wert mit Kommentar. Bei automatischen Schlüsselergebnissen
 * wird abgewiesen — der Nachtlauf schreibt dort, und ein Handwert würde am
 * nächsten Morgen überschrieben, ohne dass jemand es merkt.
 */
export async function checkinKeyResult(session: SessionUser, organizationId: string, id: string, input: KeyResultCheckinInput) {
  const keyResult = await prisma.keyResult.findFirst({
    where: { id, objective: objectiveVisibilityWhere(session, organizationId) },
    include: { objective: { select: { id: true, ownerId: true, level: true } } },
  });
  if (!keyResult) throw new NotFoundError('Schlüsselergebnis');
  if (keyResult.kpiDefinitionId) {
    throw new BusinessRuleError('Dieses Schlüsselergebnis misst sich an einer Kennzahl und wird vom Nachtlauf nachgeführt. Ein Kommentar ist möglich, ein Handwert nicht.');
  }
  // Mitarbeitende dürfen nur an eigenen Zielen einchecken — Firmenziele sind
  // für sie lesbar, aber nicht ihre Verantwortung.
  if (!can(session.role, 'objective:update') && keyResult.objective.ownerId !== session.id) {
    throw new NotFoundError('Schlüsselergebnis');
  }
  const progress = keyResultProgress(toNumber(keyResult.startValue), toNumber(keyResult.targetValue), input.value, keyResult.direction);
  const [checkin] = await prisma.$transaction([
    prisma.keyResultCheckin.create({
      data: { keyResultId: id, value: input.value, comment: input.comment ?? null, automatic: false, authorId: session.id },
    }),
    prisma.keyResult.update({ where: { id }, data: { currentValue: input.value, progressPct: progress, lastCheckinAt: new Date() } }),
  ]);
  await recomputeObjectiveProgress(keyResult.objectiveId);
  return checkin;
}

/** Automatische Schlüsselergebnisse aus dem jüngsten Snapshot nachführen. */
export async function syncAutomaticKeyResult(keyResultId: string): Promise<boolean> {
  const keyResult = await prisma.keyResult.findUnique({ where: { id: keyResultId } });
  if (!keyResult || !keyResult.kpiDefinitionId || !keyResult.kpiPeriod) return false;
  const snapshot = await prisma.kpiSnapshot.findFirst({
    where: { definitionId: keyResult.kpiDefinitionId, period: keyResult.kpiPeriod },
    orderBy: { periodStart: 'desc' },
  });
  if (!snapshot) return false;
  const value = toNumber(snapshot.value);
  if (value === toNumber(keyResult.currentValue) && keyResult.lastCheckinAt) return false;
  const progress = keyResultProgress(toNumber(keyResult.startValue), toNumber(keyResult.targetValue), value, keyResult.direction);
  await prisma.$transaction([
    prisma.keyResultCheckin.create({ data: { keyResultId, value, automatic: true } }),
    prisma.keyResult.update({ where: { id: keyResultId }, data: { currentValue: value, progressPct: progress, lastCheckinAt: new Date() } }),
  ]);
  return true;
}

export async function syncAllAutomaticKeyResults(organizationId: string): Promise<number> {
  const keyResults = await prisma.keyResult.findMany({
    where: { kpiDefinitionId: { not: null }, objective: { organizationId, deletedAt: null, status: { in: ['ACTIVE', 'AT_RISK', 'DRAFT'] } } },
    select: { id: true, objectiveId: true },
  });
  let updated = 0;
  const touched = new Set<string>();
  for (const kr of keyResults) {
    if (await syncAutomaticKeyResult(kr.id)) {
      updated += 1;
      touched.add(kr.objectiveId);
    }
  }
  for (const objectiveId of touched) await recomputeObjectiveProgress(objectiveId);
  return updated;
}

// ---------------------------------------------------------------------------
//  Massnahmen als Aufgaben
// ---------------------------------------------------------------------------

export async function createObjectiveTask(session: SessionUser, organizationId: string, objectiveId: string, input: ObjectiveTaskInput) {
  const objective = await requireObjectiveForWrite(session, organizationId, objectiveId);
  const task = await prisma.task.create({
    data: {
      title: input.title,
      description: input.description ?? null,
      priority: input.priority,
      dueAt: input.dueAt ?? null,
      reminderAt: input.dueAt ? new Date(input.dueAt.getTime() - 86_400_000) : null,
      assigneeId: input.assigneeId ?? objective.ownerId ?? null,
      creatorId: session.id,
      objectiveId,
    },
  });
  if (task.assigneeId && task.assigneeId !== session.id) {
    await notify({
      userId: task.assigneeId,
      channels: ['IN_APP'],
      title: 'Neue Massnahme zu einem Ziel',
      body: `${task.title} — ${objective.title}`,
      link: `/admin/fuehrung/ziele/${objectiveId}`,
      entity: 'Task',
      entityId: task.id,
    });
  }
  return task;
}

// ---------------------------------------------------------------------------
//  Für Cockpit und Portal
// ---------------------------------------------------------------------------

export async function getObjectiveSummary(organizationId: string) {
  const now = new Date();
  const q = periodOf('QUARTER' as PeriodName, now);
  const [byStatus, dueReviews, quarterObjectives] = await Promise.all([
    prisma.objective.groupBy({ by: ['status'], where: { organizationId, deletedAt: null }, _count: { _all: true } }),
    prisma.objective.count({ where: { organizationId, deletedAt: null, status: { in: ['ACTIVE', 'AT_RISK'] }, nextReviewAt: { lt: today() } } }),
    prisma.objective.findMany({
      where: {
        organizationId,
        deletedAt: null,
        horizon: 'OBJECTIVE',
        status: { in: ['ACTIVE', 'AT_RISK'] },
        OR: [{ fiscalYear: q.periodStart.getUTCFullYear(), quarter: Math.floor(q.periodStart.getUTCMonth() / 3) + 1 }, { endsOn: { gte: q.periodStart, lte: q.periodEnd } }],
      },
      include: listInclude,
      orderBy: { progressPct: 'asc' },
      take: 6,
    }),
  ]);
  const counts = Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])) as Record<string, number>;
  return { counts, dueReviews, quarterObjectives, quarterLabel: q.label };
}
