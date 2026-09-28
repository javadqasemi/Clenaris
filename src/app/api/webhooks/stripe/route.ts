import type Stripe from 'stripe';

import { toErrorResponse } from '@/lib/api/response';
import { ausRappen } from '@/lib/money';
import { constructWebhookEvent, fromRappen } from '@/lib/payments/stripe';
import { erstattungsstandUebernehmen, recordPayment } from '@/server/services/invoice.service';
import { getOrganizationId } from '@/server/services/organization.service';
import {
  AUSGEFALLENE_RUECKERSTATTUNG,
  EreignisVerfruehtError,
  ereignisVerbuchen,
  fehlgeschlageneZahlungVermerken,
  rueckerstattungsausfallVerbuchen,
  zahlungsabsichtVermerken,
} from '@/server/services/stripe-ereignis.service';
import { logger } from '@/lib/logger';
import { NotFoundError } from '@/lib/errors';
import { ZahlungsbezugError } from '@/server/services/invoice.service';
import { notifyStaff } from '@/server/services/notification.service';

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
 *     `ProviderWebhookEvent` (in derselben Transaktion wie seine Wirkung,
 *     `ereignisVerbuchen` in `stripe-ereignis.service.ts`),
 *     Erstattungen ihr Anbieterzeitpunkt (`refundSyncedAt`), der Ausfall
 *     einer Rückerstattung ein eigener Vermerk je Rückerstattung (er kommt
 *     über bis zu drei Ereignistypen). Bis 2026-09-27 galt das nur für die
 *     Zahlung selbst.
 *  5. Fehler beim Verarbeiten führen zu einem 500 — dann wiederholt Stripe die
 *     Zustellung. Ein 200 auf einen Fehler würde die Zahlung verlieren.
 *  6. Umgekehrt darf ein *dauerhafter* Zustand keine Fehlerantwort erzeugen
 *     (2026-09-27, N-05): Eine Zahlung auf eine inzwischen stornierte
 *     Rechnung wird gebucht und zur Rückzahlung gemeldet (`recordPayment`),
 *     statt mit 422 abgewiesen und von Stripe tagelang erneut zugestellt zu
 *     werden. Zurückgewiesen wird nur, was sich durch Warten erledigt — die
 *     Rückerstattung vor ihrer Zahlung (409, `EreignisVerfruehtError`).
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

        /*
          Falscher Bezug (2026-09-27, Testmatrix `zahlung.falscherBezug`). Eine
          korrekt signierte Session beweist nur, dass Stripe sie geschickt hat
          — nicht, dass sie zu *dieser* Rechnung passt. Zwei Fälle sind
          dauerhaft und werden deshalb nach Regel 6 nicht mit einer
          Fehlerantwort in Stripes Wiederholung geschickt, sondern vermerkt,
          protokolliert, dem Büro gemeldet und mit 200 beantwortet:

           • Die Rechnung gibt es in dieser Organisation nicht (fremde oder
             falsche Kennung in `metadata.invoiceId`) — `recordPayment` sucht
             mit der Organisation im `where` und findet nichts. Vorher: 404,
             drei Tage Wiederholung, danach nichts, und das Büro erfuhr nie,
             dass Geld ohne Rechnung auf dem Stripe-Konto lag.
           • Die Währung weicht ab (`ZahlungsbezugError`) — warum nicht
             gebucht wird, steht in `recordPayment`.

          Der Ereignisvermerk entsteht dabei ohne Wirkung; die Meldung geht nur
          beim ersten Vermerk hinaus, eine erneute Zustellung ist „doppelt".
          Ein abweichender *Betrag* gehört nicht hierher: Er wird gebucht und
          in `recordPayment` markiert.
        */
        try {
          await recordPayment({
            organizationId,
            invoiceId,
            provider: 'stripe',
            providerPaymentId: String(session.payment_intent ?? session.id),
            providerCurrency: session.currency ?? null,
            input: {
              amount: fromRappen(session.amount_total ?? 0),
              method,
              paidAt: new Date(),
              reference: session.id,
              note: `Online bezahlt via ${method === 'TWINT' ? 'TWINT' : 'Karte'}`,
            },
          });
        } catch (error) {
          if (!(error instanceof ZahlungsbezugError) && !(error instanceof NotFoundError)) throw error;
          const grund = error instanceof ZahlungsbezugError ? error.message : 'Zur Rechnungskennung gibt es in dieser Organisation keine Rechnung.';
          const ergebnis = await ereignisVerbuchen(event, async () => 'bezug_abgewiesen');
          if (ergebnis !== 'doppelt') {
            log.error('Stripe-Zahlung passt nicht zu ihrer Rechnung — nicht gebucht, bitte von Hand prüfen', { sessionId: session.id, eventId: event.id, grund });
            await notifyStaff({
              organizationId,
              title: 'Online-Zahlung nicht zugeordnet',
              body: `Stripe meldet eine Zahlung (${(session.currency ?? '').toUpperCase()} ${fromRappen(session.amount_total ?? 0).toFixed(2)}, Session ${session.id}), die nicht gebucht wurde: ${grund} Bitte im Stripe-Dashboard prüfen und gegebenenfalls zurückzahlen.`,
              permission: 'payment:read',
            }).catch((meldefehler) => log.error('Meldung zur nicht zugeordneten Zahlung fehlgeschlagen', { error: meldefehler }));
          }
          break;
        }

        await zahlungsabsichtVermerken({ organizationId, invoiceId, paymentIntentId: String(session.payment_intent ?? '') });

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
        /*
          Kommt die Rückerstattung vor der Zahlung an (Stripe garantiert keine
          Reihenfolge), meldet `erstattungsstandUebernehmen` `'ausstehend'`, und
          `ereignisVerbuchen` weist das Ereignis samt Vermerk zurück (409) —
          Stripe stellt es später erneut zu, dann ist die Zahlung gebucht. Bis
          2026-09-27 blieb der Vermerk stehen und die Erstattung ging verloren.
        */
        const ergebnis = await ereignisVerbuchen(event, (tx) =>
          erstattungsstandUebernehmen(tx, {
            providerPaymentId: paymentIntentId,
            kumuliert: ausRappen(charge.amount_refunded),
            stand: new Date(event.created * 1000),
          }),
        );
        if (ergebnis === 'ausstehend_verfallen') {
          // Tage nach dem Ereignis noch immer keine Zahlung: keine unserer
          // Rechnungen. Nicht mehr zurückweisen, aber sichtbar machen.
          log.error('Rückerstattung ohne gebuchte Zahlung — bitte von Hand prüfen', { paymentIntentId, eventId: event.id });
          break;
        }
        log.info('Rückerstattung verarbeitet', { paymentIntentId, ergebnis });
        break;
      }

      /*
        Eine Rückerstattung scheitert nachträglich oder wird abgebrochen
        (2026-09-27, Rest von F-04). Bis hierher unbehandelt: Der Saldo blieb
        um einen Betrag gesenkt, der nie zurückging.

        Drei Ereignistypen, ein Fall. Die SDK-Typen (stripe 17.7, API
        `2025-02-24.acacia`) kennen `refund.updated` und `refund.failed` als
        die heutigen Ereignisse und `charge.refund.updated` als das ältere,
        das Stripe weiterhin sendet; alle drei tragen dasselbe
        `Stripe.Refund`. Welche davon am Endpunkt abonniert sind, steht in der
        Stripe-Konfiguration, nicht hier — deshalb werden alle drei
        angenommen, und `rueckerstattungsausfallVerbuchen` lässt den Ausfall
        je Rückerstattung nur einmal wirken.

        Das Ereignis trägt nur die *eine* Rückerstattung, nicht den
        kumulierten Stand der Zahlung (`amount_refunded` steht an der Charge,
        die hier nicht mitkommt). Verworfen: die Charge bei Stripe abzufragen —
        das bände den Webhook an einen API-Schlüssel und an Stripes
        Erreichbarkeit, und die Prüfreihe liefe an diesem Weg vorbei. Der neue
        Stand entsteht stattdessen hinter der Zeilensperre aus dem
        gespeicherten (`erstattungsstandUebernehmen`, Variante `ausfall`).

        Jeder andere Status (`pending`, `requires_action`, `succeeded`) ändert
        am Geld nichts, was `charge.refunded` nicht schon meldet — er wird
        bestätigt und nicht vermerkt.
      */
      case 'refund.updated':
      case 'refund.failed':
      case 'charge.refund.updated': {
        const refund = event.data.object as Stripe.Refund;
        const status = refund.status ?? '';
        if (!(AUSGEFALLENE_RUECKERSTATTUNG as readonly string[]).includes(status)) break;
        const paymentIntentId =
          typeof refund.payment_intent === 'string' ? refund.payment_intent : (refund.payment_intent?.id ?? '');
        if (!paymentIntentId) break;

        const ergebnis = await ereignisVerbuchen(event, (tx) =>
          rueckerstattungsausfallVerbuchen(tx, {
            refundId: refund.id,
            providerPaymentId: paymentIntentId,
            betragRappen: refund.amount,
            erstelltAm: new Date(refund.created * 1000),
            stand: new Date(event.created * 1000),
          }),
        );
        if (ergebnis === 'ausstehend_verfallen') {
          log.error('Gescheiterte Rückerstattung ohne gebuchte Zahlung — bitte von Hand prüfen', { paymentIntentId, eventId: event.id });
          break;
        }
        log.warn('Rückerstattung bei Stripe gescheitert — Saldo wiederhergestellt', { paymentIntentId, status, ergebnis });
        break;
      }

      case 'payment_intent.payment_failed': {
        const intent = event.data.object as Stripe.PaymentIntent;
        const invoiceId = intent.metadata?.invoiceId;
        if (!invoiceId) break;
        const organizationId = await getOrganizationId();

        // Die Kennung steht als `reference`, **nicht** in `providerPaymentId` —
        // warum, steht bei `fehlgeschlageneZahlungVermerken`.
        await ereignisVerbuchen(event, (tx) =>
          fehlgeschlageneZahlungVermerken(tx, {
            organizationId,
            invoiceId,
            betragRappen: intent.amount,
            paymentIntentId: intent.id,
            fehlermeldung: intent.last_payment_error?.message ?? null,
          }),
        );

        log.warn('Zahlung fehlgeschlagen', { invoiceId });
        break;
      }

      default:
        // Nicht abonnierte Ereignisse bestätigen wir stillschweigend.
        break;
    }

    return Response.json({ received: true });
  } catch (error) {
    // Ein verfrühtes Ereignis ist erwartete Reihenfolge, kein Fehler — es
    // bekommt 409 und eine Warnung statt eines Fehlerprotokolls.
    if (error instanceof EreignisVerfruehtError) {
      log.warn('Ereignis vor seiner Zahlung — Stripe stellt erneut zu', { event: event.type, eventId: event.id });
      return toErrorResponse(error);
    }
    // 500 → Stripe wiederholt die Zustellung. Genau das wollen wir.
    log.error('Ereignisverarbeitung fehlgeschlagen', { event: event.type, error });
    return toErrorResponse(error);
  }
}
