import type Stripe from 'stripe';

import { prisma } from '@/lib/db';
import { toErrorResponse } from '@/lib/api/response';
import { constructWebhookEvent, fromRappen } from '@/lib/payments/stripe';
import { recordPayment } from '@/server/services/invoice.service';
import { getOrganizationId } from '@/server/services/organization.service';
import { logger } from '@/lib/logger';

const log = logger('stripe');

export const runtime = 'nodejs';
// Stripe erwartet eine Antwort innerhalb von 20 Sekunden.
export const maxDuration = 30;

/**
 * POST /api/webhooks/stripe
 *
 * Architekturentscheide:
 *  1. Der *Webhook* bucht die Zahlung, nicht die Rückkehr-URL. Nur so ist der
 *     Zahlungseingang auch dann erfasst, wenn die Person den Tab schliesst.
 *  2. Die Signatur wird gegen `STRIPE_WEBHOOK_SECRET` geprüft. Ohne diese
 *     Prüfung könnte jeder beliebige Zahlungen melden.
 *  3. Der Rohtext des Bodys wird verwendet — `request.json()` würde die
 *     Signatur ungültig machen.
 *  4. Die Buchung ist idempotent: Stripe stellt Ereignisse mehrfach zu, und
 *     `providerPaymentId` ist in der Datenbank eindeutig.
 *  5. Fehler beim Verarbeiten führen zu einem 500 — dann wiederholt Stripe die
 *     Zustellung. Ein 200 auf einen Fehler würde die Zahlung verlieren.
 */
export async function POST(request: Request): Promise<Response> {
  const signature = request.headers.get('stripe-signature');
  if (!signature) {
    return new Response('Signatur fehlt', { status: 400 });
  }

  let event: Stripe.Event;
  try {
    const payload = await request.text();
    event = constructWebhookEvent(payload, signature);
  } catch (error) {
    log.error('Webhook-Signatur ungültig', { error });
    return new Response('Signatur ungültig', { status: 400 });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.payment_status !== 'paid') break;

        const invoiceId = session.metadata?.invoiceId ?? session.client_reference_id;
        if (!invoiceId) {
          log.warn('Checkout-Session ohne Rechnungsbezug', { sessionId: session.id });
          break;
        }

        const organizationId = await getOrganizationId();
        const method = session.metadata?.method === 'TWINT' ? 'TWINT' : 'CARD';

        await recordPayment({
          organizationId,
          invoiceId,
          provider: 'stripe',
          providerPaymentId: String(session.payment_intent ?? session.id),
          input: {
            amount: fromRappen(session.amount_total ?? 0),
            method,
            paidAt: new Date(),
            reference: session.id,
            note: `Online bezahlt via ${method === 'TWINT' ? 'TWINT' : 'Karte'}`,
          },
        });

        await prisma.invoice.update({
          where: { id: invoiceId },
          data: { stripePaymentIntentId: String(session.payment_intent ?? '') },
        });

        log.info('Zahlung gebucht', { invoiceId });
        break;
      }

      case 'charge.refunded': {
        const charge = event.data.object as Stripe.Charge;
        const paymentIntentId = String(charge.payment_intent ?? '');
        if (!paymentIntentId) break;

        const payment = await prisma.payment.findUnique({
          where: { providerPaymentId: paymentIntentId },
        });
        if (!payment) break;

        const refunded = fromRappen(charge.amount_refunded);

        await prisma.$transaction(async (tx) => {
          await tx.payment.update({
            where: { id: payment.id },
            data: {
              status: refunded >= Number(payment.amount) ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
              refundedAmount: refunded,
              refundedAt: new Date(),
            },
          });

          if (payment.invoiceId) {
            const invoice = await tx.invoice.findUniqueOrThrow({
              where: { id: payment.invoiceId },
            });
            const paidAmount = Math.max(0, Number(invoice.paidAmount) - refunded);
            const balance = Math.max(0, Number(invoice.grossTotal) - paidAmount);

            await tx.invoice.update({
              where: { id: invoice.id },
              data: {
                paidAmount,
                balance,
                status: balance > 0 ? 'PARTIALLY_PAID' : invoice.status,
                paidAt: balance > 0 ? null : invoice.paidAt,
              },
            });
          }
        });

        log.info('Rückerstattung verarbeitet', { paymentIntentId });
        break;
      }

      case 'payment_intent.payment_failed': {
        const intent = event.data.object as Stripe.PaymentIntent;
        const invoiceId = intent.metadata?.invoiceId;
        if (!invoiceId) break;

        await prisma.payment.create({
          data: {
            invoiceId,
            amount: fromRappen(intent.amount),
            method: 'CARD',
            status: 'FAILED',
            provider: 'stripe',
            providerPaymentId: intent.id,
            failureReason: intent.last_payment_error?.message ?? 'Zahlung fehlgeschlagen',
          },
        });

        log.warn('Zahlung fehlgeschlagen', { invoiceId });
        break;
      }

      default:
        // Nicht abonnierte Ereignisse bestätigen wir stillschweigend.
        break;
    }

    return Response.json({ received: true });
  } catch (error) {
    // 500 → Stripe wiederholt die Zustellung. Genau das wollen wir.
    log.error('Ereignisverarbeitung fehlgeschlagen', { event: event.type, error });
    return toErrorResponse(error);
  }
}
