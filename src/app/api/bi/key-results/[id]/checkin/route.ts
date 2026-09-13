import { defineRoute, idParam } from '@/lib/api/handler';
import { created } from '@/lib/api/response';
import { keyResultCheckinSchema } from '@/lib/validation/bi-objectives';
import { checkinKeyResult } from '@/server/services/objective.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/bi/key-results/:id/checkin — Fortschritt eintragen.
 *
 * Mitarbeitende dürfen das an ihren eigenen Zielen; die Grenze zieht der
 * Dienst über die Sichtbarkeit des Ziels und die Verantwortung.
 */
export const POST = defineRoute({
  permissions: ['objective:checkin'],
  params: idParam,
  body: keyResultCheckinSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const organizationId = await getOrganizationId();
    const checkin = await checkinKeyResult(session, organizationId, params.id, body);
    return created({ id: checkin.id });
  },
});
