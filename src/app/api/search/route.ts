import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { globalSearchQuerySchema } from '@/lib/validation/search';
import { getOrganizationId } from '@/server/services/organization.service';
import { globaleSuche } from '@/server/services/search.service';

export const runtime = 'nodejs';

/**
 * GET /api/search?q= — globale Suche über die Bereiche, die die Rolle lesen
 * darf (je höchstens fünf Treffer). Kein zweiter Weg zu Daten: jeder Bereich
 * nur mit seiner Leseberechtigung, die Organisation in jeder Abfrage, keine
 * sensiblen Felder als Treffergrund.
 */
export const GET = defineRoute({
  permissions: ['dashboard:view'],
  query: globalSearchQuerySchema,
  rateLimit: 'apiRead',
  handler: async ({ query, session }) =>
    ok(await globaleSuche({ organizationId: await getOrganizationId(), role: session.role, q: query.q })),
});
