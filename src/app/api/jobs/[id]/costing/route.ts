import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { jobCostingSchema, jobMaterialsSchema } from '@/lib/validation/operations';
import { replaceJobMaterials, updateJobCosting } from '@/server/services/job.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * PATCH /api/jobs/:id/costing — Nachkalkulation bearbeiten, neu berechnen
 * oder abnehmen.
 *
 * Hinter `dashboard:financials`, nicht hinter `job:update`: Wer disponiert,
 * muss nicht sehen, was ein Einsatz einbringt. Deckungsbeitrag je Auftrag ist
 * die Zahl, an der sich Löhne und Preise entscheiden — sie gehört zu den
 * Finanzen, auch wenn sie an einem Einsatz hängt.
 */
export const PATCH = defineRoute({
  permissions: ['dashboard:financials'],
  params: idParam,
  body: jobCostingSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const result = await updateJobCosting({
      organizationId: await getOrganizationId(),
      jobId: params.id,
      input: body,
      actorId: session.id,
    });

    return ok(result);
  },
});

/**
 * PUT /api/jobs/:id/costing — Materialverbrauch setzen.
 *
 * Material erfasst das Team, nicht die Buchhaltung — deshalb `job:update` und
 * nicht `dashboard:financials`. Der resultierende Materialaufwand fliesst
 * automatisch in die Nachkalkulation.
 */
export const PUT = defineRoute({
  permissions: ['job:update'],
  params: idParam,
  body: jobMaterialsSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const materialCost = await replaceJobMaterials({
      organizationId: await getOrganizationId(),
      jobId: params.id,
      input: body,
      actorId: session.id,
    });

    return ok({ id: params.id, materialCost });
  },
});
