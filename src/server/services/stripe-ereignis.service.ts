import 'server-only';

import type { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db';
import { ConflictError } from '@/lib/errors';
import { ausRappen } from '@/lib/money';
import { erstattungsstandUebernehmen } from './invoice.service';

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
 *
 * **„Noch nicht anwendbar" ist kein „verarbeitet"** (2026-09-27, Befund F-04).
 * Meldet die Wirkung `'ausstehend'` — ihr Gegenstand existiert bei uns noch
 * nicht, etwa die Rückerstattung einer Zahlung, deren
 * `checkout.session.completed` erst unterwegs ist —, dann darf der Vermerk
 * nicht stehen bleiben. Bis dahin wurde er trotzdem festgeschrieben: Stripe
 * wiederholte die Rückerstattung, der Vermerk meldete „doppelt", und die
 * Erstattung ging für immer verloren, obwohl die Zahlung Sekunden später
 * gebucht war. Jetzt wirft `ereignisVerbuchen` `EreignisVerfruehtError`, die
 * Transaktion rollt samt Vermerk zurück, der Endpunkt antwortet 409, und
 * Stripe stellt später erneut zu — dann liegt die Zahlung vor.
 *
 * Verworfen wurde, das Ereignis als „ausstehend" zu speichern und beim
 * Eintreffen der Zahlung nachzuholen: Dafür fehlt eine Tabelle (oder eine
 * Platzhalterzahlung, die `providerPaymentId` belegte und die spätere echte
 * Buchung als „schon gebucht" verschluckte — genau der Fehler, den
 * `fehlgeschlageneZahlungVermerken` unten beschreibt). Stripes Wiederholung
 * ist der Nachholmechanismus, den es schon gibt; sie läuft mit wachsendem
 * Abstand bis zu drei Tage.
 *
 * Die Grenze: Ein Ereignis, das älter als `VERFRUEHT_FRIST_MS` ist, wird nicht
 * mehr zurückgewiesen, sondern als `'ausstehend_verfallen'` festgeschrieben.
 * Dann ist die Zahlung auch nach Tagen nicht da — sie gehört nicht zu einer
 * unserer Rechnungen (etwa eine im Stripe-Dashboard von Hand ausgelöste
 * Belastung) —, und eine endlose Zurückweisung liesse nur den Endpunkt bei
 * Stripe als gestört erscheinen. Der Endpunkt protokolliert diesen Fall als
 * Fehler zur Prüfung von Hand.
 */
export async function ereignisVerbuchen(
  event: { id: string; type: string; created?: number },
  wirkung: (tx: Prisma.TransactionClient) => Promise<string>,
): Promise<string> {
  return prisma.$transaction(async (tx) => {
    const neu = await tx.providerWebhookEvent.createMany({
      data: [{ provider: 'stripe', eventId: event.id, type: event.type }],
      skipDuplicates: true,
    });
    if (neu.count === 0) return 'doppelt';
    const ergebnis = await wirkung(tx);
    if (ergebnis !== 'ausstehend') return ergebnis;
    const alterMs = event.created === undefined ? 0 : Date.now() - event.created * 1000;
    if (alterMs > VERFRUEHT_FRIST_MS) return 'ausstehend_verfallen';
    // Werfen, nicht zurückgeben: Nur so rollt der Vermerk mit zurück.
    throw new EreignisVerfruehtError(event.type);
  });
}

/**
 * Wie lange ein Ereignis ohne seinen Gegenstand zurückgewiesen wird — so
 * lange, wie Stripe im Livebetrieb überhaupt wiederholt (drei Tage).
 */
export const VERFRUEHT_FRIST_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Das Ereignis kam vor dem, worauf es sich bezieht — später erneut zustellen.
 *
 * 409 statt 500: Nichts ist kaputt, der Zustand passt nur noch nicht. Stripe
 * wiederholt bei jeder Antwort ausserhalb von 2xx; der Code sagt im Log und
 * im Stripe-Dashboard, dass es sich um Reihenfolge handelt und nicht um einen
 * Serverfehler.
 */
export class EreignisVerfruehtError extends ConflictError {
  constructor(typ: string) {
    super(`Ereignis ${typ} kam vor der zugehörigen Zahlung an und wird bei der nächsten Zustellung verbucht.`);
    this.name = 'EreignisVerfruehtError';
  }
}

/**
 * Stripe-Zustände einer Rückerstattung, in denen ihr Geld **nicht** (mehr)
 * zurückgeht: `failed` (etwa eine geschlossene Karte, Tage nach der
 * Auslösung) und `canceled` (abgebrochen, solange sie noch ausstand). Beide
 * sind endgültig — eine Rückerstattung scheitert höchstens einmal.
 */
export const AUSGEFALLENE_RUECKERSTATTUNG = ['failed', 'canceled'] as const;

/** Präfix des Vermerks „Ausfall dieser Rückerstattung verbucht" in `ProviderWebhookEvent`. */
export const AUSFALL_VERMERK = 'rueckerstattung_ausgefallen:';

/**
 * Eine bei Stripe gescheiterte oder abgebrochene Rückerstattung verbuchen
 * (2026-09-27, Rest von F-04) — der kumulierte Erstattungsstand der Zahlung
 * sinkt um ihren Betrag, und der Saldo der Rechnung steigt wieder.
 *
 * Läuft als Wirkung von `ereignisVerbuchen`; die Rechnung selbst macht
 * `erstattungsstandUebernehmen` (Zeilensperre, Anbieterzeitpunkt,
 * `saldoNeuBilden`, Kundenwert) — derselbe Weg wie `charge.refunded`, damit
 * es auch hier nur *einen* Erstattungsstand gibt.
 *
 * **Warum ein zweiter Vermerk, je Rückerstattung.** Der Ereignisvermerk von
 * `ereignisVerbuchen` hält *eine Zustellung* fest. Denselben Ausfall meldet
 * Stripe aber mit bis zu drei verschiedenen Ereignissen — `refund.updated`,
 * `refund.failed` und das ältere `charge.refund.updated` —, je nachdem,
 * welche am Endpunkt abonniert sind, und jedes mit eigener Kennung. Weil der
 * Ausfall den Stand *um einen Betrag* senkt und nicht auf einen Stand setzt,
 * zöge jedes davon ihn erneut ab. Der Vermerk `rueckerstattung_ausgefallen:
 * <Rückerstattung>` in derselben Tabelle ist eindeutig wie jeder andere
 * (`provider` + `eventId`) und entsteht in derselben Transaktion: Der Ausfall
 * einer Rückerstattung wirkt genau einmal, gleich über welches Ereignis und
 * wie oft zugestellt. Verworfen: nur eines der drei Ereignisse zu behandeln —
 * welches abonniert ist, entscheidet die Stripe-Konfiguration, nicht der
 * Code, und ein nicht abonniertes Ereignis liesse den Ausfall unbemerkt.
 *
 * Der Vermerk entsteht **nach** der Prüfung, ob die Zahlung existiert: Meldet
 * `erstattungsstandUebernehmen` `'ausstehend'`, wirft `ereignisVerbuchen` und
 * rollt beide Vermerke zurück — Stripes Wiederholung findet später die
 * Zahlung und verbucht den Ausfall dann.
 */
export async function rueckerstattungsausfallVerbuchen(
  tx: Prisma.TransactionClient,
  params: { refundId: string; providerPaymentId: string; betragRappen: number; erstelltAm: Date; stand: Date },
): Promise<string> {
  const zahlung = await tx.payment.findUnique({ where: { providerPaymentId: params.providerPaymentId }, select: { id: true } });
  if (!zahlung) return 'ausstehend';

  const neu = await tx.providerWebhookEvent.createMany({
    data: [{ provider: 'stripe', eventId: `${AUSFALL_VERMERK}${params.refundId}`, type: 'refund.ausgefallen' }],
    skipDuplicates: true,
  });
  if (neu.count === 0) return 'doppelt';

  return erstattungsstandUebernehmen(tx, {
    providerPaymentId: params.providerPaymentId,
    ausfall: { betrag: ausRappen(params.betragRappen), erstelltAm: params.erstelltAm },
    stand: params.stand,
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
 *
 * **Warum `'unbekannt'` hier endgültig ist und bei der Rückerstattung nicht**
 * (2026-09-27, geprüft mit F-04). Die Rechnungskennung stammt aus den
 * Metadaten, die wir beim Anlegen der Checkout-Session selbst mitgeben — die
 * Rechnung existiert also, bevor es überhaupt einen Zahlungsversuch geben
 * kann. Fehlt sie trotzdem, gehört der Versuch nicht zu dieser Organisation
 * oder die Kennung ist falsch; Warten ändert daran nichts. Und es ist kein
 * Geld geflossen: Der Vermerk ist Auskunft für das Büro, keine Buchung. Die
 * Rückerstattung dagegen bezieht sich auf eine *Zahlung*, die erst mit einem
 * eigenen Ereignis entsteht und deshalb tatsächlich später eintreffen kann.
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
