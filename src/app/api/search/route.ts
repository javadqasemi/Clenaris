import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { globalSearchQuerySchema } from '@/lib/validation/search';
import { getOrganizationId } from '@/server/services/organization.service';
import { globaleSuche, VORSCHAU_JE_BEREICH } from '@/server/services/search.service';

export const runtime = 'nodejs';

/**
 * GET /api/search?q= — globale Suche über die Bereiche, die die Rolle lesen
 * darf (je höchstens fünf Treffer, `mehr` nennt die Bereiche mit weiteren).
 * Kein zweiter Weg zu Daten: jeder Bereich nur mit seiner Leseberechtigung,
 * die Organisation in jeder Abfrage, keine sensiblen Felder als Treffergrund.
 *
 * **Nur die Rollen der Verwaltung** (2026-09-27). `dashboard:view` haben auch
 * die Mitarbeitenden; sie bekamen hier Treffer mit Links nach `/admin`, das
 * sie nicht betreten dürfen. Die Suche gibt es in der Oberfläche nur im
 * Verwaltungsbereich, also auch den Endpunkt.
 */
export const GET = defineRoute({
  permissions: ['dashboard:view'],
  roles: ['SUPER_ADMIN', 'ADMIN', 'MANAGER'],
  query: globalSearchQuerySchema,
  rateLimit: 'search',
  handler: async ({ query, session }) =>
    ok(await globaleSuche({ organizationId: await getOrganizationId(), session, q: query.q, jeBereich: VORSCHAU_JE_BEREICH })),
});
