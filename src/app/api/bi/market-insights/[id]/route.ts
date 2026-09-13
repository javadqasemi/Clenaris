import { defineRoute, idParam } from '@/lib/api/handler';
import { noContent, ok } from '@/lib/api/response';
import { updateMarketInsightSchema } from '@/lib/validation/bi-knowledge';
import { deleteMarketInsight, updateMarketInsight } from '@/server/services/knowledge.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** PATCH /api/bi/market-insights/:id — Aktualisieren gilt als Bestätigung. */
export const PATCH = defineRoute({
  permissions: ['market:manage'],
  params: idParam,
  body: updateMarketInsightSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const insight = await updateMarketInsight(session, await getOrganizationId(), params.id, body);
    return ok({ id: insight.id, nextReviewAt: insight.nextReviewAt });
  },
});

/** DELETE /api/bi/market-insights/:id */
export const DELETE = defineRoute({
  permissions: ['market:manage'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session }) => {
    await deleteMarketInsight(session, await getOrganizationId(), params.id);
    return noContent();
  },
});
