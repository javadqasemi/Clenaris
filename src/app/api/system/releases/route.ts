import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { getOrganizationId } from '@/server/services/organization.service';
import { listReleases } from '@/server/services/release.service';

export const runtime = 'nodejs';

/**
 * GET /api/system/releases — bekannte Clenaris-Versionen mit ihrem Zustand.
 *
 * Nur die Systemverantwortung (`release:read`). Die Antwort nennt die
 * laufende Version und je Version, ob sie verfügbar, freigegeben, terminiert
 * oder installiert ist. Ausführen lässt sich über diesen Bereich nichts —
 * siehe `release.service.ts`.
 */
export const GET = defineRoute({
  permissions: ['release:read'],
  rateLimit: 'apiRead',
  handler: async () => ok(await listReleases(await getOrganizationId())),
});
