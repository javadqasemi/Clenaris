import 'server-only';

import type { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db';
import { ausRappen } from '@/lib/money';

/**
 * Stripe-Ereignisse verbuchen.
 *
 * Vorher im Endpunkt `/api/webhooks/stripe` geschrieben (bis 2026-09-27) —
 * sowohl der Ereignisvermerk (`ProviderWebhookEvent`) als auch die
 * fehlgeschlagene Zahlung. Die Regel „genau einmal wirken" ist aber keine
 * HTTP-Frage, sondern eine Buchungsregel: Wer ein Ereignis später aus einem
 * Skript nachverarbeitet (etwa nach einem Ausfall über die Stripe-Liste der
 * Ereignisse), muss denselben Vermerk in derselben Transaktion setzen, sonst
 * wirkt das Ereignis doppelt. Im Endpunkt fand er ihn nicht.
 *
 * Der Endpunkt behält, was HTTP ist: Signaturprüfung, Rohtext des Bodys, die
 * Verzweigung nach Ereignistyp und die Antwort (200 bzw. 500 für Stripes
 * Wiederholung). Die Stripe-Typen bleiben dort; dieser Dienst braucht vom
 * Ereignis nur Kennung und Typ.
 */

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
export async function ereignisVerbuchen(
  event: { id: string; type: string },
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

/**
 * Die Zahlungsabsicht von Stripe an der Rechnung vermerken — für Rückfragen
 * und Erstattungen, die über diese Kennung zugeordnet werden.
 *
 * Bis 2026-09-27 stand das als `prisma.invoice.update({ where: { id } })` im
 * Endpunkt: an der Dienstschicht vorbei und ohne Mandantenbedingung. Die
 * Rechnungskennung stammt aus den Metadaten, die wir selbst an Stripe gegeben
 * haben, und kommt signiert zurück — trotzdem gilt hier dieselbe Regel wie
 * überall: Die Organisation steht im `where`, ein fremder Datensatz wird
 * schlicht nicht gefunden.
 */
export async function zahlungsabsichtVermerken(params: { organizationId: string; invoiceId: string; paymentIntentId: string }) {
  await prisma.invoice.updateMany({
    where: { id: params.invoiceId, organizationId: params.organizationId },
    data: { stripePaymentIntentId: params.paymentIntentId },
  });
}

/**
 * Einen fehlgeschlagenen Zahlungsversuch an der Rechnung vermerken.
 *
 * Läuft als Wirkung von `ereignisVerbuchen`, also in dessen Transaktion — der
 * Vermerk des Ereignisses und die Zahlungszeile entstehen gemeinsam oder gar
 * nicht. Die Rechnung wird mit der Organisation in der `where`-Klausel
 * gesucht; eine fremde oder unbekannte Rechnung ergibt `'unbekannt'` und
 * schreibt nichts.
 */
export async function fehlgeschlageneZahlungVermerken(
  tx: Prisma.TransactionClient,
  params: {
    organizationId: string;
    invoiceId: string;
    betragRappen: number;
    paymentIntentId: string;
    fehlermeldung: string | null;
  },
): Promise<'uebernommen' | 'unbekannt'> {
  const rechnung = await tx.invoice.findFirst({ where: { id: params.invoiceId, organizationId: params.organizationId }, select: { id: true, customerId: true } });
  if (!rechnung) return 'unbekannt';
  await tx.payment.create({
    data: {
      invoiceId: rechnung.id,
      customerId: rechnung.customerId,
      amount: ausRappen(params.betragRappen),
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
      reference: params.paymentIntentId,
      failureReason: params.fehlermeldung ?? 'Zahlung fehlgeschlagen',
    },
  });
  return 'uebernommen';
}
