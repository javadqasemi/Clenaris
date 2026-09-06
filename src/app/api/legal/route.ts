import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { listLegalDocuments } from '@/server/services/navigation.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * GET /api/legal — die vier Rechtstexte.
 *
 * Noch nicht erfasste erscheinen als leere Platzhalter mit `version: 0`.
 * Sonst sähe die Redaktion eine kurze Liste und wüsste nicht, dass die
 * Datenschutzerklärung fehlt — und genau deren Fehlen ist ein Rechtsmangel.
 */
export const GET = defineRoute({
  permissions: ['legal:read'],
  rateLimit: 'apiRead',
  handler: async () => ok(await listLegalDocuments(await getOrganizationId())),
});
