import { defineRoute, idParam } from '@/lib/api/handler';
import { created } from '@/lib/api/response';
import { recordPaymentSchema } from '@/lib/validation/finance';
import { recordPayment } from '@/server/services/invoice.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/invoices/:id/payments — manuelle Zahlungserfassung.
 *
 * Für Banküberweisungen und Barzahlungen. Karten- und TWINT-Zahlungen kommen
 * über den Stripe-Webhook herein und werden dort idempotent gebucht.
 */
export const POST = defineRoute({
  permissions: ['payment:create'],
  params: idParam,
  body: recordPaymentSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const organizationId = await getOrganizationId();

    const { invoice, fullyPaid } = await recordPayment({
      organizationId,
      invoiceId: params.id,
      input: body,
      actorId: session.id,
    });

    return created({
      invoiceId: invoice.id,
      status: invoice.status,
      balance: invoice.balance,
      fullyPaid,
    });
  },
});
