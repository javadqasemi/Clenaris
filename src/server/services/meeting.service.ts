import 'server-only';

import type { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db';
import { audit } from '@/lib/audit';
import type { SessionUser } from '@/lib/auth/session';
import { NotFoundError } from '@/lib/errors';
import type { CreateMeetingInput, UpdateMeetingInput } from '@/lib/validation/bi-knowledge';
import { notify } from './notification.service';

/**
 * Sitzungen.
 *
 * Pendenzen werden als echte `Task`-Zeilen angelegt, nicht als eigene
 * Unterliste: sonst gäbe es zwei Pendenzenlisten, und die im Protokoll wird
 * nach der Sitzung nie wieder geöffnet.
 */

const include = {
  participants: { include: { user: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } } } },
  objective: { select: { id: true, title: true } },
  tasks: { orderBy: [{ status: 'asc' as const }, { dueAt: 'asc' as const }], include: { assignee: { select: { id: true, firstName: true, lastName: true } } } },
  files: { orderBy: { createdAt: 'desc' as const } },
} satisfies Prisma.MeetingInclude;

export async function listMeetings(
  organizationId: string,
  query: { q?: string; from?: Date; to?: Date; objectiveId?: string; page: number; pageSize: number },
) {
  const where: Prisma.MeetingWhereInput = {
    organizationId,
    deletedAt: null,
    ...(query.objectiveId ? { objectiveId: query.objectiveId } : {}),
    ...(query.from || query.to ? { heldAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } } : {}),
    ...(query.q ? { OR: [{ title: { contains: query.q, mode: 'insensitive' } }, { decisions: { contains: query.q, mode: 'insensitive' } }, { minutes: { contains: query.q, mode: 'insensitive' } }] } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.meeting.findMany({
      where,
      include: { participants: { include: { user: { select: { firstName: true, lastName: true } } } }, _count: { select: { tasks: true } } },
      orderBy: { heldAt: 'desc' },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.meeting.count({ where }),
  ]);
  return { items, total };
}

export async function getMeeting(organizationId: string, id: string) {
  const meeting = await prisma.meeting.findFirst({ where: { id, organizationId, deletedAt: null }, include });
  if (!meeting) throw new NotFoundError('Sitzung');
  return meeting;
}

async function validParticipants(organizationId: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const users = await prisma.user.findMany({ where: { id: { in: ids }, organizationId, deletedAt: null }, select: { id: true } });
  return users.map((u) => u.id);
}

async function createActionItems(
  tx: Prisma.TransactionClient,
  session: SessionUser,
  meeting: { id: string; title: string },
  items: CreateMeetingInput['actionItems'],
) {
  const created = [];
  for (const item of items) {
    const task = await tx.task.create({
      data: {
        title: item.title,
        description: `Pendenz aus der Sitzung „${meeting.title}"`,
        priority: item.priority,
        dueAt: item.dueAt ?? null,
        reminderAt: item.dueAt ? new Date(item.dueAt.getTime() - 86_400_000) : null,
        assigneeId: item.assigneeId ?? null,
        creatorId: session.id,
        meetingId: meeting.id,
      },
    });
    created.push(task);
  }
  return created;
}

export async function createMeeting(session: SessionUser, organizationId: string, input: CreateMeetingInput) {
  const participantIds = await validParticipants(organizationId, input.participantIds);
  if (input.objectiveId && !(await prisma.objective.findFirst({ where: { id: input.objectiveId, organizationId, deletedAt: null } }))) {
    throw new NotFoundError('Ziel');
  }
  const { meeting, tasks } = await prisma.$transaction(async (tx) => {
    const created = await tx.meeting.create({
      data: {
        organizationId,
        title: input.title,
        heldAt: input.heldAt,
        location: input.location ?? null,
        agenda: input.agenda ?? null,
        minutes: input.minutes ?? null,
        decisions: input.decisions ?? null,
        guestNames: input.guestNames,
        objectiveId: input.objectiveId ?? null,
        createdById: session.id,
        participants: { create: participantIds.map((userId) => ({ userId })) },
      },
    });
    const createdTasks = await createActionItems(tx, session, created, input.actionItems);
    return { meeting: created, tasks: createdTasks };
  });
  for (const task of tasks) {
    if (task.assigneeId && task.assigneeId !== session.id) {
      await notify({ userId: task.assigneeId, channels: ['IN_APP'], title: 'Pendenz aus Sitzung', body: `${task.title} — ${meeting.title}`, link: `/admin/fuehrung/sitzungen/${meeting.id}`, entity: 'Task', entityId: task.id });
    }
  }
  await audit.created({ organizationId, userId: session.id, entity: 'Meeting', entityId: meeting.id, summary: `Sitzung „${meeting.title}" angelegt` });
  return meeting;
}

export async function updateMeeting(session: SessionUser, organizationId: string, id: string, input: UpdateMeetingInput) {
  const before = await prisma.meeting.findFirst({ where: { id, organizationId, deletedAt: null } });
  if (!before) throw new NotFoundError('Sitzung');
  const participantIds = input.participantIds ? await validParticipants(organizationId, input.participantIds) : null;
  const { meeting, tasks } = await prisma.$transaction(async (tx) => {
    if (participantIds) {
      await tx.meetingParticipant.deleteMany({ where: { meetingId: id } });
      await tx.meetingParticipant.createMany({ data: participantIds.map((userId) => ({ meetingId: id, userId })) });
    }
    const updated = await tx.meeting.update({
      where: { id },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.heldAt !== undefined ? { heldAt: input.heldAt } : {}),
        ...(input.location !== undefined ? { location: input.location } : {}),
        ...(input.agenda !== undefined ? { agenda: input.agenda } : {}),
        ...(input.minutes !== undefined ? { minutes: input.minutes } : {}),
        ...(input.decisions !== undefined ? { decisions: input.decisions } : {}),
        ...(input.guestNames !== undefined ? { guestNames: input.guestNames } : {}),
        ...(input.objectiveId !== undefined ? { objectiveId: input.objectiveId } : {}),
      },
    });
    const createdTasks = input.actionItems ? await createActionItems(tx, session, updated, input.actionItems) : [];
    return { meeting: updated, tasks: createdTasks };
  });
  for (const task of tasks) {
    if (task.assigneeId && task.assigneeId !== session.id) {
      await notify({ userId: task.assigneeId, channels: ['IN_APP'], title: 'Pendenz aus Sitzung', body: `${task.title} — ${meeting.title}`, link: `/admin/fuehrung/sitzungen/${meeting.id}`, entity: 'Task', entityId: task.id });
    }
  }
  await audit.updated({ organizationId, userId: session.id, entity: 'Meeting', entityId: id, summary: `Sitzung „${meeting.title}" geändert` });
  return meeting;
}

export async function deleteMeeting(session: SessionUser, organizationId: string, id: string) {
  const meeting = await prisma.meeting.findFirst({ where: { id, organizationId, deletedAt: null } });
  if (!meeting) throw new NotFoundError('Sitzung');
  await prisma.meeting.update({ where: { id }, data: { deletedAt: new Date() } });
  await audit.deleted({ organizationId, userId: session.id, entity: 'Meeting', entityId: id, summary: `Sitzung „${meeting.title}" gelöscht` });
}
