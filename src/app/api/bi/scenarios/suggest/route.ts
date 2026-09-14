import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { suggestAssumptions } from '@/server/services/scenario.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/bi/scenarios/suggest — Treiber aus dem Ist der letzten zwölf Monate. */
export const GET = defineRoute({
  permissions: ['scenario:read'],
  rateLimit: 'apiRead',
  handler: async () => ok(await suggestAssumptions(await getOrganizationId())),
});
