import { defineRoute, idParam } from '@/lib/api/handler';
import { noContent, ok } from '@/lib/api/response';
import { updateInvestmentSchema } from '@/lib/validation/bi-finance';
import { deleteInvestment, getInvestment, updateInvestment } from '@/server/services/investment.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/bi/investments/:id — mit Bewertung und Dateien. */
export const GET = defineRoute({
  permissions: ['investment:read'],
  params: idParam,
  rateLimit: 'apiRead',
  handler: async ({ params }) => ok(await getInvestment(await getOrganizationId(), params.id)),
});

/** PATCH /api/bi/investments/:id */
export const PATCH = defineRoute({
  permissions: ['investment:update'],
  params: idParam,
  body: updateInvestmentSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const investment = await updateInvestment(session, await getOrganizationId(), params.id, body);
    return ok({ id: investment.id, status: investment.status });
  },
});

/** DELETE /api/bi/investments/:id — Papierkorb. */
export const DELETE = defineRoute({
  permissions: ['investment:delete'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session }) => {
    await deleteInvestment(session, await getOrganizationId(), params.id);
    return noContent();
  },
});
