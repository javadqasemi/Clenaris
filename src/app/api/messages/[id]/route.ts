import { defineRoute, idParam } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { prisma } from '@/lib/db';
import { BusinessRuleError, ForbiddenError, NotFoundError } from '@/lib/errors';
import { replyMessageSchema } from '@/lib/validation/messaging';
import { notify, notifyStaff } from '@/server/services/notification.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** Ermittelt den Thread und prüft die Zugehörigkeit in einem Schritt. */
async function loadThread(threadId: string, session: { id: string; role: string }) {
  const thread = await prisma.messageThread.findUnique({
    where: { id: threadId },
    include: {
      customer: { select: { id: true, userId: true, firstName: true, lastName: true, companyName: true } },
    },
  });
  if (!thread) throw new NotFoundError('Nachrichtenverlauf');

  if (session.role === 'CUSTOMER' && thread.customer?.userId !== session.id) {
    // Bewusst 404-nah formuliert: die Existenz fremder Threads ist nichts,
    // was ein fremdes Konto bestätigt bekommen soll.
    throw new ForbiddenError('Kein Zugriff auf diesen Nachrichtenverlauf.');
  }

  return thread;
}

/**
 * GET /api/messages/:id
 *
 * Liefert den Verlauf und markiert beim Lesen die Gegenseite als gelesen —
 * jeweils nur die Nachrichten, die man selbst *nicht* geschrieben hat.
 */
export const GET = defineRoute({
  permissions: ['message:read', 'message:read_own'],
  anyPermission: true,
  params: idParam,
  rateLimit: 'apiRead',
  handler: async ({ params, session }) => {
    const thread = await loadThread(params.id, session);

    const messages = await prisma.message.findMany({
      where: { threadId: thread.id },
      orderBy: { createdAt: 'asc' },
      include: {
        author: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
        attachments: { select: { id: true, filename: true, url: true, mimeType: true, sizeBytes: true } },
      },
    });

    const foreignType = session.role === 'CUSTOMER' ? 'STAFF' : 'CUSTOMER';
    await prisma.message.updateMany({
      where: { threadId: thread.id, authorType: foreignType, readAt: null },
      data: { readAt: new Date() },
    });

    return ok({
      id: thread.id,
      subject: thread.subject,
      closed: thread.closed,
      customer: thread.customer,
      messages,
    });
  },
});

/**
 * POST /api/messages/:id — antworten.
 *
 * Ein geschlossener Verlauf nimmt keine Antworten mehr an; wer nachfragen
 * will, eröffnet einen neuen. Das hält alte Akten stabil und verhindert, dass
 * eine erledigte Reklamation Monate später wieder aufgeht.
 */
export const POST = defineRoute({
  permissions: ['message:create', 'message:write_own'],
  anyPermission: true,
  params: idParam,
  body: replyMessageSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const organizationId = await getOrganizationId();
    const thread = await loadThread(params.id, session);

    if (thread.closed) {
      throw new BusinessRuleError(
        'Dieser Verlauf ist abgeschlossen. Bitte eröffnen Sie einen neuen.',
      );
    }

    const isCustomer = session.role === 'CUSTOMER';

    const message = await prisma.$transaction(async (tx) => {
      const createdMessage = await tx.message.create({
        data: {
          threadId: thread.id,
          authorId: session.id,
          authorType: isCustomer ? 'CUSTOMER' : 'STAFF',
          body: body.body,
        },
        select: { id: true, createdAt: true },
      });

      if (body.fileIds?.length) {
        await tx.fileAsset.updateMany({
          where: { id: { in: body.fileIds }, organizationId, uploadedById: session.id },
          data: { messageId: createdMessage.id },
        });
      }

      await tx.messageThread.update({
        where: { id: thread.id },
        data: {
          lastMessageAt: createdMessage.createdAt,
          // Nur das Büro darf abschliessen.
          ...(!isCustomer && body.close ? { closed: true } : {}),
        },
      });

      return createdMessage;
    });

    const preview = body.body.length > 140 ? `${body.body.slice(0, 137)}…` : body.body;

    if (isCustomer) {
      const senderName =
        thread.customer?.companyName ??
        `${thread.customer?.firstName ?? ''} ${thread.customer?.lastName ?? ''}`.trim();
      await notifyStaff({
        organizationId,
        title: `Antwort: ${thread.subject}`,
        body: `${senderName}: ${preview}`,
        link: `/admin/nachrichten?verlauf=${thread.id}`,
      });
    } else if (thread.customer?.userId) {
      await notify({
        userId: thread.customer.userId,
        channels: ['IN_APP', 'EMAIL'],
        title: `Antwort: ${thread.subject}`,
        body: preview,
        link: `/konto/nachrichten?verlauf=${thread.id}`,
        entity: 'MessageThread',
        entityId: thread.id,
      });
    }

    return created({ id: message.id });
  },
});
