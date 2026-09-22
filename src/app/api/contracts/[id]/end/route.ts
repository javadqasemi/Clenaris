import { z } from 'zod';

import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { idParam } from '@/lib/validation/queries';
import { endContract } from '@/server/services/contract.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/contracts/{id}/end — den Vertrag beenden.
 *
 * Mit dem Ende laufen die Serien aus: Alle Einsatzpläne werden stillgelegt und
 * bekommen ein Enddatum. Ohne diesen Schritt erzeugte der nächtliche Planer
 * weiter Einsätze für einen beendeten Vertrag — und niemand sähe es, bis
 * jemand vor einer verschlossenen Tür steht.
 *
 * Die Pläne werden **nicht gelöscht**: Sie gehören zur Vertragsversion, und
 * die Einsätze, die aus ihnen entstanden sind, zeigen weiterhin auf sie.
 *
 * Endzustand: `ENDED` ist die letzte Station. Ein beendeter Vertrag wird nicht
 * wiederbelebt — es entsteht ein neuer.
 */
export const POST = defineRoute({
  permissions: ['contract:terminate'],
  params: idParam,
  body: z.object({ reason: z.string().trim().max(2000).optional() }),
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) =>
    ok(
      await endContract({
        organizationId: await getOrganizationId(),
        contractId: params.id,
        actorId: session.id,
        ip,
        reason: body.reason,
      }),
    ),
});
