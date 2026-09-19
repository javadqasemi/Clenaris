import { definePublicRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { prisma, toNumber } from '@/lib/db';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { absoluteUrl } from '@/lib/utils';
import {
  CHECKOUT_RETURN_PATHS,
  createCheckoutSession,
  ensureStripeCustomer,
} from '@/lib/payments/stripe';
import { payInvoiceSchema } from '@/lib/validation/finance';
import { publicTokenParams } from '@/lib/validation/queries';
import { sha256Hex } from '@/lib/crypto';
import { resolveWithLegacy, tokenRejectionError } from '@/server/services/access-token.service';

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
  // Zahlung ist eine abschliessende Handlung über einen Link ohne Anmeldung —
  // engeres Kontingent als `apiWrite`, und gezählt je Rechnung statt je
  // Absender (Begründung in `rate-limit.ts`).
  rateLimit: 'publicTokenAction',
  rateLimitKey: ({ request }) =>
    sha256Hex(request.nextUrl.pathname.split('/').at(-2) ?? 'unbekannt'),
  handler: async ({ params, body }) => {
    /**
     * `INVOICE_PAY`, nicht `INVOICE_VIEW` — und kein Rückfall auf alte
     * Links, unabhängig von `LEGACY_PUBLIC_TOKENS`.
     *
     * Eine Zahlung ist eine abschliessende Handlung mit Kosten. Ein Link,
     * der zum Ansehen weitergegeben wurde, darf sie nicht auslösen, und eine
     * cuid aus der Zeit vor der Tokeninfrastruktur erst recht nicht.
     */
    const aufgeloest = await resolveWithLegacy({
      raw: params.token,
      purpose: 'INVOICE_PAY',
      allowLegacy: false,
      legacyLookup: async (raw) =>
        prisma.invoice.findUnique({
          where: { publicToken: raw },
          select: { id: true, organizationId: true },
        }),
    });
    if (!aufgeloest.ok) throw tokenRejectionError(aufgeloest.reason, 'Rechnung');

    const invoice = await prisma.invoice.findFirst({
      where: { id: aufgeloest.resourceId, organizationId: aufgeloest.organizationId },
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
      organizationId: aufgeloest.organizationId,
      amount: balance,
      currency: invoice.currency,
      customerEmail: invoice.customer.email,
      stripeCustomerId,
      method: body.method,
      /**
       * **Hier stand der Token.** Die beiden Adressen lauteten
       * `/rechnung/${params.token}/danke` und `/rechnung/${params.token}` —
       * der rohe Capability-Token wanderte damit in die Checkout-Session bei
       * Stripe und von dort in Dashboard, API-Antworten und Webhook-Nutzlast.
       * Ein Geheimnis, das eine Rechnung öffnet und eine Zahlung auslöst,
       * gehört nicht in die Datenhaltung eines Dritten.
       *
       * Zurück kommt jetzt nur Stripes eigene Sitzungskennung. Der
       * Rückkehrweg löst sie serverseitig auf und stellt danach einen
       * frischen, kurzlebigen Ansichtstoken aus.
       *
       * Der Abbruchweg bekommt gar keine Kennung: Für `cancel_url` ist die
       * Ersetzung von `{CHECKOUT_SESSION_ID}` nicht in derselben Weise
       * zugesichert wie für `success_url`, und eine Abbruchseite braucht
       * keine Rechnungsdaten.
       */
      successUrl: absoluteUrl(CHECKOUT_RETURN_PATHS.success),
      cancelUrl: absoluteUrl(CHECKOUT_RETURN_PATHS.cancel),
      description: `Reinigungsdienstleistungen · Rechnung ${invoice.number}`,
    });

    return ok({ url: session.url, sessionId: session.id });
  },
});
