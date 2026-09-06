import { defineRoute } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { createPriceRuleSchema } from '@/lib/validation/catalog';
import { createPriceRule, listPriceRules } from '@/server/services/catalog.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * GET /api/price-rules — Zuschläge und Abschläge, nach Priorität sortiert.
 *
 * Die Sortierung ist dieselbe wie in der Preis-Engine (aufsteigend nach
 * `priority`), damit die Liste in der Verwaltung die tatsächliche
 * Anwendungsreihenfolge zeigt und nicht eine gefällige.
 */
export const GET = defineRoute({
  permissions: ['pricing:read'],
  rateLimit: 'apiRead',
  handler: async () => ok(await listPriceRules(await getOrganizationId())),
});

/** POST /api/price-rules — neue Preisregel anlegen. */
export const POST = defineRoute({
  permissions: ['pricing:update'],
  body: createPriceRuleSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) => {
    const rule = await createPriceRule({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      input: body,
    });
    return created({ id: rule.id, name: rule.name });
  },
});
