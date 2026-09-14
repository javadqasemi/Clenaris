import { defineRoute } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { createInvestmentSchema, investmentListQuery } from '@/lib/validation/bi-finance';
import { createInvestment, listInvestments } from '@/server/services/investment.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/bi/investments — mit Restwert zum heutigen Tag. */
export const GET = defineRoute({
  permissions: ['investment:read'],
  query: investmentListQuery,
  rateLimit: 'apiRead',
  handler: async ({ query }) => ok(await listInvestments(await getOrganizationId(), query)),
});

/** POST /api/bi/investments */
export const POST = defineRoute({
  permissions: ['investment:create'],
  body: createInvestmentSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session }) => {
    const investment = await createInvestment(session, await getOrganizationId(), body);
    return created({ id: investment.id, name: investment.name });
  },
});
