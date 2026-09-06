import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { calendarRangeQuery } from '@/lib/validation/queries';
import { getCalendarJobs } from '@/server/services/job.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * GET /api/jobs/calendar?from=…&to=…
 *
 * Liefert Einsätze im FullCalendar-Format. Mitarbeitende sehen nur die eigenen
 * Einsätze — die Einschränkung passiert serverseitig, nicht im Frontend.
 */
export const GET = defineRoute({
  permissions: ['job:read', 'job:read_assigned'],
  anyPermission: true,
  query: calendarRangeQuery,
  rateLimit: 'apiRead',
  handler: async ({ query, session }) => {
    const organizationId = await getOrganizationId();

    // Mitarbeitende ohne Dispositionsrecht sehen ausschliesslich eigene Einsätze.
    const employeeId =
      session.role === 'EMPLOYEE' ? (session.profileId ?? undefined) : query.employeeId;

    const events = await getCalendarJobs({
      organizationId,
      from: query.from,
      to: query.to,
      employeeId,
    });

    return ok(events);
  },
});
