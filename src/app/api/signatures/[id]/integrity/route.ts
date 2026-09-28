import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { getOrganizationId } from '@/server/services/organization.service';
import { verifySignatureIntegrity } from '@/server/services/signature.service';

export const runtime = 'nodejs';

/**
 * GET /api/signatures/:id/integrity — A, B und C aus den gespeicherten
 * Bytes nachrechnen.
 *
 * `ok` heisst: die Bytes, die heute in der Ablage liegen, ergeben die beim
 * Abschluss eingefrorene Prüfsumme. `abweichung` ist der Befund, den dieses
 * Verfahren überhaupt liefern soll. `fehlt` heisst: Artefakt nicht (mehr)
 * auffindbar — ebenfalls ein Befund, kein Schönheitsfehler.
 */
export const GET = defineRoute({
  permissions: ['signature:read'],
  params: idParam,
  rateLimit: 'apiRead',
  handler: async ({ params, session }) => {
    const befund = await verifySignatureIntegrity(session, await getOrganizationId(), params.id);
    return ok(befund, { headers: { 'Cache-Control': 'private, no-store' } });
  },
});
