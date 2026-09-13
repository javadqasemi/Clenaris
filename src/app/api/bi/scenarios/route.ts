import { defineRoute } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { createScenarioSchema, scenarioListQuery } from '@/lib/validation/bi-finance';
import { createScenario, listScenarios } from '@/server/services/scenario.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/bi/scenarios */
export const GET = defineRoute({
  permissions: ['scenario:read'],
  query: scenarioListQuery,
  rateLimit: 'apiRead',
  handler: async ({ query }) => ok(await listScenarios(await getOrganizationId(), query)),
});

/** POST /api/bi/scenarios — ohne Annahmen aus den letzten zwölf Monaten vorbelegt. */
export const POST = defineRoute({
  permissions: ['scenario:manage'],
  body: createScenarioSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session }) => {
    const scenario = await createScenario(session, await getOrganizationId(), body);
    return created({ id: scenario.id, name: scenario.name });
  },
});
