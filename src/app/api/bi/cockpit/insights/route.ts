import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { getInsights } from '@/server/services/insight.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/bi/cockpit/insights — regelbasierte Auffälligkeiten. */
export const GET = defineRoute({
  permissions: ['cockpit:view'],
  rateLimit: 'apiRead',
  handler: async () => ok(await getInsights(await getOrganizationId())),
});
