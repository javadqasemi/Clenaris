import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { cancelInvoiceSchema } from '@/lib/validation/finance';
import { cancelInvoice } from '@/server/services/invoice.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/invoices/:id/cancel
 *
 * Storniert eine unbezahlte Rechnung. Die Nummer bleibt vergeben — eine
 * Lücke im Nummernkreis wäre bei einer Revision erklärungsbedürftig.
 */
export const POST = defineRoute({
  permissions: ['invoice:update'],
  params: idParam,
  body: cancelInvoiceSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const organizationId = await getOrganizationId();

    const invoice = await cancelInvoice({
      organizationId,
      invoiceId: params.id,
      reason: body.reason,
      actorId: session.id,
    });

    return ok({ id: invoice.id, status: invoice.status });
  },
});

