import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { riskReviewSchema } from '@/lib/validation/bi-governance';
import { reviewRisk } from '@/server/services/governance.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** POST /api/bi/risks/:id/review — Prüfung abschliessen, ggf. neu bewerten. */
export const POST = defineRoute({
  permissions: ['risk:update'],
  params: idParam,
  body: riskReviewSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const risk = await reviewRisk(session, await getOrganizationId(), params.id, body);
    return ok({ id: risk.id, severity: risk.severity, nextReviewAt: risk.nextReviewAt });
  },
});
