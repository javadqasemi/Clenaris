import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { releaseCancelSchema } from '@/lib/validation/system';
import { getOrganizationId } from '@/server/services/organization.service';
import { releaseTerminStornieren } from '@/server/services/release.service';

export const runtime = 'nodejs';

/**
 * POST /api/system/releases/:id/termin/stornieren — einen Termin zurücknehmen.
 *
 * Nur aus „terminiert"; der Auftrag wird CANCELLED und bleibt als Nachweis,
 * die Version ist danach wieder verfügbar. 422 aus jedem anderen Zustand.
 */
export const POST = defineRoute({
  permissions: ['release:manage'],
  params: idParam,
  body: releaseCancelSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip, request }) =>
    ok(
      await releaseTerminStornieren(
        { organizationId: await getOrganizationId(), actorId: session.id, ip, userAgent: request.headers.get('user-agent') },
        params.id,
        body.grund,
      ),
    ),
});
