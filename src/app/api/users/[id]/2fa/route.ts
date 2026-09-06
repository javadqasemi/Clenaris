import { defineRoute, idParam } from '@/lib/api/handler';
import { noContent } from '@/lib/api/response';
import { resetTwoFactorFor } from '@/server/services/two-factor.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * DELETE /api/users/:id/2fa — zweiten Faktor eines fremden Kontos zurücksetzen.
 *
 * Der Notausgang, wenn jemand Telefon *und* Wiederherstellungscodes verloren
 * hat. Nur die Systemverantwortung darf das: es ist die einzige Handlung, die
 * einen Schutz von aussen entfernt.
 *
 * Alle Sitzungen der Person werden dabei beendet — ist das Konto tatsächlich
 * übernommen worden, endet der Zugriff in diesem Moment.
 */
export const DELETE = defineRoute({
  permissions: ['user:update', 'role:assign'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) => {
    await resetTwoFactorFor({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      userId: params.id,
      ip,
    });
    return noContent();
  },
});
