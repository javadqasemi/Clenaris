import { defineRoute, idParam } from '@/lib/api/handler';
import { noContent, ok } from '@/lib/api/response';
import { updateBudgetPeriodSchema } from '@/lib/validation/bi-finance';
import { deleteBudget, getBudget, updateBudget } from '@/server/services/budget.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/bi/budgets/:id — Periode mit Zeilen. */
export const GET = defineRoute({
  permissions: ['budget:read'],
  params: idParam,
  rateLimit: 'apiRead',
  handler: async ({ params }) => ok(await getBudget(await getOrganizationId(), params.id)),
});

/** PATCH /api/bi/budgets/:id */
export const PATCH = defineRoute({
  permissions: ['budget:update'],
  params: idParam,
  body: updateBudgetPeriodSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const period = await updateBudget(session, await getOrganizationId(), params.id, body);
    return ok({ id: period.id });
  },
});

/** DELETE /api/bi/budgets/:id — nur Entwürfe. */
export const DELETE = defineRoute({
  permissions: ['budget:delete'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session }) => {
    await deleteBudget(session, await getOrganizationId(), params.id);
    return noContent();
  },
});
