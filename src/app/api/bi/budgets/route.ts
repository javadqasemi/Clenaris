import { defineRoute } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { budgetListQuery, createBudgetPeriodSchema } from '@/lib/validation/bi-finance';
import { createBudget, listBudgets } from '@/server/services/budget.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/bi/budgets — Budgetperioden mit Plansumme. */
export const GET = defineRoute({
  permissions: ['budget:read'],
  query: budgetListQuery,
  rateLimit: 'apiRead',
  handler: async ({ query }) => ok(await listBudgets(await getOrganizationId(), query)),
});

/** POST /api/bi/budgets */
export const POST = defineRoute({
  permissions: ['budget:create'],
  body: createBudgetPeriodSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session }) => {
    const period = await createBudget(session, await getOrganizationId(), body);
    return created({ id: period.id, name: period.name });
  },
});
