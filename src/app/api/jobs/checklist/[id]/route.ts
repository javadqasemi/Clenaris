import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { checklistToggleSchema } from '@/lib/validation/operations';
import { toggleChecklistItem } from '@/server/services/job.service';

export const runtime = 'nodejs';

/**
 * POST /api/jobs/checklist/:id
 *
 * Einen Checklistenpunkt abhaken. Bewusst ein eigener, sehr schlanker
 * Endpunkt: er wird auf der Baustelle im Sekundentakt aufgerufen und soll
 * unter schlechten Netzbedingungen schnell antworten.
 */
export const POST = defineRoute({
  permissions: ['job:complete_assigned', 'job:update'],
  anyPermission: true,
  params: idParam,
  body: checklistToggleSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    await toggleChecklistItem({
      itemId: params.id,
      // Nur Mitarbeitende ohne Dispositionsrecht werden gegen die Zuteilung geprüft.
      employeeId: session.role === 'EMPLOYEE' ? (session.profileId ?? undefined) : undefined,
      done: body.done,
      note: body.note,
    });

    return ok({ id: params.id, done: body.done });
  },
});
