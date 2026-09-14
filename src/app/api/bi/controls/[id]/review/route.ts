import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { controlReviewSchema } from '@/lib/validation/bi-governance';
import { reviewControl } from '@/server/services/governance.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** POST /api/bi/controls/:id/review — Prüfung mit Ergebnis abschliessen. */
export const POST = defineRoute({
  permissions: ['control:update'],
  params: idParam,
  body: controlReviewSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const control = await reviewControl(session, await getOrganizationId(), params.id, body);
    return ok({ id: control.id, status: control.status, nextReviewAt: control.nextReviewAt });
  },
});
