import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { issueInvoice } from '@/server/services/invoice.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/invoices/:id/issue
 *
 * Vergibt die fortlaufende Nummer, erzeugt die QR-Referenz und rendert das
 * PDF. Ab hier ist die Rechnung unveränderlich.
 */
export const POST = defineRoute({
  permissions: ['invoice:send'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session }) => {
    const organizationId = await getOrganizationId();

    const invoice = await issueInvoice({
      organizationId,
      invoiceId: params.id,
      actorId: session.id,
    });

    return ok({ id: invoice.id, number: invoice.number, status: invoice.status });
  },
});
