import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { ForbiddenError } from '@/lib/errors';
import { getOwnComplaint } from '@/server/services/complaint.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/account/complaints/:id — eine eigene Reklamation; fremde existieren nicht (404). */
export const GET = defineRoute({
  permissions: ['complaint:read_own'],
  params: idParam,
  rateLimit: 'apiRead',
  handler: async ({ params, session }) => {
    if (!session.profileId) throw new ForbiddenError('Für Ihr Konto ist keine Kundenakte hinterlegt.');
    return ok(await getOwnComplaint({ organizationId: await getOrganizationId(), id: params.id, customerId: session.profileId }));
  },
});
