import { defineRoute } from '@/lib/api/handler';
import { created } from '@/lib/api/response';
import { priceAdjustmentParams } from '@/lib/validation/contracts';
import { applyPriceAdjustment } from '@/server/services/contract-amendment.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/contracts/{id}/price-adjustments/{adjustmentId}/apply — die
 * freigegebene Anpassung in eine Vertragsversion überführen.
 *
 * Kein Rumpf, und das ist der Punkt: Die neue Version übernimmt **alle**
 * Konditionen der geltenden Fassung und ändert genau einen Wert — den Betrag,
 * der in der Anpassung steht. Ein Rumpf hier würde einladen, „bei der
 * Gelegenheit" noch etwas anderes zu verschieben, und dann wäre es keine
 * Preisanpassung mehr, sondern eine Vertragsänderung ohne Änderungsantrag.
 *
 * Die neue Version entsteht als Entwurf; in Kraft tritt sie über `/activate`.
 */
export const POST = defineRoute({
  permissions: ['contract:version'],
  params: priceAdjustmentParams,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) =>
    created(
      await applyPriceAdjustment({
        organizationId: await getOrganizationId(),
        contractId: params.id,
        adjustmentId: params.adjustmentId,
        actorId: session.id,
        ip,
      }),
    ),
});
