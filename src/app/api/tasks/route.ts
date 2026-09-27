import { defineRoute, searchQuery } from '@/lib/api/handler';
import { buildPagination, created, paginated } from '@/lib/api/response';
import { prisma, type Prisma } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';
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
      // Seit 2026-09-27 — vorher stand hier keine Organisation, und die Liste
      // zeigte die Aufgaben jeder Organisation.
      organizationId: await getOrganizationId(),
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
    const organizationId = await getOrganizationId();

    /**
     * Jeder Verweis muss zur eigenen Organisation gehören (2026-09-27).
     *
     * Vorher gingen die Kennungen ungeprüft in die Zeile: Eine Aufgabe an
     * fremder Kundschaft entstand mit 201 und zeigte deren Namen danach in der
     * eigenen Aufgabenliste. Eine fremde Kennung ist hier von einer erfundenen
     * nicht zu unterscheiden — beides ist 404.
     */
    const [person, kunde, anfrage, einsatz] = await Promise.all([
      body.assigneeId ? prisma.user.count({ where: { id: body.assigneeId, organizationId, deletedAt: null } }) : 1,
      body.customerId ? prisma.customer.count({ where: { id: body.customerId, organizationId, deletedAt: null } }) : 1,
      body.leadId ? prisma.lead.count({ where: { id: body.leadId, organizationId, deletedAt: null } }) : 1,
      body.jobId ? prisma.job.count({ where: { id: body.jobId, organizationId, deletedAt: null } }) : 1,
    ]);
    if (!person) throw new NotFoundError('Person');
    if (!kunde) throw new NotFoundError('Kundschaft');
    if (!anfrage) throw new NotFoundError('Anfrage');
    if (!einsatz) throw new NotFoundError('Einsatz');

    const task = await prisma.task.create({
      data: {
        organizationId,
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
