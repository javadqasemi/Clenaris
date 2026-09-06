import { defineRoute } from '@/lib/api/handler';
import { created } from '@/lib/api/response';
import { ForbiddenError } from '@/lib/errors';
import { absenceRequestSchema } from '@/lib/validation/operations';
import { requestAbsence } from '@/server/services/employee.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/absences
 *
 * Abwesenheitsantrag aus dem Mitarbeitendenportal. Der Service zählt die
 * effektiven Arbeitstage (ohne Wochenenden und Feiertage), prüft
 * Überschneidungen und bei Ferien den Saldo.
 */
export const POST = defineRoute({
  permissions: ['absence:request'],
  body: absenceRequestSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session }) => {
    if (!session.profileId) {
      throw new ForbiddenError('Für Ihr Konto ist kein Mitarbeitendenprofil hinterlegt.');
    }

    const organizationId = await getOrganizationId();

    const absence = await requestAbsence({
      organizationId,
      employeeId: session.profileId,
      input: body,
    });

    return created({ id: absence.id, days: absence.days, status: absence.status });
  },
});
