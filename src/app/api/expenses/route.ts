import { defineRoute, searchQuery } from '@/lib/api/handler';
import { buildPagination, created, paginated } from '@/lib/api/response';
import { createExpenseSchema } from '@/lib/validation/finance';
import { createExpense, listExpenses } from '@/server/services/expense.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/expenses — Ausgabenliste. */
export const GET = defineRoute({
  permissions: ['expense:read'],
  query: searchQuery,
  rateLimit: 'apiRead',
  handler: async ({ query }) => {
    const organizationId = await getOrganizationId();
    const { items, total } = await listExpenses(organizationId, query);
    return paginated(items, buildPagination(query.page, query.pageSize, total));
  },
});

/**
 * POST /api/expenses
 *
 * MWST und Bruttobetrag werden serverseitig aus dem Nettobetrag berechnet —
 * so kann eine fehlerhafte Client-Rechnung die Buchhaltung nicht verfälschen.
 * Rechnung und Belegbindung stehen in `createExpense` (`expense.service.ts`).
 */
export const POST = defineRoute({
  permissions: ['expense:create'],
  body: createExpenseSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session }) => {
    const organizationId = await getOrganizationId();
    const expense = await createExpense({ organizationId, actorId: session.id, input: body });
    return created({ id: expense.id, grossAmount: expense.grossAmount });
  },
});
