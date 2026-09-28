import { defineRoute } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { prisma, type Prisma } from '@/lib/db';
import { ForbiddenError } from '@/lib/errors';
import { createThreadSchema } from '@/lib/validation/messaging';
import { threadListQuery } from '@/lib/validation/queries';
import { openThread } from '@/server/services/message.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * GET /api/messages — Nachrichtenverläufe.
 *
 * Sichtbarkeit ergibt sich aus der Rolle, nicht aus einem Query-Parameter:
 * Kundschaft sieht ausschliesslich die eigenen Threads, das Büro sieht alle.
 * Wer die Einschränkung ins Frontend legt, hat sie irgendwann nicht mehr.
 */
export const GET = defineRoute({
  permissions: ['message:read', 'message:read_own'],
  anyPermission: true,
  query: threadListQuery,
  rateLimit: 'apiRead',
  handler: async ({ query, session }) => {
    // Die Organisation steht vor jeder Rollenregel (2026-09-27). Vorher filterte
    // die Liste gar nicht danach, und das Büro sah die Verläufe jeder
    // Organisation — der Rollenfilter darunter engt nur *innerhalb* ein.
    const where: Prisma.MessageThreadWhereInput = {
      organizationId: await getOrganizationId(),
      ...(query.status === 'all' ? {} : { closed: query.status === 'closed' }),
    };

    if (session.role === 'CUSTOMER') {
      const customer = await prisma.customer.findFirst({
        where: { userId: session.id },
        select: { id: true },
      });
      if (!customer) throw new ForbiddenError('Kein Kundenkonto verknüpft.');
      where.customerId = customer.id;
    }

    /**
     * Mitarbeitende haben `message:read_own`, nicht `message:read`: Sie sehen
     * die Verläufe zu den *eigenen* Einsätzen, nicht die Korrespondenz des
     * ganzen Kundenstamms. Ohne diese Bedingung fiel diese Rolle durch — der
     * Filter kannte nur die Kundschaft, und wer weder Kundschaft noch Büro
     * war, bekam alles.
     */
    if (session.role === 'EMPLOYEE') {
      where.job = {
        assignments: { some: { employeeId: session.profileId ?? '__keines__' } },
      };
    }

    const threads = await prisma.messageThread.findMany({
      where,
      orderBy: { lastMessageAt: 'desc' },
      take: 100,
      include: {
        customer: { select: { id: true, firstName: true, lastName: true, companyName: true } },
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { body: true, createdAt: true, authorType: true, readAt: true },
        },
        _count: { select: { messages: true } },
      },
    });

    return ok(
      threads.map((thread) => ({
        id: thread.id,
        subject: thread.subject,
        closed: thread.closed,
        lastMessageAt: thread.lastMessageAt,
        messageCount: thread._count.messages,
        customer: thread.customer,
        preview: thread.messages[0] ?? null,
      })),
    );
  },
});

/**
 * POST /api/messages — neuen Verlauf eröffnen.
 *
 * Die Regeln (Sicht, Einsatz- und Buchungsbezug, Mitteilung ans Büro) stehen
 * in `openThread` (`message.service.ts`); hier bleibt, was HTTP ist.
 */
export const POST = defineRoute({
  permissions: ['message:create', 'message:write_own'],
  anyPermission: true,
  body: createThreadSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session }) => created(await openThread({ session, input: body })),
});
