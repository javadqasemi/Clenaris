import { defineRoute, idParam } from '@/lib/api/handler';
import { noContent, ok } from '@/lib/api/response';
import { updateCompetitorSchema } from '@/lib/validation/bi-knowledge';
import { deleteCompetitor, updateCompetitor } from '@/server/services/knowledge.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** PATCH /api/bi/competitors/:id — jede Änderung gilt als Überprüfung. */
export const PATCH = defineRoute({
  permissions: ['market:manage'],
  params: idParam,
  body: updateCompetitorSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const competitor = await updateCompetitor(session, await getOrganizationId(), params.id, body);
    return ok({ id: competitor.id, nextReviewAt: competitor.nextReviewAt });
  },
});

/** DELETE /api/bi/competitors/:id */
export const DELETE = defineRoute({
  permissions: ['market:manage'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session }) => {
    await deleteCompetitor(session, await getOrganizationId(), params.id);
    return noContent();
  },
});
