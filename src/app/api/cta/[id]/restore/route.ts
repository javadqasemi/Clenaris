import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { restoreCta } from '@/server/services/cta.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/cta/:id/restore — aus dem Papierkorb zurückholen.
 *
 * Der Aufruf kommt bewusst **inaktiv** zurück. Wer wiederherstellt, will erst
 * nachsehen und dann veröffentlichen — nicht, dass die Schaltfläche im selben
 * Moment wieder auf der Website steht.
 */
export const POST = defineRoute({
  permissions: ['cta:update'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) => {
    const cta = await restoreCta({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      ctaId: params.id,
    });
    return ok({ id: cta.id, active: cta.active });
  },
});
