import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { idParam } from '@/lib/validation/queries';
import { resumeContract } from '@/server/services/contract.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/contracts/{id}/resume — die Pause beenden.
 *
 * Kein Rumpf: Es gibt genau eine mögliche Wirkung. Ein Endpunkt, der ein
 * Datum entgegennähme, lüde dazu ein, die Pause rückwirkend zu verkürzen —
 * und die Einsätze, die in dieser Zeit nicht erzeugt wurden, entstünden
 * dadurch nicht.
 */
export const POST = defineRoute({
  permissions: ['contract:activate'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) =>
    ok(
      await resumeContract({
        organizationId: await getOrganizationId(),
        contractId: params.id,
        actorId: session.id,
        ip,
      }),
    ),
});
