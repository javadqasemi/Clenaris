import { defineRoute, idParam } from '@/lib/api/handler';
import { noContent, ok } from '@/lib/api/response';
import { updateScenarioSchema } from '@/lib/validation/bi-finance';
import { deleteScenario, getScenario, updateScenario } from '@/server/services/scenario.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/bi/scenarios/:id — mit Annahmen und gespeichertem Ergebnis. */
export const GET = defineRoute({
  permissions: ['scenario:read'],
  params: idParam,
  rateLimit: 'apiRead',
  handler: async ({ params }) => ok(await getScenario(await getOrganizationId(), params.id)),
});

/** PATCH /api/bi/scenarios/:id — Annahmen ersetzen, danach wird neu gerechnet. */
export const PATCH = defineRoute({
  permissions: ['scenario:manage'],
  params: idParam,
  body: updateScenarioSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => ok(await updateScenario(session, await getOrganizationId(), params.id, body)),
});

/** DELETE /api/bi/scenarios/:id */
export const DELETE = defineRoute({
  permissions: ['scenario:manage'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session }) => {
    await deleteScenario(session, await getOrganizationId(), params.id);
    return noContent();
  },
});
