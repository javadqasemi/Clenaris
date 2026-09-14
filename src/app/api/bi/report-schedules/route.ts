import { defineRoute } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { createReportScheduleSchema } from '@/lib/validation/bi-reports';
import { createReportSchedule, listReportSchedules } from '@/server/services/bi-report.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/bi/report-schedules */
export const GET = defineRoute({
  permissions: ['bireport:read'],
  rateLimit: 'apiRead',
  handler: async () => ok(await listReportSchedules(await getOrganizationId())),
});

/** POST /api/bi/report-schedules — wiederkehrender Bericht. */
export const POST = defineRoute({
  permissions: ['bireport:manage'],
  body: createReportScheduleSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session }) => {
    const schedule = await createReportSchedule(session, await getOrganizationId(), body);
    return created({ id: schedule.id, nextRunAt: schedule.nextRunAt });
  },
});
