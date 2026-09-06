import { definePublicRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { prisma, toNumber } from '@/lib/db';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { absoluteUrl } from '@/lib/utils';
import { createCheckoutSession, ensureStripeCustomer } from '@/lib/payments/stripe';
import { payInvoiceSchema } from '@/lib/validation/finance';
import { publicTokenParams } from '@/lib/validation/queries';

export const runtime = 'nodejs';

/**
 * POST /api/public/invoices/:token/pay
 *
 * Startet eine Stripe-Checkout-Session für Karte oder TWINT.
 *
 * Der Betrag stammt ausschliesslich aus der Datenbank (`balance`) — er wird
 * nie vom Client entgegengenommen. Der Zahlungseingang wird über den Webhook
 * gebucht, nicht über die Rückkehr-URL: ein Nutzer, der den Tab nach der
 * Zahlung schliesst, darf keine unbezahlte Rechnung hinterlassen.
 */
export const POST = definePublicRoute({
  params: publicTokenParams,
  body: payInvoiceSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body }) => {
    const invoice = await prisma.invoice.findUnique({
      where: { publicToken: params.token },
      include: {
        customer: {
          select: { id: true, email: true, firstName: true, lastName: true, companyName: true, phone: true, stripeCustomerId: true },
        },
      },
    });

    if (!invoice || invoice.deletedAt) throw new NotFoundError('Rechnung');

    if (invoice.status === 'CANCELLED') {
      throw new BusinessRuleError('Diese Rechnung wurde storniert.');
    }

    const balance = toNumber(invoice.balance);
    if (balance <= 0) {
      throw new BusinessRuleError('Diese Rechnung ist bereits vollständig bezahlt.');
    }

    // Stripe-Kunden anlegen oder wiederverwenden — hält Zahlungen zuordenbar.
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

    const session = await createCheckoutSession({
      invoiceId: invoice.id,
      invoiceNumber: invoice.number,
      amount: balance,
      currency: invoice.currency,
      customerEmail: invoice.customer.email,
      stripeCustomerId,
      method: body.method,
      successUrl: absoluteUrl(`/rechnung/${params.token}/danke`),
      cancelUrl: absoluteUrl(`/rechnung/${params.token}`),
      description: `Reinigungsdienstleistungen · Rechnung ${invoice.number}`,
    });

    return ok({ url: session.url, sessionId: session.id });
  },
});
