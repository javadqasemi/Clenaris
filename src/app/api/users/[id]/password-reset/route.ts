import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { sendAccessLinkFor } from '@/server/services/auth.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/users/:id/password-reset — Zugangslink durch die Verwaltung.
 *
 * Für ein eingeladenes, nie aktiviertes Konto geht eine neue Einladung
 * hinaus; für ein aktives Konto der Link zum Setzen eines neuen Passworts.
 * Die Verwaltung setzt nie selbst ein Passwort — ein von Hand vergebenes
 * Startpasswort landet zwangsläufig in einer E-Mail oder einem Chat und
 * bleibt dort liegen. Der Link ist einmalig und läuft ab.
 *
 * Hinter `user:update`, nicht `employee:update`: Es ist eine Handlung am
 * Konto, und die Betriebsleitung, die Personalakten pflegt, soll keine
 * Zugangslinks auslösen können.
 */
export const POST = defineRoute({
  permissions: ['user:update'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) => {
    const result = await sendAccessLinkFor({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      userId: params.id,
      ip,
    });
    return ok(result);
  },
});
