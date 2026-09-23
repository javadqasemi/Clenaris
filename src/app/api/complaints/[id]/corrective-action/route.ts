import { defineRoute, idParam } from '@/lib/api/handler';
import { created } from '@/lib/api/response';
import { complaintCorrectiveActionSchema } from '@/lib/validation/betrieb';
import { createCorrectiveActionFromComplaint } from '@/server/services/complaint.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/complaints/:id/corrective-action — eine Korrekturmassnahme
 * ableiten; sie erscheint in den Massnahmen der Unternehmensführung. Je
 * Reklamation eine (422 bei der zweiten).
 */
export const POST = defineRoute({
  permissions: ['complaint:update'],
  params: idParam,
  body: complaintCorrectiveActionSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) =>
    created(
      await createCorrectiveActionFromComplaint({
        organizationId: await getOrganizationId(),
        id: params.id,
        actorId: session.id,
        ip,
        input: body,
      }),
    ),
});
