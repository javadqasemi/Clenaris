import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { getUnreadCount } from '@/server/services/notification.service';

export const runtime = 'nodejs';

/** GET /api/notifications/count — nur der Zähler, für die Kopfzeile. */
export const GET = defineRoute({
  permissions: ['notification:read_own'],
  handler: async ({ session }) => ok({ unread: await getUnreadCount(session.id) }),
});