import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { prisma } from '@/lib/db';

export const runtime = 'nodejs';

/** GET /api/notifications — die letzten 25 In-App-Benachrichtigungen. */
export const GET = defineRoute({
  permissions: ['notification:read_own'],
  handler: async ({ session }) => {
    const notifications = await prisma.notification.findMany({
      where: { userId: session.id, channel: 'IN_APP' },
      orderBy: { createdAt: 'desc' },
      take: 25,
      select: {
        id: true,
        title: true,
        body: true,
        link: true,
        readAt: true,
        createdAt: true,
      },
    });

    return ok(notifications);
  },
});
