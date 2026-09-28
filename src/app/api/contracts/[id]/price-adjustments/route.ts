import { defineRoute } from '@/lib/api/handler';
import { created } from '@/lib/api/response';
import { priceAdjustmentCreateSchema } from '@/lib/validation/contracts';
import { idParam } from '@/lib/validation/queries';
import { createPriceAdjustment } from '@/server/services/contract-amendment.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/contracts/{id}/price-adjustments — eine Preisanpassung
 * vorschlagen.
 *
 * ---------------------------------------------------------------------------
 *  Keine Behauptung über Indexierung
 * ---------------------------------------------------------------------------
 *
 * Ob und wie ein Vertrag indexiert wird, steht **im Vertrag**. Dieses Modul
 * erfindet keine Regel und ruft keinen Index ab: `indexReference` hält fest,
 * worauf sich die Parteien geeinigt haben, und die Indexwerte werden erfasst.
 * Eine automatische Erhöhung findet nicht statt — jede Anpassung braucht eine
 * Freigabe und erzeugt dann eine neue Vertragsversion.
 *
 * `oldAmount` ist **kein** Feld der Anfrage: Der bisherige Betrag steht in der
 * geltenden Version. Ihn mitschicken zu lassen hiesse, dem Client zu erlauben,
 * die Vergangenheit zu behaupten — dieselbe Regel wie bei Preisen und Löhnen.
 */
export const POST = defineRoute({
  permissions: ['contract:version'],
  params: idParam,
  body: priceAdjustmentCreateSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) =>
    created(
      await createPriceAdjustment({
        organizationId: await getOrganizationId(),
        contractId: params.id,
        actorId: session.id,
        ip,
        input: body,
      }),
    ),
});
