import 'server-only';

import { audit } from '@/lib/audit';
import { prisma, toNumber, type Tx } from '@/lib/db';
import { quoteAcceptedInternalEmail } from '@/lib/email/templates';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { absoluteUrl } from '@/lib/utils';

import { revokeTokensFor } from './access-token.service';
import { emitAutomationTrigger } from './automation-engine.service';
import { notifyStaff } from './notification.service';
import { appendSignatureEvent, type AnfrageKontext } from './signature-events';

/**
 * Die Geschäftsregeln der Offertannahme — getrennt vom Signaturkern.
 *
 * **Warum ein eigenes Modul.** Der Signaturkern (`signature.service.ts`)
 * weiss, wie ein Vorgang abgeschlossen wird: Hashes, Artefakte, Protokoll.
 * Er weiss nicht, was eine Offerte ist, welche Zustände sie hat und was nach
 * einer Annahme geschieht (Lead gewonnen, Büro benachrichtigen). Das steht
 * hier. Der Kern ruft beim Abschluss eines Vorgangs mit `quoteId` genau eine
 * Funktion dieses Moduls — `acceptQuoteInTx` — in **derselben Transaktion**,
 * in der er den Vorgang auf COMPLETED setzt. Das ist die Kopplung aus
 * Gate 4C:
 *
 *     Offerte ACCEPTED  ⇔  Annahmevorgang COMPLETED
 *
 * Gewinnt eine Ablehnung das Rennen, schlägt der Übergang der Offerte fehl,
 * die Transaktion rollt zurück, und der Kern setzt den Vorgang auf
 * CANCELLED — mit dem Protokoll als Beleg, dass jemand unterschrieben hat,
 * nachdem die Offerte schon abgelehnt war. Kein „COMPLETED ohne Annahme".
 *
 * **Sperrreihenfolge** in jeder Transaktion, die beide Zeilen anfasst:
 * `Quote → SignatureRequest → SignatureParticipant`. Ablehnung, Änderung,
 * Ablauf und Abschluss halten sich daran; sonst könnten sich eine Ablehnung
 * (hält die Offerte, will den Vorgang) und ein Abschluss (hält den Vorgang,
 * will die Offerte) gegenseitig blockieren.
 *
 * `quote.service.ts` importiert dieses Modul und den Kern; dieses Modul
 * importiert keinen von beiden. So gibt es keinen Zyklus.
 */

/** Zustände, aus denen heraus eine Offerte angenommen oder abgelehnt werden kann. */
export const QUOTE_BEANTWORTBAR = ['DRAFT', 'SENT', 'VIEWED'] as const;

/** Offene Annahmevorgänge — genau die, die der Teilindex je Offerte auf einen begrenzt. */
export const ACCEPTANCE_ACTIVE = ['DRAFT', 'PENDING', 'FINALIZING'] as const;

/** Wer geantwortet hat — für das Prüfprotokoll. */
export type AntwortHerkunft =
  /** Über einen Link ohne Anmeldung. */
  | { art: 'LINK'; tokenId?: string }
  /** Angemeldet im Kundenbereich. */
  | { art: 'KUNDENKONTO'; userId: string };

/** Vorgabe: vierzehn Tage — nie länger als die Offerte gilt (§ 37). */
const ACCEPTANCE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Ablauf des Annahmevorgangs: `min(jetzt + 14 Tage, Gültigkeit der Offerte)`.
 *
 * `validUntil` ist ein reines Datum (00:00 UTC). Die bestehende Regel
 * `validUntil < jetzt ⇒ abgelaufen` wird hier nicht neu erfunden, sondern
 * übernommen — ein Vorgang darf nicht länger offen sein als die Offerte.
 */
export function quoteAcceptanceExpiresAt(validUntil: Date, now = new Date()): Date {
  const vorgabe = new Date(now.getTime() + ACCEPTANCE_TTL_MS);
  return validUntil.getTime() < vorgabe.getTime() ? validUntil : vorgabe;
}

/** Ist die Offerte zum Zeitpunkt `now` fachlich annehmbar? Sonst wirft es. */
export function assertQuoteAnnehmbar(quote: { status: string; validUntil: Date; deletedAt: Date | null }, now = new Date()): void {
  if (quote.deletedAt) throw new NotFoundError('Offerte');
  if (!QUOTE_BEANTWORTBAR.includes(quote.status as never)) {
    throw new BusinessRuleError('Diese Offerte wurde bereits beantwortet.');
  }
  if (quote.validUntil.getTime() < now.getTime()) {
    throw new BusinessRuleError('Diese Offerte ist abgelaufen. Wir erstellen Ihnen gerne ein aktualisiertes Angebot.');
  }
}

/**
 * Der atomare Übergang nach ACCEPTED — in der Transaktion des Aufrufers.
 *
 * Die Bedingungen stehen in der `where`-Klausel: Zustand, nicht gelöscht,
 * **noch gültig**. Eine Unterschrift auf einer inzwischen abgelaufenen oder
 * abgelehnten Offerte trifft keine Zeile, und der Aufrufer entscheidet, was
 * das für den Vorgang heisst. Gibt `true` zurück, wenn der Übergang
 * stattgefunden hat.
 */
export async function acceptQuoteInTx(tx: Tx, quoteId: string, now: Date): Promise<boolean> {
  const uebergang = await tx.quote.updateMany({
    where: { id: quoteId, status: { in: [...QUOTE_BEANTWORTBAR] }, deletedAt: null, validUntil: { gte: now } },
    data: { status: 'ACCEPTED', acceptedAt: now },
  });
  return uebergang.count === 1;
}

/**
 * Offene Annahmevorgänge einer Offerte abbrechen — in der Transaktion des
 * Aufrufers, **nach** dem Zugriff auf die Offerte (Sperrreihenfolge).
 *
 * Gründe: Ablehnung, Änderung signaturrelevanter Felder, Ablauf. Der alte
 * Snapshot und das Protokoll bleiben als Beleg; nur die Links und Codes
 * werden entwertet. Gibt die Zahl der abgebrochenen Vorgänge zurück.
 */
export async function cancelActiveQuoteAcceptanceInTx(
  tx: Tx,
  params: { quoteId: string; reason: 'quote_declined' | 'quote_changed' | 'quote_expired' | 'quote_cancelled'; ctx?: AnfrageKontext | null; cancelledById?: string | null },
): Promise<number> {
  const offen = await tx.signatureRequest.findMany({
    where: { quoteId: params.quoteId, status: { in: [...ACCEPTANCE_ACTIVE] } },
    select: { id: true, participants: { select: { id: true } } },
  });
  let abgebrochen = 0;
  for (const request of offen) {
    const u = await tx.signatureRequest.updateMany({
      where: { id: request.id, status: { in: [...ACCEPTANCE_ACTIVE] } },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: params.cancelledById ?? null, finalizingSince: null },
    });
    if (u.count === 0) continue;
    abgebrochen += 1;
    for (const p of request.participants) {
      await revokeTokensFor({ tx, purpose: 'SIGNATURE_ACCESS', resourceId: p.id, revokedById: params.cancelledById ?? null });
      await tx.signatureOtpChallenge.updateMany({
        where: { participantId: p.id, usedAt: null, invalidatedAt: null },
        data: { invalidatedAt: new Date() },
      });
    }
    await appendSignatureEvent(tx, { requestId: request.id, type: 'CANCELLED', ctx: params.ctx, details: { by: 'system', reason: params.reason } });
  }
  return abgebrochen;
}

/**
 * Ablehnen — eine direkte, atomare Zustandsänderung ohne Unterzeichnung.
 *
 * Läuft gerade eine Unterzeichnung, wird sie mitabgebrochen (in derselben
 * Transaktion, nach der Offerte). Gewinnt umgekehrt der Abschluss der
 * Unterzeichnung das Rennen, trifft der Übergang hier keine Zeile: 422.
 */
export async function declineQuoteCore(params: {
  quoteId: string;
  organizationId: string;
  reason?: string;
  herkunft: AntwortHerkunft;
  ctx: AnfrageKontext;
}): Promise<{ id: string; number: string; status: string; rejectedAt: Date | null }> {
  const quote = await prisma.quote.findFirst({
    where: { id: params.quoteId, organizationId: params.organizationId },
    include: { customer: true, lead: true },
  });
  if (!quote || quote.deletedAt) throw new NotFoundError('Offerte');
  if (quote.validUntil.getTime() < Date.now() && !QUOTE_BEANTWORTBAR.includes(quote.status as never)) {
    throw new BusinessRuleError('Diese Offerte wurde bereits beantwortet.');
  }

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const uebergang = await tx.quote.updateMany({
      where: { id: quote.id, status: { in: [...QUOTE_BEANTWORTBAR] }, deletedAt: null },
      data: { status: 'REJECTED', rejectedAt: now, rejectReason: params.reason ?? null },
    });
    if (uebergang.count === 0) throw new BusinessRuleError('Diese Offerte wurde bereits beantwortet.');
    await cancelActiveQuoteAcceptanceInTx(tx, {
      quoteId: quote.id,
      reason: 'quote_declined',
      ctx: params.ctx,
      cancelledById: params.herkunft.art === 'KUNDENKONTO' ? params.herkunft.userId : null,
    });
  });

  if (quote.leadId) {
    await prisma.lead.update({
      where: { id: quote.leadId },
      data: { status: 'LOST', lostReason: params.reason ?? 'Offerte abgelehnt' },
    });
  }

  await notifyStaff({
    organizationId: quote.organizationId,
    title: 'Offerte abgelehnt',
    body: `${quote.number} · ${kundenName(quote)} · CHF ${toNumber(quote.grossTotal).toFixed(2)}`,
    link: `/admin/offerten/${quote.id}`,
    permission: 'quote:read',
  });

  await audit.updated({
    organizationId: quote.organizationId,
    userId: params.herkunft.art === 'KUNDENKONTO' ? params.herkunft.userId : undefined,
    entity: 'Quote',
    entityId: quote.id,
    summary:
      params.herkunft.art === 'KUNDENKONTO'
        ? `Offerte ${quote.number} im Kundenkonto abgelehnt`
        : `Offerte ${quote.number} über den Link abgelehnt`,
    ip: params.ctx.ip,
    userAgent: params.ctx.userAgent,
  });

  return { id: quote.id, number: quote.number, status: 'REJECTED', rejectedAt: now };
}

/**
 * Was nach einer gelungenen Annahme geschieht — ausserhalb der Transaktion,
 * genau einmal, vom Gewinner des Übergangs aufgerufen.
 */
export async function afterQuoteAccepted(params: {
  quoteId: string;
  requestId: string;
  actorSource: 'PUBLIC_LINK' | 'AUTHENTICATED_CUSTOMER' | null;
  ctx?: AnfrageKontext | null;
}): Promise<void> {
  const quote = await prisma.quote.findUnique({
    where: { id: params.quoteId },
    include: { customer: true, lead: true },
  });
  if (!quote) return;

  if (quote.leadId) {
    await prisma.lead.update({ where: { id: quote.leadId }, data: { status: 'WON', convertedAt: new Date() } });
  }

  const customerName = kundenName(quote);
  await notifyStaff({
    organizationId: quote.organizationId,
    title: 'Offerte angenommen',
    body: `${quote.number} · ${customerName} · CHF ${toNumber(quote.grossTotal).toFixed(2)}`,
    link: `/admin/offerten/${quote.id}`,
    permission: 'quote:read',
    emailContent: quoteAcceptedInternalEmail({
      quoteNumber: quote.number,
      customerName,
      grossTotal: toNumber(quote.grossTotal),
      adminUrl: absoluteUrl(`/admin/offerten/${quote.id}`),
    }),
  });

  /**
   * `QUOTE_ACCEPTED` — bis 2026-09-23 in der Oberfläche wählbar und nie
   * gemeldet (RB-012). Hier, vom Gewinner des Übergangs und genau einmal;
   * die Meldung wirft nie und hält die Annahme nicht auf.
   */
  await emitAutomationTrigger({ organizationId: quote.organizationId, trigger: 'QUOTE_ACCEPTED', entityId: quote.id });

  await audit.updated({
    organizationId: quote.organizationId,
    entity: 'Quote',
    entityId: quote.id,
    summary:
      params.actorSource === 'AUTHENTICATED_CUSTOMER'
        ? `Offerte ${quote.number} im Kundenkonto elektronisch angenommen (Vorgang ${params.requestId})`
        : `Offerte ${quote.number} über den Link elektronisch angenommen (Vorgang ${params.requestId})`,
    ip: params.ctx?.ip,
    userAgent: params.ctx?.userAgent,
  });
}

function kundenName(quote: {
  customer: { companyName: string | null; firstName: string; lastName: string } | null;
  lead: { firstName: string; lastName: string } | null;
}): string {
  return (
    quote.customer?.companyName ??
    `${quote.customer?.firstName ?? quote.lead?.firstName ?? ''} ${quote.customer?.lastName ?? quote.lead?.lastName ?? ''}`.trim()
  );
}
