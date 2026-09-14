import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { ForbiddenError } from '@/lib/errors';
import { withdrawAbsence } from '@/server/services/employee.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/absences/:id/withdraw — eigenen Antrag zurückziehen.
 *
 * Bis hierher liess sich ein Antrag nur stellen, nicht zurücknehmen: Wer sich
 * im Datum vertan hatte, musste die Betriebsleitung um eine Ablehnung bitten.
 *
 * Dieselbe Berechtigung wie das Stellen (`absence:request`); *welchen*
 * Antrag jemand zurückziehen darf, entscheidet die Abfrage im Dienst über
 * `employeeId` — die Berechtigung sagt nur „darf Anträge stellen und
 * zurückziehen", nie „welche". Ein Konto ohne Mitarbeitendenprofil hat gar
 * keinen Antrag, den es zurückziehen könnte.
 */
export const POST = defineRoute({
  permissions: ['absence:request'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) => {
    if (!session.profileId) {
      throw new ForbiddenError('Für Ihr Konto ist kein Mitarbeitendenprofil hinterlegt.');
    }

    const absence = await withdrawAbsence({
      organizationId: await getOrganizationId(),
      employeeId: session.profileId,
      absenceId: params.id,
      actorId: session.id,
      ip,
    });

    return ok({ id: absence.id, status: absence.status });
  },
});
