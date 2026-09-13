import { defineRoute, idParam } from '@/lib/api/handler';
import { noContent, ok } from '@/lib/api/response';
import { updateMeetingSchema } from '@/lib/validation/bi-knowledge';
import { deleteMeeting, getMeeting, updateMeeting } from '@/server/services/meeting.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/bi/meetings/:id */
export const GET = defineRoute({
  permissions: ['meeting:read'],
  params: idParam,
  rateLimit: 'apiRead',
  handler: async ({ params }) => ok(await getMeeting(await getOrganizationId(), params.id)),
});

/** PATCH /api/bi/meetings/:id — Protokoll, Beschlüsse, weitere Pendenzen. */
export const PATCH = defineRoute({
  permissions: ['meeting:update'],
  params: idParam,
  body: updateMeetingSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const meeting = await updateMeeting(session, await getOrganizationId(), params.id, body);
    return ok({ id: meeting.id });
  },
});

/** DELETE /api/bi/meetings/:id — Papierkorb. */
export const DELETE = defineRoute({
  permissions: ['meeting:delete'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session }) => {
    await deleteMeeting(session, await getOrganizationId(), params.id);
    return noContent();
  },
});
