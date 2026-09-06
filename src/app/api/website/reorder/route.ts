import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { websiteReorderSchema } from '@/lib/validation/website';
import { reorderWebsite } from '@/server/services/website.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/website/reorder — Reihenfolge von Fragen oder Galeriebildern setzen.
 *
 * Übergeben wird die Reihenfolge als Liste von IDs; die Positionen vergibt der
 * Server aus dem Index. So kann kein Zustand entstehen, in dem zwei Einträge
 * dieselbe Position tragen und die Anzeige vom Zufall abhängt.
 *
 * Die nötige Berechtigung richtet sich nach dem Bereich — beide Rechte werden
 * verlangt, weil ein Endpunkt nicht mitten im Ablauf die Schwelle wechseln
 * kann. Wer beides sortieren können soll, braucht beides.
 */
export const POST = defineRoute({
  permissions: ['faq:update', 'gallery:update'],
  anyPermission: true,
  body: websiteReorderSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) => {
    const result = await reorderWebsite({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      input: body,
    });
    return ok(result);
  },
});
