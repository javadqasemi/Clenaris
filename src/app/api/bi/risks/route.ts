import { defineRoute } from '@/lib/api/handler';
import { buildPagination, created, paginated } from '@/lib/api/response';
import { createRiskSchema, riskListQuery } from '@/lib/validation/bi-governance';
import { createRisk, listRisks } from '@/server/services/governance.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/bi/risks — Risikoregister, nach Schwere. */
export const GET = defineRoute({
  permissions: ['risk:read'],
  query: riskListQuery,
  rateLimit: 'apiRead',
  handler: async ({ query }) => {
    const { items, total } = await listRisks(await getOrganizationId(), query);
    return paginated(items, buildPagination(query.page, query.pageSize, total));
  },
});

/** POST /api/bi/risks */
export const POST = defineRoute({
  permissions: ['risk:create'],
  body: createRiskSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session }) => {
    const risk = await createRisk(session, await getOrganizationId(), body);
    return created({ id: risk.id, severity: risk.severity });
  },
});
