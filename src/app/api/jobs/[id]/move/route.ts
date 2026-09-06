import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { moveJobSchema } from '@/lib/validation/operations';
import { moveJob } from '@/server/services/job.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/jobs/:id/move — Drag & Drop im Kalender.
 *
 * Der Kalender stellt die Verschiebung sofort dar; hier wird sie geprüft. Bei
 * einem Konflikt antwortet die Route mit einem Fehler, und die Oberfläche
 * nimmt die Verschiebung zurück.
 */
export const POST = defineRoute({
  permissions: ['job:update'],
  params: idParam,
  body: moveJobSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const organizationId = await getOrganizationId();

    const job = await moveJob({
      organizationId,
      jobId: params.id,
      scheduledStart: body.scheduledStart,
      scheduledEnd: body.scheduledEnd,
      employeeId: body.employeeId,
      actorId: session.id,
    });

    return ok({
      id: job.id,
      scheduledStart: job.scheduledStart,
      scheduledEnd: job.scheduledEnd,
    });
  },
});
