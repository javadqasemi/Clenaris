import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { assignJobSchema } from '@/lib/validation/operations';
import { assignJob } from '@/server/services/job.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/jobs/:id/assign
 *
 * Ersetzt die Zuteilung vollständig. Der Service prüft dabei auf
 * Doppelbelegung und benachrichtigt die zugeteilten Personen per E-Mail und
 * SMS — es sei denn, `notify` ist ausgeschaltet (Umplanung im Hintergrund).
 */
export const POST = defineRoute({
  permissions: ['job:assign'],
  params: idParam,
  body: assignJobSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const organizationId = await getOrganizationId();

    await assignJob({
      organizationId,
      jobId: params.id,
      employeeIds: body.employeeIds,
      role: body.role,
      notify: body.notify,
      actorId: session.id,
    });

    return ok({ success: true, assigned: body.employeeIds.length });
  },
});
