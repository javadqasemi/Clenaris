import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { prisma, toNumber } from '@/lib/db';
import { BusinessRuleError, ForbiddenError, NotFoundError } from '@/lib/errors';
import { absoluteUrl } from '@/lib/utils';
import {
  CHECKOUT_RETURN_PATHS,
  createCheckoutSession,
  ensureStripeCustomer,
} from '@/lib/payments/stripe';
import { payInvoiceSchema } from '@/lib/validation/finance';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/invoices/:id/pay
 *
 * Zahlung aus dem angemeldeten Kundenbereich starten.
 *
 * **Warum neben der öffentlichen Route.** Der Kundenbereich verwendete
 * bisher `invoice.publicToken` und damit den Weg für Aussenstehende — eine
 * angemeldete Person brauchte eine Capability, um ihre eigene Rechnung zu
 * bezahlen. Die Prüfkette ist hier `Sitzung → Kundendatensatz →
 * Eigentümerschaft`, und sie steht in der `where`-Klausel: Eine fremde
 * Rechnung wird nicht gefunden.
 *
 * Der Betrag stammt wie beim öffentlichen Weg ausschliesslich aus der
 * Datenbank, und gebucht wird über den Webhook, nicht über die Rückkehr-URL.
 */
export const POST = defineRoute({
  permissions: ['invoice:pay_own'],
  params: idParam,
  body: payInvoiceSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    if (!session.profileId) {
      throw new ForbiddenError('Dieses Konto ist keiner Kundschaft zugeordnet.');
    }

    const organizationId = await getOrganizationId();

    const invoice = await prisma.invoice.findFirst({
      where: {
        id: params.id,
        organizationId,
        customerId: session.profileId,
        deletedAt: null,
      },
      include: {
        customer: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            companyName: true,
            phone: true,
            stripeCustomerId: true,
          },
        },
      },
    });
    if (!invoice) throw new NotFoundError('Rechnung');

    if (invoice.status === 'CANCELLED') {
      throw new BusinessRuleError('Diese Rechnung wurde storniert.');
    }
    if (invoice.status === 'DRAFT') throw new NotFoundError('Rechnung');

    const balance = toNumber(invoice.balance);
    if (balance <= 0) {
      throw new BusinessRuleError('Diese Rechnung ist bereits vollständig bezahlt.');
    }

    const stripeCustomerId = await ensureStripeCustomer({
      existingId: invoice.customer.stripeCustomerId,
      email: invoice.customer.email,
      name:
        invoice.customer.companyName ??
        `${invoice.customer.firstName} ${invoice.customer.lastName}`,
      phone: invoice.customer.phone,
      metadata: { customerId: invoice.customer.id },
    });

    if (stripeCustomerId !== invoice.customer.stripeCustomerId) {
      await prisma.customer.update({
        where: { id: invoice.customer.id },
        data: { stripeCustomerId },
      });
    }

    const checkout = await createCheckoutSession({
      invoiceId: invoice.id,
      invoiceNumber: invoice.number,
      organizationId,
      amount: balance,
      currency: invoice.currency,
      customerEmail: invoice.customer.email,
      stripeCustomerId,
      method: body.method,
      // Dieselben token-freien Rückkehrwege wie beim öffentlichen Link.
      successUrl: absoluteUrl(CHECKOUT_RETURN_PATHS.success),
      cancelUrl: absoluteUrl(CHECKOUT_RETURN_PATHS.cancel),
      description: `Reinigungsdienstleistungen · Rechnung ${invoice.number}`,
    });

    return ok({ url: checkout.url, sessionId: checkout.id });
  },
});
