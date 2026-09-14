import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { audit } from '@/lib/audit';
import { healthWeightsSchema } from '@/lib/validation/bi-kpi';
import { updateHealthWeights } from '@/server/services/kpi.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** PATCH /api/bi/kpis/weights — Gewichte im Gesundheitswert setzen. */
export const PATCH = defineRoute({
  permissions: ['kpi:manage'],
  body: healthWeightsSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session }) => {
    const organizationId = await getOrganizationId();
    const weights = await updateHealthWeights(organizationId, body);
    await audit.updated({ organizationId, userId: session.id, entity: 'KpiDefinition', summary: 'Gewichte des Gesundheitswerts geändert', changes: body.weights });
    return ok(weights);
  },
});
