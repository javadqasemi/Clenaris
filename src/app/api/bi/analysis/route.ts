import { defineRoute } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { analysisListQuery, createAnalysisBoardSchema } from '@/lib/validation/bi-knowledge';
import { createAnalysisBoard, listAnalysisBoards } from '@/server/services/knowledge.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/bi/analysis — SWOT- und PESTEL-Tafeln, alle Fassungen. */
export const GET = defineRoute({
  permissions: ['market:read'],
  query: analysisListQuery,
  rateLimit: 'apiRead',
  handler: async ({ query }) => ok(await listAnalysisBoards(await getOrganizationId(), query.kind)),
});

/** POST /api/bi/analysis — neue Tafel, wahlweise als Nachfolgerin einer alten. */
export const POST = defineRoute({
  permissions: ['market:manage'],
  body: createAnalysisBoardSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session }) => {
    const board = await createAnalysisBoard(session, await getOrganizationId(), body);
    return created({ id: board.id });
  },
});
