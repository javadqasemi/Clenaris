import { defineRoute, idParam } from '@/lib/api/handler';
import { created } from '@/lib/api/response';
import { audit } from '@/lib/audit';
import { kpiTargetSchema } from '@/lib/validation/bi-kpi';
import { setKpiTarget } from '@/server/services/kpi.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** POST /api/bi/kpis/:id/targets — Zielwert für eine bestimmte Periode. */
export const POST = defineRoute({
  permissions: ['kpi:manage'],
  params: idParam,
  body: kpiTargetSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const organizationId = await getOrganizationId();
    const target = await setKpiTarget(organizationId, params.id, body);
    await audit.updated({ organizationId, userId: session.id, entity: 'KpiDefinition', entityId: params.id, summary: `Zielwert ${body.targetValue} für ${body.period} ab ${body.periodStart.toISOString().slice(0, 10)}` });
    return created({ id: target.id });
  },
});
