import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { approveBudget } from '@/server/services/budget.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** POST /api/bi/budgets/:id/approve — Planwerte einfrieren. */
export const POST = defineRoute({
  permissions: ['budget:approve'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session }) => {
    const period = await approveBudget(session, await getOrganizationId(), params.id);
    return ok({ id: period.id, status: period.status, approvedAt: period.approvedAt });
  },
});
