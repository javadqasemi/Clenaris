import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { depreciationQuery } from '@/lib/validation/bi-finance';
import { getAssetRegister } from '@/server/services/investment.service';
import { getOrganizationId } from '@/server/services/organization.service';
import { toDateOnly } from '@/lib/bi/periods';

export const runtime = 'nodejs';

/** GET /api/bi/investments/register — Anlagenverzeichnis zum Stichtag. */
export const GET = defineRoute({
  permissions: ['investment:read'],
  query: depreciationQuery,
  rateLimit: 'apiRead',
  handler: async ({ query }) => ok(await getAssetRegister(await getOrganizationId(), query.asOf ? toDateOnly(query.asOf) : undefined)),
});
