import { defineRoute, idParam } from '@/lib/api/handler';
import { created } from '@/lib/api/response';
import { audit } from '@/lib/audit';
import { manualKpiValueSchema } from '@/lib/validation/bi-kpi';
import { recordManualValue } from '@/server/services/kpi.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** POST /api/bi/kpis/:id/value — manuellen Wert für eine Periode eintragen. */
export const POST = defineRoute({
  permissions: ['kpi:manage'],
  params: idParam,
  body: manualKpiValueSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const organizationId = await getOrganizationId();
    const snapshot = await recordManualValue(organizationId, params.id, body);
    await audit.updated({ organizationId, userId: session.id, entity: 'KpiDefinition', entityId: params.id, summary: `Manueller Kennzahlwert ${body.value} für ${body.period} ab ${body.periodStart.toISOString().slice(0, 10)}` });
    return created({ id: snapshot.id });
  },
});
