import { defineRoute } from '@/lib/api/handler';
import { buildPagination, paginated } from '@/lib/api/response';
import { prisma, toNumber, type Prisma } from '@/lib/db';
import { paymentListQuery } from '@/lib/validation/queries';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * GET /api/payments — Zahlungseingänge.
 *
 * Zahlungen hängen an Rechnungen und tragen selbst kein `organizationId`; der
 * Mandantenfilter läuft deshalb über die Rechnung. Zahlungen ohne Rechnung
 * (Vorauszahlungen) sind über `customerId` zugeordnet — beide Wege sind
 * abgedeckt, sonst verschwänden Vorauszahlungen still aus der Liste.
 *
 * Sortiert nach Erfassung, nicht nach Zahlungsdatum: erfasst wird auch, was
 * noch nicht bezahlt ist.
 */
export const GET = defineRoute({
  permissions: ['payment:read'],
  query: paymentListQuery,
  rateLimit: 'apiRead',
  handler: async ({ query }) => {
    const organizationId = await getOrganizationId();

    /*
      Mandant und Suche als zwei Glieder eines `AND` (2026-09-27). Vorher
      standen beide als `OR` im selben Objekt, und das zweite überschrieb das
      erste: Mit einem Suchbegriff fiel die Organisationsbedingung weg, die
      Liste zeigte die Zahlungen jeder Organisation und summierte sie in
      „erhalten" und „erstattet". Ein Schlüssel, der in einem Objekt doppelt
      vorkommt, gewinnt still — deshalb hier keine Verbreitung mehr, die ein
      `OR` tragen kann.
    */
    const where: Prisma.PaymentWhereInput = {
      AND: [
        { OR: [{ invoice: { organizationId } }, { customer: { organizationId } }] },
        ...(query.q
          ? [
              {
                OR: [
                  { reference: { contains: query.q, mode: 'insensitive' as const } },
                  { invoice: { number: { contains: query.q, mode: 'insensitive' as const } } },
                ],
              },
            ]
          : []),
      ],
      ...(query.status ? { status: query.status } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lte: query.to } : {}),
            },
          }
        : {}),
    };

    const [items, total, sums] = await Promise.all([
      prisma.payment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          invoice: { select: { id: true, number: true, billToName: true } },
          customer: { select: { id: true, firstName: true, lastName: true, companyName: true } },
        },
      }),
      prisma.payment.count({ where }),
      prisma.payment.aggregate({ where, _sum: { amount: true, refundedAmount: true } }),
    ]);

    return paginated(items, {
      ...buildPagination(query.page, query.pageSize, total),
      received: toNumber(sums._sum.amount),
      refunded: toNumber(sums._sum.refundedAmount),
    } as never);
  },
});
