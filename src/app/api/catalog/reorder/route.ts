import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { reorderSchema } from '@/lib/validation/catalog';
import { reorder } from '@/server/services/catalog.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/catalog/reorder — Reihenfolge von Leistungen, Zusätzen oder
 * Kategorien in einem Zug setzen.
 *
 * Gesendet wird die *Reihenfolge* (eine Liste von IDs), nicht einzelne
 * Positionszahlen. Der Server vergibt die Positionen aus dem Index; so kann
 * kein Zustand entstehen, in dem zwei Einträge dieselbe Position tragen.
 * Alles läuft in einer Transaktion — eine halb verschobene Liste wäre ein
 * Zustand, den niemand angeordnet hat.
 */
export const POST = defineRoute({
  permissions: ['service:update'],
  body: reorderSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) => {
    const result = await reorder({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      input: body,
    });
    return ok(result);
  },
});
