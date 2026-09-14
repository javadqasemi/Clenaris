import { defineRoute, idParam } from '@/lib/api/handler';
import { noContent, ok } from '@/lib/api/response';
import { updateRiskSchema } from '@/lib/validation/bi-governance';
import { deleteRisk, getRisk, updateRisk } from '@/server/services/governance.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/bi/risks/:id — mit Massnahmen und Dateien. */
export const GET = defineRoute({
  permissions: ['risk:read'],
  params: idParam,
  rateLimit: 'apiRead',
  handler: async ({ params }) => ok(await getRisk(await getOrganizationId(), params.id)),
});

/** PATCH /api/bi/risks/:id */
export const PATCH = defineRoute({
  permissions: ['risk:update'],
  params: idParam,
  body: updateRiskSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const risk = await updateRisk(session, await getOrganizationId(), params.id, body);
    return ok({ id: risk.id, severity: risk.severity, residualSeverity: risk.residualSeverity });
  },
});

/** DELETE /api/bi/risks/:id — Papierkorb. */
export const DELETE = defineRoute({
  permissions: ['risk:delete'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session }) => {
    await deleteRisk(session, await getOrganizationId(), params.id);
    return noContent();
  },
});
