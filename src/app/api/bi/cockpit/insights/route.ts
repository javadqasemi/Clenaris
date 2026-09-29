import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { getInsights, insightScopeFor } from '@/server/services/insight.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * GET /api/bi/cockpit/insights — regelbasierte Auffälligkeiten.
 *
 * Mit der Sicht der Rolle: `cockpit:view` öffnet die Sammelansicht, nicht die
 * Register dahinter (Risiken, Markt, Dokumente) — siehe `insightScopeFor`.
 */
export const GET = defineRoute({
  permissions: ['cockpit:view'],
  rateLimit: 'apiRead',
  handler: async ({ session }) => ok(await getInsights(await getOrganizationId(), insightScopeFor(session.role))),
});
