import { defineRoute, idParam } from '@/lib/api/handler';
import { noContent, ok } from '@/lib/api/response';
import { updateBudgetLineSchema } from '@/lib/validation/bi-finance';
import { deleteBudgetLine, updateBudgetLine } from '@/server/services/budget.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** PATCH /api/bi/budget-lines/:id — Zeile ändern; nach Genehmigung nur Nachtrag, Text, Notiz. */
export const PATCH = defineRoute({
  permissions: ['budget:update'],
  params: idParam,
  body: updateBudgetLineSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const line = await updateBudgetLine(session, await getOrganizationId(), params.id, body);
    return ok({ id: line.id });
  },
});

/** DELETE /api/bi/budget-lines/:id — nur im Entwurf. */
export const DELETE = defineRoute({
  permissions: ['budget:update'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session }) => {
    await deleteBudgetLine(session, await getOrganizationId(), params.id);
    return noContent();
  },
});
