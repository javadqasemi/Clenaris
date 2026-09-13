import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { scenarioCompareQuery } from '@/lib/validation/bi-finance';
import { compareScenarios } from '@/server/services/scenario.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/bi/scenarios/compare — Best/Expected/Worst nebeneinander. */
export const GET = defineRoute({
  permissions: ['scenario:read'],
  query: scenarioCompareQuery,
  rateLimit: 'apiRead',
  handler: async ({ query }) => ok(await compareScenarios(await getOrganizationId(), query)),
});
