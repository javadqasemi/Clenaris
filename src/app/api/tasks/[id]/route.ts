import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { prisma } from '@/lib/db';
import { ForbiddenError, NotFoundError } from '@/lib/errors';
import { updateTaskSchema } from '@/lib/validation/crm';

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
    const task = await prisma.task.findUnique({ where: { id: params.id } });
    if (!task) throw new NotFoundError('Aufgabe');

    if (session.role === 'EMPLOYEE' && task.assigneeId !== session.id) {
      throw new ForbiddenError('Diese Aufgabe ist Ihnen nicht zugewiesen.');
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
