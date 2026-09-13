import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { objectiveTimelineQuery } from '@/lib/validation/bi-objectives';
import { getObjectiveTimeline } from '@/server/services/objective.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/bi/objectives/timeline — die Roadmap als Zeitachse. */
export const GET = defineRoute({
  permissions: ['objective:read', 'objective:read_own'],
  anyPermission: true,
  query: objectiveTimelineQuery,
  rateLimit: 'apiRead',
  handler: async ({ query, session }) => {
    const organizationId = await getOrganizationId();
    return ok(await getObjectiveTimeline(session, organizationId, query));
  },
});
