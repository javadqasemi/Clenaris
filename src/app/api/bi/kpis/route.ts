import { defineRoute } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { createKpiDefinitionSchema, kpiListQuery } from '@/lib/validation/bi-kpi';
import { createKpiDefinition, getKpiOverview } from '@/server/services/kpi.service';
import { getOrganizationId } from '@/server/services/organization.service';
import { audit } from '@/lib/audit';

export const runtime = 'nodejs';

/** GET /api/bi/kpis — alle Kennzahlen mit jüngstem Monatswert. */
export const GET = defineRoute({
  permissions: ['kpi:read'],
  query: kpiListQuery,
  rateLimit: 'apiRead',
  handler: async ({ query }) => {
    const organizationId = await getOrganizationId();
    const rows = await getKpiOverview(organizationId, 'MONTH', {
      group: query.group,
      active: query.active === undefined ? undefined : query.active === '1',
      q: query.q,
    });
    return ok(rows);
  },
});

/** POST /api/bi/kpis — Kennzahl anlegen (manuell oder mit vorhandenem Rechner). */
export const POST = defineRoute({
  permissions: ['kpi:manage'],
  body: createKpiDefinitionSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session }) => {
    const organizationId = await getOrganizationId();
    const definition = await createKpiDefinition(organizationId, body);
    await audit.created({ organizationId, userId: session.id, entity: 'KpiDefinition', entityId: definition.id, summary: `Kennzahl „${definition.label}" angelegt` });
    return created({ id: definition.id, key: definition.key });
  },
});
