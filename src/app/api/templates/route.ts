import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { listTemplates } from '@/server/services/operations-admin.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * GET /api/templates — E-Mail- und SMS-Vorlagen.
 *
 * Anlegen und Löschen gibt es bewusst nicht: der Schlüssel
 * (`booking_confirmation`, `invoice_issued`, …) steht im Code, dort wird die
 * Vorlage nachgeschlagen. Eine frei angelegte Vorlage riefe niemand auf; eine
 * gelöschte liesse eine Bestätigungsmail ausfallen. Änderbar ist der Text —
 * und das ist auch das, was die Redaktion ändern will.
 */
export const GET = defineRoute({
  permissions: ['template:read'],
  rateLimit: 'apiRead',
  handler: async () => ok(await listTemplates(await getOrganizationId())),
});
