import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { getOrganizationId } from '@/server/services/organization.service';
import { getReleaseDetail } from '@/server/services/release.service';

export const runtime = 'nodejs';

/** GET /api/system/releases/:id — eine Version mit Änderungsprotokoll und Entscheidungsverlauf. */
export const GET = defineRoute({
  permissions: ['release:read'],
  params: idParam,
  rateLimit: 'apiRead',
  handler: async ({ params }) => ok(await getReleaseDetail(await getOrganizationId(), params.id)),
});
