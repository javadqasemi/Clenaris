import { defineRoute, idParam } from '@/lib/api/handler';
import { created } from '@/lib/api/response';
import { createBudgetLineSchema } from '@/lib/validation/bi-finance';
import { addBudgetLine } from '@/server/services/budget.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** POST /api/bi/budgets/:id/lines — Budgetzeile anlegen (nur im Entwurf). */
export const POST = defineRoute({
  permissions: ['budget:update'],
  params: idParam,
  body: createBudgetLineSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const line = await addBudgetLine(session, await getOrganizationId(), params.id, body);
    return created({ id: line.id });
  },
});
