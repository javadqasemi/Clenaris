import { defineRoute, idParam } from '@/lib/api/handler';
import { audit } from '@/lib/audit';
import { noContent, ok } from '@/lib/api/response';
import { prisma } from '@/lib/db';
import { ForbiddenError, NotFoundError } from '@/lib/errors';
import { updateTaskSchema } from '@/lib/validation/crm';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * PATCH /api/tasks/:id
 *
 * Mitarbeitende dürfen nur die ihnen zugewiesenen Aufgaben ändern.
 * Administration und Leitung dürfen alle.
 */
export const PATCH = defineRoute({
  permissions: ['task:update'],
  params: idParam,
  body: updateTaskSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const organizationId = await getOrganizationId();
    const task = await prisma.task.findFirst({ where: { id: params.id, organizationId } });
    if (!task) throw new NotFoundError('Aufgabe');

    if (session.role === 'EMPLOYEE' && task.assigneeId !== session.id) {
      throw new ForbiddenError('Diese Aufgabe ist Ihnen nicht zugewiesen.');
    }

    // Eine Neuzuweisung nur an eine Person der eigenen Organisation.
    if (body.assigneeId && !(await prisma.user.count({ where: { id: body.assigneeId, organizationId, deletedAt: null } }))) {
      throw new NotFoundError('Person');
    }

    const updated = await prisma.task.update({
      where: { id: task.id },
      data: {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.priority !== undefined ? { priority: body.priority } : {}),
        ...(body.dueAt !== undefined ? { dueAt: body.dueAt } : {}),
        ...(body.assigneeId !== undefined ? { assigneeId: body.assigneeId } : {}),
        ...(body.status !== undefined
          ? {
              status: body.status,
              completedAt: body.status === 'DONE' ? new Date() : null,
            }
          : {}),
      },
    });

    return ok({ id: updated.id, status: updated.status });
  },
});

/**
 * DELETE /api/tasks/:id — Aufgabe entfernen.
 *
 * Ohne fachliche Sperre: eine Aufgabe ist eine Notiz an sich selbst oder ans
 * Team, kein Beleg. Wer sie erledigt hat, schliesst sie ab; wer sie
 * irrtümlich angelegt hat, entfernt sie.
 *
 * Mitarbeitende dürfen nur eigene Aufgaben löschen — dieselbe Schranke wie
 * beim Ändern. Seit 2026-09-27 trägt `Task` eine `organizationId`; hier stand
 * vorher, die Zuordnung ergebe sich „aus der Session" — tatsächlich prüfte
 * niemand sie, und eine fremde Aufgabe liess sich löschen.
 */
export const DELETE = defineRoute({
  permissions: ['task:delete'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) => {
    const task = await prisma.task.findFirst({ where: { id: params.id, organizationId: await getOrganizationId() } });
    if (!task) throw new NotFoundError('Aufgabe');

    if (session.role === 'EMPLOYEE' && task.assigneeId !== session.id) {
      throw new ForbiddenError('Diese Aufgabe ist Ihnen nicht zugewiesen.');
    }

    await prisma.task.delete({ where: { id: task.id } });

    await audit.deleted({
      organizationId: session.organizationId,
      userId: session.id,
      entity: 'Task',
      entityId: params.id,
      summary: `Aufgabe „${task.title}" gelöscht`,
      ip,
    });

    return noContent();
  },
});
