import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { sendInvoiceEmailSchema } from '@/lib/validation/finance';
import { sendInvoice } from '@/server/services/invoice.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/invoices/:id/send
 *
 * Versendet die Rechnung mit PDF im Anhang. Ist die Rechnung noch ein
 * Entwurf, wird sie vorher ausgestellt — eine Rechnung ohne Nummer zu
 * verschicken wäre buchhalterisch unzulässig.
 */
export const POST = defineRoute({
  permissions: ['invoice:send'],
  params: idParam,
  body: sendInvoiceEmailSchema.optional().default({}),
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const organizationId = await getOrganizationId();

    const invoice = await sendInvoice({
      organizationId,
      invoiceId: params.id,
      email: body?.email,
      actorId: session.id,
    });

    return ok({ id: invoice.id, number: invoice.number, status: invoice.status });
  },
});

