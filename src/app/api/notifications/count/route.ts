import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { getUnreadCount } from '@/server/services/notification.service';

export const runtime = 'nodejs';

/**
 * GET /api/notifications/count — nur der Zähler, für die Kopfzeile.
 *
 * Der meistaufgerufene Endpunkt der Anwendung: Er läuft auf jeder Seite im
 * App-Rahmen. Genau deshalb gehört eine Schranke daran — siehe `../route.ts`.
 */
export const GET = defineRoute({
  permissions: ['notification:read_own'],
  rateLimit: 'apiRead',
  handler: async ({ session }) => ok({ unread: await getUnreadCount(session.id) }),
});