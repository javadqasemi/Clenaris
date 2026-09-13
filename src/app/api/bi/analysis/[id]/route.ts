import { defineRoute, idParam } from '@/lib/api/handler';
import { noContent, ok } from '@/lib/api/response';
import { updateAnalysisBoardSchema } from '@/lib/validation/bi-knowledge';
import { deleteAnalysisBoard, getAnalysisBoard, updateAnalysisBoard } from '@/server/services/knowledge.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/bi/analysis/:id — Tafel mit Einträgen und Fassungskette. */
export const GET = defineRoute({
  permissions: ['market:read'],
  params: idParam,
  rateLimit: 'apiRead',
  handler: async ({ params }) => ok(await getAnalysisBoard(await getOrganizationId(), params.id)),
});

/** PATCH /api/bi/analysis/:id — nur die aktuelle Fassung; Einträge werden als Ganzes ersetzt. */
export const PATCH = defineRoute({
  permissions: ['market:manage'],
  params: idParam,
  body: updateAnalysisBoardSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => ok(await updateAnalysisBoard(session, await getOrganizationId(), params.id, body)),
});

/** DELETE /api/bi/analysis/:id */
export const DELETE = defineRoute({
  permissions: ['market:manage'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session }) => {
    await deleteAnalysisBoard(session, await getOrganizationId(), params.id);
    return noContent();
  },
});
