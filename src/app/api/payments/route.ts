import { z } from 'zod';

import { defineRoute } from '@/lib/api/handler';
import { buildPagination, paginated } from '@/lib/api/response';
import { prisma, toNumber } from '@/lib/db';
import { paginationQuery } from '@/lib/validation/queries';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

const listQuery = paginationQuery.extend({
  status: z.enum(['PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'REFUNDED', 'CANCELLED']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  q: z.string().trim().max(120).optional(),
});

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
  query: listQuery,
  rateLimit: 'apiRead',
  handler: async ({ query }) => {
    const organizationId = await getOrganizationId();

    const where = {
      OR: [{ invoice: { organizationId } }, { customer: { organizationId } }],
      ...(query.status ? { status: query.status } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lte: query.to } : {}),
            },
          }
        : {}),
      ...(query.q
        ? {
            OR: [
              { reference: { contains: query.q, mode: 'insensitive' as const } },
              { invoice: { number: { contains: query.q, mode: 'insensitive' as const } } },
            ],
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
