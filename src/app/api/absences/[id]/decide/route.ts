import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { absenceDecisionSchema } from '@/lib/validation/operations';
import { decideAbsence } from '@/server/services/employee.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/absences/:id/decide
 *
 * Der Service verweigert die Bewilligung, solange im betroffenen Zeitraum
 * noch Einsätze zugeteilt sind. Erst umplanen, dann bewilligen — sonst steht
 * am Einsatztag niemand vor der Tür.
 */
export const POST = defineRoute({
  permissions: ['absence:approve'],
  params: idParam,
  body: absenceDecisionSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const organizationId = await getOrganizationId();

    const absence = await decideAbsence({
      organizationId,
      absenceId: params.id,
      status: body.status,
      note: body.decisionNote,
      actorId: session.id,
    });

    return ok({ id: absence.id, status: absence.status });
  },
});
