import { defineRoute } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { prisma, type Prisma } from '@/lib/db';
import { ForbiddenError, NotFoundError } from '@/lib/errors';
import { createThreadSchema } from '@/lib/validation/messaging';
import { threadListQuery } from '@/lib/validation/queries';
import { getOrganizationId } from '@/server/services/organization.service';
import { notifyStaff } from '@/server/services/notification.service';

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
    const where: Prisma.MessageThreadWhereInput = {
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
 * Der Thread wird immer an die Kundschaft gebunden, auch wenn ihn das Büro
 * anlegt: sonst taucht die Antwort im Kundenkonto nicht auf.
 */
export const POST = defineRoute({
  permissions: ['message:create', 'message:write_own'],
  anyPermission: true,
  body: createThreadSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session }) => {
    const organizationId = await getOrganizationId();

    const customer = await prisma.customer.findFirst({
      where: { userId: session.id },
      select: { id: true, firstName: true, lastName: true, companyName: true },
    });

    // Mitarbeitende ohne Kundenkonto dürfen nur zu einem Auftrag schreiben.
    if (!customer && !body.jobId) {
      throw new ForbiddenError(
        'Ohne verknüpftes Kundenkonto lässt sich nur zu einem Einsatz schreiben.',
      );
    }

    if (body.bookingId) {
      const booking = await prisma.booking.findFirst({
        where: {
          id: body.bookingId,
          ...(customer ? { customerId: customer.id } : {}),
        },
        select: { id: true },
      });
      if (!booking) throw new NotFoundError('Buchung');
    }

    const thread = await prisma.messageThread.create({
      data: {
        subject: body.subject,
        customerId: customer?.id ?? null,
        jobId: body.jobId ?? null,
        lastMessageAt: new Date(),
        messages: {
          create: {
            authorId: session.id,
            authorType: session.role === 'CUSTOMER' ? 'CUSTOMER' : 'STAFF',
            body: body.body,
          },
        },
      },
      select: { id: true, subject: true },
    });

    const senderName = customer
      ? (customer.companyName ?? `${customer.firstName} ${customer.lastName}`)
      : `${session.firstName} ${session.lastName}`;

    if (session.role === 'CUSTOMER') {
      await notifyStaff({
        organizationId,
        title: 'Neue Nachricht von der Kundschaft',
        body: `${senderName}: ${thread.subject}`,
        link: `/admin/nachrichten?verlauf=${thread.id}`,
      });
    }

    return created({ id: thread.id, subject: thread.subject });
  },
});
