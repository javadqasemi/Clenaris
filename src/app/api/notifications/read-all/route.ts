import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { markAllNotificationsRead } from '@/server/services/notification.service';

export const runtime = 'nodejs';

/** POST /api/notifications/read-all */
export const POST = defineRoute({
  permissions: ['notification:read_own'],
  handler: async ({ session }) => {
    await markAllNotificationsRead(session.id);
    return ok({ success: true });
  },
});