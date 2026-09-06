import { defineRoute, idParam } from '@/lib/api/handler';
import { noContent } from '@/lib/api/response';
import { unsubscribeNewsletter } from '@/server/services/operations-admin.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * DELETE /api/newsletter/:id — Abonnement austragen.
 *
 * Die Zeile bleibt bestehen und wird als ausgetragen markiert: sie ist der
 * Nachweis, dass widersprochen wurde. Gelöscht könnte dieselbe Adresse beim
 * nächsten Import wieder in der Liste landen, und der Widerspruch wäre nicht
 * mehr belegbar.
 *
 * Ändern gibt es bewusst nicht: die E-Mail-Adresse ist der Identifikator, und
 * sie zu ändern hiesse, jemand anderen anzuschreiben, ohne dass diese Person
 * zugestimmt hat.
 */
export const DELETE = defineRoute({
  permissions: ['newsletter:delete'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) => {
    await unsubscribeNewsletter({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      subscriberId: params.id,
    });
    return noContent();
  },
});
