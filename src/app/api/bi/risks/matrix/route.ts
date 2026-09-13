import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { getRiskMatrix } from '@/server/services/governance.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/bi/risks/matrix — 5×5-Matrix offener Risiken. */
export const GET = defineRoute({
  permissions: ['risk:read'],
  rateLimit: 'apiRead',
  handler: async () => ok(await getRiskMatrix(await getOrganizationId())),
});
