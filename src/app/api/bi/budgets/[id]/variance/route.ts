import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { depreciationQuery } from '@/lib/validation/bi-finance';
import { getBudgetVariance } from '@/server/services/budget.service';
import { getOrganizationId } from '@/server/services/organization.service';
import { toDateOnly } from '@/lib/bi/periods';

export const runtime = 'nodejs';

/** GET /api/bi/budgets/:id/variance — Plan, anteiliger Plan, Ist, Abweichung, Hochrechnung. */
export const GET = defineRoute({
  permissions: ['budget:read'],
  params: idParam,
  query: depreciationQuery,
  rateLimit: 'apiRead',
  handler: async ({ params, query }) =>
    ok(await getBudgetVariance(await getOrganizationId(), params.id, query.asOf ? toDateOnly(query.asOf) : undefined)),
});
