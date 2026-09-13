import { defineRoute } from '@/lib/api/handler';
import { buildPagination, created, paginated } from '@/lib/api/response';
import { createMeetingSchema, meetingListQuery } from '@/lib/validation/bi-knowledge';
import { createMeeting, listMeetings } from '@/server/services/meeting.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/bi/meetings */
export const GET = defineRoute({
  permissions: ['meeting:read'],
  query: meetingListQuery,
  rateLimit: 'apiRead',
  handler: async ({ query }) => {
    const { items, total } = await listMeetings(await getOrganizationId(), query);
    return paginated(items, buildPagination(query.page, query.pageSize, total));
  },
});

/** POST /api/bi/meetings — Sitzung mit Teilnehmenden und Pendenzen als Aufgaben. */
export const POST = defineRoute({
  permissions: ['meeting:create'],
  body: createMeetingSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session }) => {
    const meeting = await createMeeting(session, await getOrganizationId(), body);
    return created({ id: meeting.id });
  },
});
