import { defineRoute, idParam } from '@/lib/api/handler';
import { created } from '@/lib/api/response';
import { convertLeadToCustomer } from '@/server/services/crm.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/leads/:id/convert
 *
 * Erzeugt aus einem Lead einen Kundendatensatz und übernimmt die
 * Aktivitätenhistorie. Existiert bereits ein Kunde mit derselben E-Mail-
 * Adresse, wird verknüpft statt dupliziert — doppelte Kundendatensätze sind
 * im Tagesgeschäft eine der teuersten Fehlerquellen.
 */
export const POST = defineRoute({
  permissions: ['customer:create'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session }) => {
    const organizationId = await getOrganizationId();

    const customer = await convertLeadToCustomer({
      organizationId,
      leadId: params.id,
      actorId: session.id,
    });

    return created({ id: customer.id, number: customer.number });
  },
});
