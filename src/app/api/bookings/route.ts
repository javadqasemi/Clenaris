import { defineRoute } from '@/lib/api/handler';
import { buildPagination, paginated } from '@/lib/api/response';
import { searchQuery } from '@/lib/validation/queries';
import { listBookings } from '@/server/services/booking.service';
import { getOrganizationId } from '@/server/services/organization.service';
import { z } from 'zod';

export const runtime = 'nodejs';

const listQuery = searchQuery.extend({
  status: z
    .enum(['PENDING', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW'])
    .optional(),
  customerId: z.string().min(1).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

/**
 * GET /api/bookings — Buchungen mit Filter und Blätterung.
 *
 * Die Kundensicht auf einen Auftrag. Die Betriebssicht steht unter
 * `/api/jobs`: eine Buchung kann mehrere Einsätze erzeugen, und ein Einsatz
 * kann ohne Buchung bestehen.
 */
export const GET = defineRoute({
  permissions: ['booking:read'],
  query: listQuery,
  rateLimit: 'apiRead',
  handler: async ({ query }) => {
    const { items, total } = await listBookings({
      organizationId: await getOrganizationId(),
      status: query.status,
      customerId: query.customerId,
      from: query.from,
      to: query.to,
      q: query.q,
      page: query.page,
      pageSize: query.pageSize,
      sort: query.sort,
      order: query.order,
    });

    return paginated(items, buildPagination(query.page, query.pageSize, total));
  },
});
