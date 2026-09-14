import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { reviewNoteSchema } from '@/lib/validation/bi-objectives';
import { markObjectiveReviewed } from '@/server/services/objective.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** POST /api/bi/objectives/:id/review — Prüfung abschliessen, nächsten Termin setzen. */
export const POST = defineRoute({
  permissions: ['objective:update'],
  params: idParam,
  body: reviewNoteSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const organizationId = await getOrganizationId();
    const objective = await markObjectiveReviewed(session, organizationId, params.id, body.note);
    return ok({ id: objective.id, nextReviewAt: objective.nextReviewAt });
  },
});
