import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { cockpitQuery } from '@/lib/validation/bi-kpi';
import { getCockpit } from '@/server/services/cockpit.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/bi/cockpit — das Führungscockpit als eine Antwort. */
export const GET = defineRoute({
  permissions: ['cockpit:view'],
  query: cockpitQuery,
  rateLimit: 'apiRead',
  handler: async ({ query, session }) => {
    const organizationId = await getOrganizationId();
    return ok(await getCockpit(session, organizationId, query.period));
  },
});
