import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { biAssistantSchema } from '@/lib/validation/bi-ai';
import { runAssistant } from '@/server/services/bi-assistant.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';
export const maxDuration = 120;

/**
 * POST /api/bi/assistant — der Führungsassistent.
 *
 * Eine Fähigkeit je Aufruf (`kind`). Jede Antwort trägt Begründung,
 * Datenquellen und Vertrauensgrad und ist ein Entwurf — übernommen wird
 * über die gewöhnlichen Endpunkte (Tafel anlegen, Risiko erfassen, …).
 */
export const POST = defineRoute({
  permissions: ['cockpit:view', 'ai:use'],
  body: biAssistantSchema,
  rateLimit: 'aiGenerate',
  handler: async ({ body, session }) => ok(await runAssistant(session, await getOrganizationId(), body)),
});
