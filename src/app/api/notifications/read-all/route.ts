import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { markAllNotificationsRead } from '@/server/services/notification.service';

export const runtime = 'nodejs';

/**
 * POST /api/notifications/read-all
 *
 * Schreibender Endpunkt, deshalb `apiWrite` (90/min je Sitzung) statt
 * `apiRead`: Jeder Aufruf schreibt über alle ungelesenen Benachrichtigungen
 * der Person.
 */
export const POST = defineRoute({
  permissions: ['notification:read_own'],
  rateLimit: 'apiWrite',
  handler: async ({ session }) => {
    await markAllNotificationsRead(session.id);
    return ok({ success: true });
  },
});