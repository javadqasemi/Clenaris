import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { contractAmendmentDecisionSchema, contractAmendmentParams } from '@/lib/validation/contracts';
import { decideAmendment } from '@/server/services/contract-amendment.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/contracts/{id}/amendments/{amendmentId}/decision — freigeben oder
 * ablehnen.
 *
 * **Vier-Augen-Prinzip, zweimal abgesichert.** Einmal im Rechteschnitt —
 * `contract:version` (beantragen) hat die Betriebsleitung, `contract:approve`
 * (freigeben) nicht. Und einmal hier im Dienst: Wer den Antrag gestellt hat,
 * kann ihn nicht selbst freigeben (422). Der Rechteschnitt allein reichte
 * nicht, denn die Administration hat beide Rechte — und genau dort ist die
 * Versuchung am grössten.
 */
export const POST = defineRoute({
  permissions: ['contract:approve'],
  params: contractAmendmentParams,
  body: contractAmendmentDecisionSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) =>
    ok(
      await decideAmendment({
        organizationId: await getOrganizationId(),
        contractId: params.id,
        amendmentId: params.amendmentId,
        actorId: session.id,
        ip,
        entscheidung: body.entscheidung,
        reason: body.reason,
      }),
    ),
});
