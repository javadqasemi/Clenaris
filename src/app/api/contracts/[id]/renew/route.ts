import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { contractRenewSchema } from '@/lib/validation/contracts';
import { idParam } from '@/lib/validation/queries';
import { renewContract } from '@/server/services/contract.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/contracts/{id}/renew — die Laufzeit verlängern.
 *
 * **Auch die „automatische" Verlängerung läuft hierüber.** Der nächtliche Lauf
 * erinnert an die nahende Frist; verlängern tut ein Mensch. Eine Verlängerung
 * ist eine Verpflichtung über Monate — wer sie auslöst, gehört ins Protokoll,
 * und ein stiller Nachtlauf kennt niemanden.
 *
 * `renewalType: AUTOMATIC` in der Vertragsversion sagt deshalb nicht „das
 * System verlängert", sondern „wenn niemand kündigt, verlängert sich der
 * Vertrag" — eine Aussage über den Vertrag, keine über den Server.
 *
 * Ohne `months` gilt die Verlängerungsdauer der geltenden Version. Ein
 * unbefristeter Vertrag wird abgewiesen (422): Er läuft ohnehin weiter.
 */
export const POST = defineRoute({
  permissions: ['contract:activate'],
  params: idParam,
  body: contractRenewSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) =>
    ok(
      await renewContract({
        organizationId: await getOrganizationId(),
        contractId: params.id,
        actorId: session.id,
        ip,
        months: body.months,
        reason: body.reason,
      }),
    ),
});
