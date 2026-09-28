import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { complaintTransitionSchema } from '@/lib/validation/betrieb';
import { transitionComplaint } from '@/server/services/complaint.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/complaints/:id/transition — bestätigen, bearbeiten, erledigen,
 * abschliessen, ablehnen, wieder öffnen.
 *
 * Der erste Schritt aus „Offen" hält die Reaktion fest — einmal. Unzulässige
 * Übergänge und gleichzeitige Änderungen ergeben 422. Erledigen und
 * Ablehnen verlangen eine für die Kundschaft sichtbare Begründung.
 */
export const POST = defineRoute({
  permissions: ['complaint:update'],
  params: idParam,
  body: complaintTransitionSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) =>
    ok(await transitionComplaint({ organizationId: await getOrganizationId(), id: params.id, actorId: session.id, ip, input: body })),
});
