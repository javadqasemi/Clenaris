import type Stripe from 'stripe';
import type { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db';
import { toErrorResponse } from '@/lib/api/response';
import { ausRappen } from '@/lib/money';
import { constructWebhookEvent, fromRappen } from '@/lib/payments/stripe';
import { erstattungsstandUebernehmen, recordPayment } from '@/server/services/invoice.service';
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
 *  4. Jede Wirkung ist idempotent: Stripe stellt Ereignisse mehrfach und in
 *     beliebiger Reihenfolge zu. Zahlungen erkennt die eindeutige
 *     `providerPaymentId`, jedes Ereignis der eindeutige Vermerk in
 *     `ProviderWebhookEvent` (in derselben Transaktion wie seine Wirkung),
 *     Erstattungen ihr Anbieterzeitpunkt (`refundSyncedAt`). Bis 2026-09-27
 *     galt das nur für die Zahlung selbst.
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

        // Die Buchung selbst ist über `providerPaymentId` idempotent; der
        // Ereignisvermerk hält die Zustellung nur fest (Nachvollziehbarkeit).
        await ereignisVerbuchen(event, async () => 'uebernommen');

        log.info('Zahlung gebucht', { invoiceId });
        break;
      }

      case 'charge.refunded': {
        const charge = event.data.object as Stripe.Charge;
        const paymentIntentId = String(charge.payment_intent ?? '');
        if (!paymentIntentId) break;

        /*
          `amount_refunded` ist der **kumulierte** Stand der Zahlung, kein
          Zuwachs. Bis 2026-09-27 wurde er bei jedem Ereignis erneut vom
          bezahlten Betrag abgezogen, und der Saldo entstand hier mit eigener
          Rechnung. Jetzt wird der Stand übernommen (mit Anbieterzeitpunkt,
          damit ein verspätetes älteres Ereignis nichts zurückdreht), und den
          Saldo bildet `saldoNeuBilden` — dieselbe Rechnung wie überall.
        */
        const ergebnis = await ereignisVerbuchen(event, (tx) =>
          erstattungsstandUebernehmen(tx, {
            providerPaymentId: paymentIntentId,
            kumuliert: ausRappen(charge.amount_refunded),
            stand: new Date(event.created * 1000),
          }),
        );
        log.info('Rückerstattung verarbeitet', { paymentIntentId, ergebnis });
        break;
      }

      case 'payment_intent.payment_failed': {
        const intent = event.data.object as Stripe.PaymentIntent;
        const invoiceId = intent.metadata?.invoiceId;
        if (!invoiceId) break;
        const organizationId = await getOrganizationId();

        await ereignisVerbuchen(event, async (tx) => {
          const rechnung = await tx.invoice.findFirst({ where: { id: invoiceId, organizationId }, select: { id: true, customerId: true } });
          if (!rechnung) return 'unbekannt';
          await tx.payment.create({
            data: {
              invoiceId: rechnung.id,
              customerId: rechnung.customerId,
              amount: ausRappen(intent.amount),
              method: 'CARD',
              status: 'FAILED',
              provider: 'stripe',
              /*
                **Nicht** in `providerPaymentId`: Diese Spalte ist eindeutig und
                bezeichnet die *gebuchte* Zahlung. Ein fehlgeschlagener
                Versuch trägt dieselbe PaymentIntent-Kennung wie der spätere
                erfolgreiche — stand sie hier, galt die erfolgreiche Zahlung
                als „schon gebucht" und wurde nie verbucht (bis 2026-09-27).
              */
              reference: intent.id,
              failureReason: intent.last_payment_error?.message ?? 'Zahlung fehlgeschlagen',
            },
          });
          return 'uebernommen';
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

/**
 * Ein Ereignis genau einmal wirken lassen (2026-09-27).
 *
 * Vermerk und Wirkung stehen in **einer** Transaktion: Der Vermerk
 * (`ProviderWebhookEvent`, eindeutig je Anbieter und Kennung) entsteht mit
 * `ON CONFLICT DO NOTHING`; trifft er eine vorhandene Zeile, ist das Ereignis
 * schon verarbeitet, und die Wirkung entfällt. Scheitert die Wirkung, rollt
 * der Vermerk mit zurück, und die nächste Zustellung versucht es neu — das
 * ist Stripes Wiederholung, und sie soll wirken können.
 */
async function ereignisVerbuchen(
  event: Stripe.Event,
  wirkung: (tx: Prisma.TransactionClient) => Promise<string>,
): Promise<string> {
  return prisma.$transaction(async (tx) => {
    const neu = await tx.providerWebhookEvent.createMany({
      data: [{ provider: 'stripe', eventId: event.id, type: event.type }],
      skipDuplicates: true,
    });
    if (neu.count === 0) return 'doppelt';
    return wirkung(tx);
  });
}
