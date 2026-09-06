import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { completeJobSchema } from '@/lib/validation/operations';
import { completeJob } from '@/server/services/job.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/jobs/:id/complete
 *
 * Schliesst den Einsatz ab: offene Zeiterfassungen werden beendet, Material
 * gebucht, die Unterschrift gespeichert. Sind alle Einsätze einer Buchung
 * erledigt, wechselt auch die Buchung auf „abgeschlossen".
 *
 * Der Service verweigert den Abschluss, solange Pflichtpunkte der Checkliste
 * offen sind — die Checkliste ist der Leistungsnachweis.
 */
export const POST = defineRoute({
  permissions: ['job:complete_assigned', 'job:update'],
  anyPermission: true,
  params: idParam,
  body: completeJobSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const organizationId = await getOrganizationId();

    const job = await completeJob({
      organizationId,
      jobId: params.id,
      employeeId: session.role === 'EMPLOYEE' ? (session.profileId ?? undefined) : undefined,
      input: body,
      actorId: session.id,
    });

    return ok({ id: job.id, status: job.status, actualEnd: job.actualEnd });
  },
});
