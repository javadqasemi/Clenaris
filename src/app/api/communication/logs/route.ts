import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { zustellprotokollQuerySchema } from '@/lib/validation/kommunikation';
import { listeZustellprotokoll } from '@/server/services/kommunikation.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * GET /api/communication/logs — das Zustellprotokoll von E-Mail oder SMS
 * (Wave 14): Empfänger, Betreff bzw. Kanal, Vorlage, Status laut Anbieter,
 * Zustell- und Öffnungszeitpunkt. Ohne Nachrichteninhalt.
 *
 * Bis hierher gab es für diese Tabellen keine Ansicht — ob eine Mahnung
 * zugestellt oder abgeprallt war, liess sich nicht nachsehen.
 */
export const GET = defineRoute({
  permissions: ['template:read'],
  query: zustellprotokollQuerySchema,
  rateLimit: 'apiRead',
  handler: async ({ query }) =>
    ok(
      await listeZustellprotokoll({
        organizationId: await getOrganizationId(),
        kanal: query.kanal,
        status: query.status,
        suche: query.suche,
        seit: new Date(Date.now() - query.tage * 86_400_000),
      }),
    ),
});
