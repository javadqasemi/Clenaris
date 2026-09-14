import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { prisma } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';
import { kpiSeriesQuery } from '@/lib/validation/bi-kpi';
import { getKpiSeries } from '@/server/services/kpi.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/bi/kpis/:id/series — Verlauf einer Kennzahl. */
export const GET = defineRoute({
  permissions: ['kpi:read'],
  params: idParam,
  query: kpiSeriesQuery,
  rateLimit: 'apiRead',
  handler: async ({ params, query }) => {
    const organizationId = await getOrganizationId();
    const definition = await prisma.kpiDefinition.findFirst({ where: { id: params.id, organizationId }, select: { id: true } });
    if (!definition) throw new NotFoundError('Kennzahl');
    return ok(await getKpiSeries(organizationId, params.id, query));
  },
});
