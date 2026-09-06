import { defineRoute, searchQuery } from '@/lib/api/handler';
import { buildPagination, created, paginated } from '@/lib/api/response';
import { createQuoteSchema } from '@/lib/validation/operations';
import { createQuote, listQuotes } from '@/server/services/quote.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/quotes — Offertenliste mit Suche und Blätterung. */
export const GET = defineRoute({
  permissions: ['quote:read'],
  query: searchQuery,
  rateLimit: 'apiRead',
  handler: async ({ query }) => {
    const organizationId = await getOrganizationId();

    const { items, total } = await listQuotes({
      organizationId,
      page: query.page,
      pageSize: query.pageSize,
      q: query.q,
    });

    return paginated(items, buildPagination(query.page, query.pageSize, total));
  },
});

/** POST /api/quotes — neue Offerte anlegen. */
export const POST = defineRoute({
  permissions: ['quote:create'],
  body: createQuoteSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session }) => {
    const organizationId = await getOrganizationId();

    const quote = await createQuote({ organizationId, input: body, actorId: session.id });

    return created({ id: quote.id, number: quote.number, status: quote.status });
  },
});
