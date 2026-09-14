import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { depreciationQuery } from '@/lib/validation/bi-finance';
import { getDepreciationPlan, getInvestment, valueInvestment } from '@/server/services/investment.service';
import { getOrganizationId } from '@/server/services/organization.service';
import { toDateOnly } from '@/lib/bi/periods';

export const runtime = 'nodejs';

/** GET /api/bi/investments/:id/depreciation — Restwert zum Stichtag und Plan je Jahr. */
export const GET = defineRoute({
  permissions: ['investment:read'],
  params: idParam,
  query: depreciationQuery,
  rateLimit: 'apiRead',
  handler: async ({ params, query }) => {
    const investment = await getInvestment(await getOrganizationId(), params.id);
    return ok({
      asOf: query.asOf ? toDateOnly(query.asOf) : new Date(),
      valuation: query.asOf ? valueInvestment(investment, toDateOnly(query.asOf)) : investment.valuation,
      schedule: getDepreciationPlan(investment),
    });
  },
});
