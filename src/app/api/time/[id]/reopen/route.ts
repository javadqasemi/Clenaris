import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { getOrganizationId } from '@/server/services/organization.service';
import { reopenTimeEntry } from '@/server/services/timetracking.service';

export const runtime = 'nodejs';

/**
 * POST /api/time/:id/reopen — eine Freigabe aufheben.
 *
 * Der Gegenweg zum Korrigieren: Eine freigegebene Zeit ist eingefroren, und
 * genau deshalb braucht es einen ausdrücklichen Schritt zurück.
 *
 * Bewusst **einzeln** und nicht als Stapel — anders als das Freigeben. Eine
 * Freigabe zurückzunehmen ist der seltene Fall und soll sich nicht
 * versehentlich auf einen ganzen Monat anwenden lassen. Die Asymmetrie ist
 * Absicht: Der häufige Weg ist bequem, der seltene ist einzeln.
 */
export const POST = defineRoute({
  permissions: ['timetracking:approve'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) =>
    ok(
      await reopenTimeEntry({
        organizationId: await getOrganizationId(),
        entryId: params.id,
        actorId: session.id,
        ip,
      }),
    ),
});
