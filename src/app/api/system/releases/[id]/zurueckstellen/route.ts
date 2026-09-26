import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { releaseDeferSchema } from '@/lib/validation/system';
import { getOrganizationId } from '@/server/services/organization.service';
import { releaseZurueckstellen } from '@/server/services/release.service';

export const runtime = 'nodejs';

/**
 * POST /api/system/releases/:id/zurueckstellen — „Nicht jetzt".
 *
 * Blendet eine verfügbare Version im Dashboard für einige Tage aus (Vorgabe
 * sieben). Keine Freigabe, kein Auftrag — nur die festgehaltene Entscheidung,
 * jetzt nicht zu aktualisieren.
 */
export const POST = defineRoute({
  permissions: ['release:manage'],
  params: idParam,
  body: releaseDeferSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip, request }) =>
    ok(
      await releaseZurueckstellen(
        { organizationId: await getOrganizationId(), actorId: session.id, ip, userAgent: request.headers.get('user-agent') },
        params.id,
        body.tage,
      ),
    ),
});
