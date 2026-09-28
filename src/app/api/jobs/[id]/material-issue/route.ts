import { defineRoute, idParam } from '@/lib/api/handler';
import { created } from '@/lib/api/response';
import { jobMaterialIssueSchema } from '@/lib/validation/betrieb';
import { issueToJob } from '@/server/services/inventory.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/jobs/:id/material-issue — Material aus dem Lager für einen
 * Einsatz: Verbrauchszeile, Lagerentnahme und Materialaufwand der
 * Nachkalkulation in einer Transaktion. Preis und Bezeichnung kommen aus dem
 * Materialstamm, nicht vom Client. Nach der Vor-Ort-Abnahme ist der Rapport
 * eingefroren (422).
 */
export const POST = defineRoute({
  permissions: ['inventory:manage'],
  params: idParam,
  body: jobMaterialIssueSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) =>
    created(await issueToJob({ organizationId: await getOrganizationId(), jobId: params.id, actorId: session.id, ip, input: body })),
});
