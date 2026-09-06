import { defineRoute } from '@/lib/api/handler';
import { buildPagination, paginated } from '@/lib/api/response';
import { newsletterListQuery } from '@/lib/validation/operations-admin';
import { listNewsletterSubscribers } from '@/server/services/operations-admin.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * GET /api/newsletter — Abonnentinnen und Abonnenten.
 *
 * Ausgetragene erscheinen nicht: sie haben widersprochen, und eine Liste, aus
 * der man sie versehentlich wieder anschreibt, ist genau der Fehler, den das
 * Austragen verhindern soll.
 */
export const GET = defineRoute({
  permissions: ['newsletter:read'],
  query: newsletterListQuery,
  rateLimit: 'apiRead',
  handler: async ({ query }) => {
    const { items, total, confirmedCount } = await listNewsletterSubscribers({
      organizationId: await getOrganizationId(),
      q: query.q,
      confirmed: query.confirmed === undefined ? undefined : query.confirmed === '1',
      page: query.page,
      pageSize: query.pageSize,
    });

    // Die Zahl der bestätigten Adressen gehört in die Antwort: sie ist die
    // Grösse, die zählt — unbestätigte darf man nicht anschreiben.
    return paginated(items, {
      ...buildPagination(query.page, query.pageSize, total),
      confirmed: confirmedCount,
    } as never);
  },
});
