import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { trafficZeitraumAufloesen } from '@/lib/traffic/zeitraum';
import { trafficAuswertungQuerySchema } from '@/lib/validation/traffic';
import { getOrganizationId } from '@/server/services/organization.service';
import { trafficAuswertung } from '@/server/services/traffic.service';

export const runtime = 'nodejs';

/**
 * GET /api/traffic — Besuchsauswertung eines Zeitraums.
 *
 * Dieselben Zahlen wie die Seite `/admin/auswertungen/website`, die sie als
 * Server Component direkt aus dem Dienst liest. Den Endpunkt gibt es für
 * Werkzeuge ausserhalb der Oberfläche (ein Monatsbericht, eine Tabelle) und
 * damit die Prüfreihe die Rechteschranke über HTTP belegen kann; beide Wege
 * gehen durch `trafficAuswertung`, es gibt keine zweite Rechnung.
 */
export const GET = defineRoute({
  permissions: ['traffic:read'],
  query: trafficAuswertungQuerySchema,
  rateLimit: 'apiRead',
  handler: async ({ query }) => {
    const zeitraum = trafficZeitraumAufloesen(query.zeitraum, query.von, query.bis);
    return ok(await trafficAuswertung(await getOrganizationId(), zeitraum));
  },
});
