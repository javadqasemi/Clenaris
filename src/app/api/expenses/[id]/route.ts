import { defineRoute, idParam } from '@/lib/api/handler';
import { noContent, ok } from '@/lib/api/response';
import { updateExpenseSchema } from '@/lib/validation/finance';
import { deleteExpense, updateExpense } from '@/server/services/expense.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** PATCH /api/expenses/:id — Ausgabe korrigieren. */
export const PATCH = defineRoute({
  permissions: ['expense:update'],
  params: idParam,
  body: updateExpenseSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) => {
    const organizationId = await getOrganizationId();
    const expense = await updateExpense({ organizationId, actorId: session.id, ip, expenseId: params.id, input: body });
    return ok({ id: expense.id });
  },
});

/**
 * DELETE /api/expenses/:id
 *
 * Nicht möglich, sobald die Ausgabe in einem Buchhaltungsexport enthalten war:
 * die Treuhandstelle hat den Beleg dann bereits verbucht, und ein Loch in der
 * exportierten Reihe fällt erst beim Abschluss auf. Die Sperre selbst steht
 * in `deleteExpense` (`expense.service.ts`).
 */
export const DELETE = defineRoute({
  permissions: ['expense:delete'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) => {
    const organizationId = await getOrganizationId();
    await deleteExpense({ organizationId, actorId: session.id, ip, expenseId: params.id });
    return noContent();
  },
});
