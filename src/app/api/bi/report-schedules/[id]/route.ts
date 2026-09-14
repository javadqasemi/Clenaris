import { defineRoute, idParam } from '@/lib/api/handler';
import { noContent, ok } from '@/lib/api/response';
import { updateReportScheduleSchema } from '@/lib/validation/bi-reports';
import { deleteReportSchedule, updateReportSchedule } from '@/server/services/bi-report.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** PATCH /api/bi/report-schedules/:id */
export const PATCH = defineRoute({
  permissions: ['bireport:manage'],
  params: idParam,
  body: updateReportScheduleSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const schedule = await updateReportSchedule(session, await getOrganizationId(), params.id, body);
    return ok({ id: schedule.id, nextRunAt: schedule.nextRunAt, active: schedule.active });
  },
});

/** DELETE /api/bi/report-schedules/:id — die erzeugten Berichte bleiben. */
export const DELETE = defineRoute({
  permissions: ['bireport:manage'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session }) => {
    await deleteReportSchedule(session, await getOrganizationId(), params.id);
    return noContent();
  },
});
