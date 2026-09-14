import { defineRoute } from '@/lib/api/handler';
import { buildPagination, created, paginated } from '@/lib/api/response';
import { controlListQuery, createControlSchema } from '@/lib/validation/bi-governance';
import { createControl, listControls } from '@/server/services/governance.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/bi/controls — Abläufe, Standards, Compliance-Pflichten, Notfallpläne. */
export const GET = defineRoute({
  permissions: ['control:read'],
  query: controlListQuery,
  rateLimit: 'apiRead',
  handler: async ({ query }) => {
    const { items, total } = await listControls(await getOrganizationId(), query);
    return paginated(items, buildPagination(query.page, query.pageSize, total));
  },
});

/** POST /api/bi/controls */
export const POST = defineRoute({
  permissions: ['control:create'],
  body: createControlSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session }) => {
    const control = await createControl(session, await getOrganizationId(), body);
    return created({ id: control.id });
  },
});
