import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { ForbiddenError } from '@/lib/errors';
import { clockSchema } from '@/lib/validation/operations';
import { clockOut } from '@/server/services/job.service';

export const runtime = 'nodejs';

/**
 * POST /api/time/clock-out
 *
 * Ausstempeln. Die Dauer berechnet der Server aus seiner eigenen Uhr — die
 * Uhrzeit des Mobiltelefons ist keine verlässliche Grundlage für eine
 * Lohnabrechnung.
 */
export const POST = defineRoute({
  permissions: ['timetracking:own'],
  body: clockSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session }) => {
    if (!session.profileId) {
      throw new ForbiddenError('Für Ihr Konto ist kein Mitarbeitendenprofil hinterlegt.');
    }

    const result = await clockOut({ employeeId: session.profileId, input: body });

    return ok({ minutes: result.minutes, distanceMeters: result.distanceMeters });
  },
});
