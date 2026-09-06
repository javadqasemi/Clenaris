import { z } from 'zod';

import { defineRoute, idParam } from '@/lib/api/handler';
import { noContent, ok } from '@/lib/api/response';
import { prisma, toNumber } from '@/lib/db';
import { audit, diff } from '@/lib/audit';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { getOrganizationId } from '@/server/services/organization.service';

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
  body: z.object({
    reference: z.string().trim().max(120).optional(),
    note: z.string().trim().max(1000).optional(),
    paidAt: z.coerce.date().optional(),
  }),
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
 * Der offene Posten der Rechnung wird in derselben Transaktion zurückgesetzt —
 * sonst bliebe die Rechnung als bezahlt stehen, obwohl kein Geld da ist.
 */
export const DELETE = defineRoute({
  permissions: ['payment:delete'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) => {
    const organizationId = await getOrganizationId();
    const payment = await prisma.payment.findFirst({
      where: { id: params.id, ...scope(organizationId) },
      include: { invoice: { select: { id: true, number: true, grossTotal: true } } },
    });
    if (!payment) throw new NotFoundError('Zahlung');

    if (payment.provider && payment.provider !== 'manual') {
      throw new BusinessRuleError(
        `Diese Zahlung stammt von ${payment.provider} und ist dort eine Tatsache. ` +
          'Eine Erstattung läuft über den Zahlungsanbieter, nicht über das Löschen der Zeile.',
      );
    }

    const amount = toNumber(payment.amount);

    await prisma.$transaction(async (tx) => {
      await tx.payment.delete({ where: { id: params.id } });

      if (payment.invoiceId && payment.status === 'SUCCEEDED') {
        const paid = await tx.payment.aggregate({
          where: { invoiceId: payment.invoiceId, status: 'SUCCEEDED' },
          _sum: { amount: true },
        });
        const gross = toNumber(payment.invoice?.grossTotal ?? 0);
        const balance = Math.round((gross - toNumber(paid._sum.amount)) * 100) / 100;

        await tx.invoice.update({
          where: { id: payment.invoiceId },
          data: {
            balance,
            // Zurück auf „versendet", sobald wieder etwas offen ist.
            status: balance <= 0 ? 'PAID' : balance < gross ? 'PARTIALLY_PAID' : 'SENT',
            paidAt: balance <= 0 ? undefined : null,
          },
        });
      }
    });

    await audit.deleted({
      organizationId,
      userId: session.id,
      entity: 'Payment',
      entityId: params.id,
      summary: payment.invoice
        ? `Zahlung über ${amount} CHF zu Rechnung ${payment.invoice.number} storniert`
        : `Zahlung über ${amount} CHF storniert`,
      ip,
    });

    return noContent();
  },
});
