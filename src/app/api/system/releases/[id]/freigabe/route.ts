import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { getOrganizationId } from '@/server/services/organization.service';
import { releaseFreigeben } from '@/server/services/release.service';

export const runtime = 'nodejs';

/**
 * POST /api/system/releases/:id/freigabe — eine verfügbare Version freigeben.
 *
 * Legt einen Aktualisierungsauftrag an (APPROVED) und schreibt ihn im selben
 * Commit ins Prüfprotokoll. Es wird **nichts** ausgerollt: Der Auftrag ist
 * eine Entscheidung, die ein externer, vertrauenswürdiger Ausführer später
 * liest. 422, wenn die Version installiert, älter oder schon freigegeben ist.
 */
export const POST = defineRoute({
  permissions: ['release:manage'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip, request }) =>
    ok(
      await releaseFreigeben(
        { organizationId: await getOrganizationId(), actorId: session.id, ip, userAgent: request.headers.get('user-agent') },
        params.id,
      ),
    ),
});
