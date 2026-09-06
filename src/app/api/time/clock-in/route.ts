import { defineRoute } from '@/lib/api/handler';
import { created } from '@/lib/api/response';
import { ForbiddenError } from '@/lib/errors';
import { clockSchema } from '@/lib/validation/operations';
import { clockIn } from '@/server/services/job.service';

export const runtime = 'nodejs';

/**
 * POST /api/time/clock-in
 *
 * Einstempeln auf einen zugeteilten Einsatz. Der Service prüft die Zuteilung
 * und dass nicht bereits eine Erfassung läuft — beides serverseitig, weil das
 * Mobiltelefon offline gewesen sein kann.
 */
export const POST = defineRoute({
  permissions: ['timetracking:own'],
  body: clockSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session }) => {
    if (!session.profileId) {
      throw new ForbiddenError('Für Ihr Konto ist kein Mitarbeitendenprofil hinterlegt.');
    }

    const result = await clockIn({ employeeId: session.profileId, input: body });

    return created({
      timeEntryId: result.timeEntryId,
      distanceMeters: result.distanceMeters,
      warning: result.warning,
    });
  },
});
