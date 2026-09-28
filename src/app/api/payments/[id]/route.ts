import { defineRoute, idParam } from '@/lib/api/handler';
import { noContent, ok } from '@/lib/api/response';
import { prisma, toNumber } from '@/lib/db';
import { audit, diff } from '@/lib/audit';
import { NotFoundError } from '@/lib/errors';
import { updatePaymentSchema } from '@/lib/validation/finance';
import { getOrganizationId } from '@/server/services/organization.service';
import { zahlungStornieren } from '@/server/services/invoice.service';

export const runtime = 'nodejs';

/**
 * Zahlungen tragen kein `organizationId` — sie hängen an einer Rechnung oder
 * an einer Kundschaft. Der Mandantenfilter läuft über beide Wege; ohne den
 * zweiten verschwänden Vorauszahlungen ohne Rechnungsbezug stillschweigend.
 */
const scope = (organizationId: string) => ({
  OR: [{ invoice: { organizationId } }, { customer: { organizationId } }],
});

/** PATCH /api/payments/:id — Beleg und Notiz korrigieren. */
export const PATCH = defineRoute({
  permissions: ['payment:create'],
  params: idParam,
  body: updatePaymentSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) => {
    const organizationId = await getOrganizationId();
    const before = await prisma.payment.findFirst({
      where: { id: params.id, ...scope(organizationId) },
    });
    if (!before) throw new NotFoundError('Zahlung');

    /**
     * Der Betrag ist nicht änderbar.
     *
     * Er stammt entweder vom Zahlungsanbieter oder ist beim Verbuchen gegen
     * den offenen Posten der Rechnung gerechnet worden. Ihn nachträglich zu
     * verstellen liesse Rechnungssaldo und Zahlungssumme auseinanderlaufen —
     * und das fiele erst beim Jahresabschluss auf. Ein falscher Betrag wird
     * storniert und neu verbucht.
     */
    const payment = await prisma.payment.update({
      where: { id: params.id },
      data: {
        ...(body.reference !== undefined ? { reference: body.reference || null } : {}),
        ...(body.note !== undefined ? { note: body.note || null } : {}),
        ...(body.paidAt !== undefined ? { paidAt: body.paidAt } : {}),
      },
    });

    await audit.updated({
      organizationId,
      userId: session.id,
      entity: 'Payment',
      entityId: params.id,
      summary: `Zahlung über ${toNumber(payment.amount)} CHF korrigiert`,
      changes: diff(before as Record<string, unknown>, payment as Record<string, unknown>),
      ip,
    });

    return ok({ id: payment.id });
  },
});

/**
 * DELETE /api/payments/:id — fälschlich verbuchte Zahlung stornieren.
 *
 * Nur Zahlungen, die von Hand erfasst wurden. Was über Stripe oder Datatrans
 * hereinkam, ist eine Tatsache beim Zahlungsanbieter; sie hier zu entfernen
 * hiesse, die eigene Buchhaltung gegen den Kontoauszug laufen zu lassen. Eine
 * fehlgeleitete Zahlung des Anbieters wird dort erstattet.
 *
 * **Storno statt Löschen (Wave 13, 2026-09-23).** Bis hierher verschwand die
 * Zeile; der Saldo stimmte danach, aber niemand konnte mehr sehen, dass hier
 * einmal eine Zahlung verbucht war. Jetzt wird sie `CANCELLED` und bleibt —
 * der Saldo zählt ohnehin nur `SUCCEEDED`. Die Datenbank verweigert das
 * Löschen von Zahlungen (Trigger `zahlung_unveraenderlich`). Die Methode
 * bleibt DELETE, weil sich für den Aufrufer nichts ändert: Die Zahlung zählt
 * nicht mehr.
 *
 * Der offene Posten der Rechnung wird in derselben Transaktion zurückgesetzt —
 * sonst bliebe die Rechnung als bezahlt stehen, obwohl kein Geld da ist.
 */
export const DELETE = defineRoute({
  permissions: ['payment:delete'],
  params: idParam,
  rateLimit: 'apiWrite',
  // Regeln (nur Handzahlungen, bedingter Übergang, Kundenwert, Saldo,
  // Protokoll in der Transaktion) in `zahlungStornieren`, invoice.service.ts.
  handler: async ({ params, session, ip }) => {
    await zahlungStornieren({ organizationId: await getOrganizationId(), paymentId: params.id, actorId: session.id, ip });
    return noContent();
  },
});
