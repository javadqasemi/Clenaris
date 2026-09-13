import { defineRoute } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { createCompetitorSchema } from '@/lib/validation/bi-knowledge';
import { createCompetitor, listCompetitors } from '@/server/services/knowledge.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/bi/competitors */
export const GET = defineRoute({
  permissions: ['market:read'],
  rateLimit: 'apiRead',
  handler: async () => ok(await listCompetitors(await getOrganizationId())),
});

/** POST /api/bi/competitors */
export const POST = defineRoute({
  permissions: ['market:manage'],
  body: createCompetitorSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session }) => {
    const competitor = await createCompetitor(session, await getOrganizationId(), body);
    return created({ id: competitor.id });
  },
});
