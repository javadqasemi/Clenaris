import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { computeAndStore } from '@/server/services/scenario.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** POST /api/bi/scenarios/:id/compute — neu rechnen und Ergebnis speichern. */
export const POST = defineRoute({
  permissions: ['scenario:manage'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params }) => ok(await computeAndStore(await getOrganizationId(), params.id)),
});
