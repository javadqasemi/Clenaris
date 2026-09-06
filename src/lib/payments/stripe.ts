import 'server-only';

import Stripe from 'stripe';
import { hasIntegration, serverEnv } from '@/lib/env';
import { IntegrationError } from '@/lib/errors';

/**
 * Zahlungsabwicklung.
 *
 * Architekturentscheid: TWINT läuft über Stripe als reguläre Payment Method
 * (`payment_method_types: ['twint']`, nur mit CHF und Schweizer Konto). Damit
 * gibt es *einen* Abgleichspfad, einen Webhook und ein Refund-Verfahren statt
 * zweier paralleler PSP-Integrationen. Datatrans bleibt als Fallback im
 * Environment vorgesehen, falls die Bank TWINT direkt anbindet.
 *
 * Beträge werden gegenüber Stripe in Rappen (kleinste Einheit) geführt.
 */

let stripeClient: Stripe | null = null;

export function stripe(): Stripe {
  if (!hasIntegration('stripe')) {
    throw new IntegrationError('Stripe', 'Zahlungen sind nicht konfiguriert.');
  }
  // Ohne `apiVersion` verwendet das SDK die Version, gegen die es typisiert ist —
  // damit können Typen und Laufzeit nicht auseinanderlaufen.
  stripeClient ??= new Stripe(serverEnv().STRIPE_SECRET_KEY!, {
    typescript: true,
    appInfo: { name: 'Clenaris', version: '1.0.0' },
  });
  return stripeClient;
}

export function toRappen(amountChf: number): number {
  return Math.round(amountChf * 100);
}

export function fromRappen(amountRappen: number): number {
  return Math.round(amountRappen) / 100;
}

export interface CheckoutParams {
  invoiceId: string;
  invoiceNumber: string;
  amount: number;
  currency?: string;
  customerEmail: string;
  stripeCustomerId?: string | null;
  method: 'CARD' | 'TWINT';
  successUrl: string;
  cancelUrl: string;
  description?: string;
}

/**
 * Stripe-Checkout-Session für eine Rechnung.
 * Bewusst Checkout statt eigener Elements-Integration: Stripe übernimmt damit
 * SCA/3-D-Secure, TWINT-Redirect und PCI-Scope vollständig.
 */
export async function createCheckoutSession(params: CheckoutParams): Promise<{
  id: string;
  url: string;
}> {
  const currency = (params.currency ?? 'CHF').toLowerCase();

  const methods: Stripe.Checkout.SessionCreateParams.PaymentMethodType[] =
    params.method === 'TWINT' ? ['twint'] : ['card'];

  const session = await stripe().checkout.sessions.create({
    mode: 'payment',
    payment_method_types: methods,
    customer: params.stripeCustomerId ?? undefined,
    customer_email: params.stripeCustomerId ? undefined : params.customerEmail,
    client_reference_id: params.invoiceId,
    line_items: [
      {
        price_data: {
          currency,
          unit_amount: toRappen(params.amount),
          product_data: {
            name: `Rechnung ${params.invoiceNumber}`,
            description: params.description ?? 'Reinigungsdienstleistungen',
          },
        },
        quantity: 1,
      },
    ],
    metadata: {
      invoiceId: params.invoiceId,
      invoiceNumber: params.invoiceNumber,
      method: params.method,
    },
    payment_intent_data: {
      metadata: { invoiceId: params.invoiceId, invoiceNumber: params.invoiceNumber },
      description: `Rechnung ${params.invoiceNumber}`,
    },
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    locale: 'de',
    automatic_tax: { enabled: false },
  });

  if (!session.url) {
    throw new IntegrationError('Stripe', 'Es konnte keine Zahlungsseite erzeugt werden.');
  }

  return { id: session.id, url: session.url };
}

/** Stripe-Kunde anlegen oder bestehenden zurückgeben. */
export async function ensureStripeCustomer(params: {
  existingId?: string | null;
  email: string;
  name: string;
  phone?: string | null;
  metadata?: Record<string, string>;
}): Promise<string> {
  if (params.existingId) {
    try {
      const existing = await stripe().customers.retrieve(params.existingId);
      if (!existing.deleted) return existing.id;
    } catch {
      // Kunde wurde in Stripe gelöscht — neu anlegen.
    }
  }

  const customer = await stripe().customers.create({
    email: params.email,
    name: params.name,
    phone: params.phone ?? undefined,
    metadata: params.metadata,
    preferred_locales: ['de-CH', 'de'],
  });
  return customer.id;
}

export async function createRefund(params: {
  paymentIntentId: string;
  amount?: number;
  reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer';
}): Promise<{ id: string; amount: number; status: string }> {
  const refund = await stripe().refunds.create({
    payment_intent: params.paymentIntentId,
    amount: params.amount ? toRappen(params.amount) : undefined,
    reason: params.reason ?? 'requested_by_customer',
  });
  return {
    id: refund.id,
    amount: fromRappen(refund.amount),
    status: refund.status ?? 'unknown',
  };
}

/** Webhook-Signatur prüfen — ohne diese Prüfung wäre der Endpunkt fälschbar. */
export function constructWebhookEvent(payload: string, signature: string): Stripe.Event {
  const secret = serverEnv().STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw new IntegrationError('Stripe', 'Webhook-Secret ist nicht konfiguriert.');
  }
  try {
    return stripe().webhooks.constructEvent(payload, signature, secret);
  } catch (error) {
    throw new IntegrationError(
      'Stripe',
      `Webhook-Signatur ungültig: ${error instanceof Error ? error.message : 'unbekannt'}`,
    );
  }
}

export async function listPaymentMethods(stripeCustomerId: string) {
  const methods = await stripe().paymentMethods.list({
    customer: stripeCustomerId,
    type: 'card',
  });
  return methods.data.map((m) => ({
    id: m.id,
    brand: m.card?.brand ?? null,
    last4: m.card?.last4 ?? null,
    expMonth: m.card?.exp_month ?? null,
    expYear: m.card?.exp_year ?? null,
  }));
}

export async function detachPaymentMethod(paymentMethodId: string) {
  await stripe().paymentMethods.detach(paymentMethodId);
}

/** SetupIntent, damit Kunden eine Karte für Abo-Reinigungen hinterlegen können. */
export async function createSetupIntent(stripeCustomerId: string) {
  const intent = await stripe().setupIntents.create({
    customer: stripeCustomerId,
    payment_method_types: ['card'],
    usage: 'off_session',
  });
  return { clientSecret: intent.client_secret! };
}
