import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { markNotificationRead } from '@/server/services/notification.service';

export const runtime = 'nodejs';

/** POST /api/notifications/:id/read */
export const POST = defineRoute({
  permissions: ['notification:read_own'],
  params: idParam,
  handler: async ({ session, params }) => {
    await markNotificationRead(session.id, params.id);
    return ok({ success: true });
  },
});