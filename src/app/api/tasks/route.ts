import { defineRoute, searchQuery } from '@/lib/api/handler';
import { buildPagination, created, paginated } from '@/lib/api/response';
import { prisma, type Prisma } from '@/lib/db';
import { createTaskSchema } from '@/lib/validation/crm';
import { getOrganizationId } from '@/server/services/organization.service';
import { notify } from '@/server/services/notification.service';

export const runtime = 'nodejs';

/** GET /api/tasks — offene Aufgaben. */
export const GET = defineRoute({
  permissions: ['task:read'],
  query: searchQuery,
  rateLimit: 'apiRead',
  handler: async ({ query, session }) => {
    const where: Prisma.TaskWhereInput = {
      status: { in: ['OPEN', 'IN_PROGRESS'] },
      ...(query.q ? { title: { contains: query.q, mode: 'insensitive' as const } } : {}),
      // Mitarbeitende sehen nur die eigenen Aufgaben.
      ...(session.role === 'EMPLOYEE' ? { assigneeId: session.id } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.task.findMany({
        where,
        orderBy: [{ dueAt: 'asc' }, { priority: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          assignee: { select: { firstName: true, lastName: true } },
        },
      }),
      prisma.task.count({ where }),
    ]);

    return paginated(items, buildPagination(query.page, query.pageSize, total));
  },
});

/**
 * POST /api/tasks
 *
 * Wer eine Aufgabe zugewiesen bekommt, wird sofort benachrichtigt — sonst
 * bleibt sie unbemerkt, bis jemand zufällig in die Liste schaut.
 */
export const POST = defineRoute({
  permissions: ['task:create'],
  body: createTaskSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session }) => {
    await getOrganizationId();

    const task = await prisma.task.create({
      data: {
        title: body.title,
        description: body.description ?? null,
        priority: body.priority,
        dueAt: body.dueAt ?? null,
        reminderAt: body.reminderAt ?? null,
        assigneeId: body.assigneeId ?? null,
        creatorId: session.id,
        customerId: body.customerId ?? null,
        leadId: body.leadId ?? null,
        jobId: body.jobId ?? null,
      },
    });

    if (task.assigneeId && task.assigneeId !== session.id) {
      await notify({
        userId: task.assigneeId,
        channels: ['IN_APP'],
        title: 'Neue Aufgabe',
        body: task.title,
        link: '/admin/aufgaben',
        entity: 'Task',
        entityId: task.id,
      });
    }

    return created({ id: task.id, title: task.title });
  },
});
