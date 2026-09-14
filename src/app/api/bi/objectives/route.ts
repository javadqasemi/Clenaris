import { defineRoute } from '@/lib/api/handler';
import { buildPagination, created, paginated } from '@/lib/api/response';
import { createObjectiveSchema, objectiveListQuery } from '@/lib/validation/bi-objectives';
import { createObjective, listObjectives } from '@/server/services/objective.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * GET /api/bi/objectives — Ziele, Strategien und Initiativen.
 *
 * Eine von beiden Berechtigungen genügt: das Büro sieht alle, Mitarbeitende
 * die eigenen und die freigegebenen Firmenziele. Die Grenze zieht der Dienst
 * in der `where`-Klausel.
 */
export const GET = defineRoute({
  permissions: ['objective:read', 'objective:read_own'],
  anyPermission: true,
  query: objectiveListQuery,
  rateLimit: 'apiRead',
  handler: async ({ query, session }) => {
    const organizationId = await getOrganizationId();
    const { items, total } = await listObjectives(session, organizationId, query);
    return paginated(items, buildPagination(query.page, query.pageSize, total));
  },
});

/** POST /api/bi/objectives */
export const POST = defineRoute({
  permissions: ['objective:create'],
  body: createObjectiveSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session }) => {
    const organizationId = await getOrganizationId();
    const objective = await createObjective(session, organizationId, body);
    return created({ id: objective.id, title: objective.title });
  },
});
