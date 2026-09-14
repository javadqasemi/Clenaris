import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { closeBudget } from '@/server/services/budget.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** POST /api/bi/budgets/:id/close — Budget abschliessen; danach ist nichts mehr änderbar. */
export const POST = defineRoute({
  permissions: ['budget:approve'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session }) => {
    const period = await closeBudget(session, await getOrganizationId(), params.id);
    return ok({ id: period.id, status: period.status });
  },
});
