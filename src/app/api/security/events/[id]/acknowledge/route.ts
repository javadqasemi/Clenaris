import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { acknowledgeEventSchema } from '@/lib/validation/security';
import { getOrganizationId } from '@/server/services/organization.service';
import { bestaetigeEreignis } from '@/server/services/security.service';

export const runtime = 'nodejs';

/**
 * POST /api/security/events/:id/acknowledge — ein Ereignis als gesehen erklären.
 *
 * `security:manage`, nicht `security:read`. Bestätigen ist eine Handlung mit
 * Folgen: Das Ereignis verschwindet aus der Liste der offenen Punkte, und
 * genau diese Liste ist das, was jemand morgens ansieht.
 *
 * Antwortet auch dann mit 200, wenn das Ereignis bereits bestätigt war
 * (`bestaetigt: false`). Ein Fehler wäre hier falsch: Die Absicht der
 * aufrufenden Person ist erfüllt, und zwei Personen, die gleichzeitig auf
 * dieselbe Zeile klicken, sollen nicht einen Fehlschlag sehen.
 */
export const POST = defineRoute({
  permissions: ['security:manage'],
  params: idParam,
  body: acknowledgeEventSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) => {
    const ergebnis = await bestaetigeEreignis({
      organizationId: await getOrganizationId(),
      eventId: params.id,
      actorId: session.id,
      note: body.note,
      ip,
    });

    return ok(ergebnis);
  },
});
