import { defineRoute } from '@/lib/api/handler';
import { buildPagination, created, paginated } from '@/lib/api/response';
import { createMarketInsightSchema, marketListQuery } from '@/lib/validation/bi-knowledge';
import { createMarketInsight, listMarketInsights } from '@/server/services/knowledge.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/bi/market-insights — mit Kennzeichnung veralteter Einträge. */
export const GET = defineRoute({
  permissions: ['market:read'],
  query: marketListQuery,
  rateLimit: 'apiRead',
  handler: async ({ query }) => {
    const { items, total } = await listMarketInsights(await getOrganizationId(), query);
    return paginated(items, buildPagination(query.page, query.pageSize, total));
  },
});

/** POST /api/bi/market-insights */
export const POST = defineRoute({
  permissions: ['market:manage'],
  body: createMarketInsightSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session }) => {
    const insight = await createMarketInsight(session, await getOrganizationId(), body);
    return created({ id: insight.id });
  },
});
