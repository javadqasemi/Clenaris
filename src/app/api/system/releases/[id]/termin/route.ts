import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { releaseScheduleSchema } from '@/lib/validation/system';
import { getOrganizationId } from '@/server/services/organization.service';
import { releaseTerminieren } from '@/server/services/release.service';

export const runtime = 'nodejs';

/**
 * PUT /api/system/releases/:id/termin — Termin setzen oder verschieben.
 *
 * Aus „verfügbar" schliesst das die Freigabe ein. Der Termin muss mindestens
 * 15 Minuten und höchstens 90 Tage in der Zukunft liegen. Alter und neuer
 * Termin stehen im Prüfprotokoll.
 */
export const PUT = defineRoute({
  permissions: ['release:manage'],
  params: idParam,
  body: releaseScheduleSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip, request }) =>
    ok(
      await releaseTerminieren(
        { organizationId: await getOrganizationId(), actorId: session.id, ip, userAgent: request.headers.get('user-agent') },
        params.id,
        new Date(body.scheduledFor),
      ),
    ),
});
