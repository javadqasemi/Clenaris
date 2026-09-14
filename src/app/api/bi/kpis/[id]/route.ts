import { defineRoute, idParam } from '@/lib/api/handler';
import { noContent, ok } from '@/lib/api/response';
import { prisma } from '@/lib/db';
import { audit } from '@/lib/audit';
import { NotFoundError } from '@/lib/errors';
import { updateKpiDefinitionSchema } from '@/lib/validation/bi-kpi';
import { deleteKpiDefinition, updateKpiDefinition } from '@/server/services/kpi.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/bi/kpis/:id — Definition mit Zielwerten je Periode. */
export const GET = defineRoute({
  permissions: ['kpi:read'],
  params: idParam,
  rateLimit: 'apiRead',
  handler: async ({ params }) => {
    const organizationId = await getOrganizationId();
    const definition = await prisma.kpiDefinition.findFirst({
      where: { id: params.id, organizationId },
      include: { targets: { orderBy: { periodStart: 'desc' }, take: 24 } },
    });
    if (!definition) throw new NotFoundError('Kennzahl');
    return ok(definition);
  },
});

/** PATCH /api/bi/kpis/:id — Zielwert, Warnschwelle, Gewicht, Anzeige. */
export const PATCH = defineRoute({
  permissions: ['kpi:manage'],
  params: idParam,
  body: updateKpiDefinitionSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const organizationId = await getOrganizationId();
    const definition = await updateKpiDefinition(organizationId, params.id, body);
    await audit.updated({ organizationId, userId: session.id, entity: 'KpiDefinition', entityId: params.id, summary: `Kennzahl „${definition.label}" geändert`, changes: body });
    return ok({ id: definition.id });
  },
});

/** DELETE /api/bi/kpis/:id */
export const DELETE = defineRoute({
  permissions: ['kpi:manage'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session }) => {
    const organizationId = await getOrganizationId();
    await deleteKpiDefinition(organizationId, params.id);
    await audit.deleted({ organizationId, userId: session.id, entity: 'KpiDefinition', entityId: params.id, summary: 'Kennzahl gelöscht' });
    return noContent();
  },
});
