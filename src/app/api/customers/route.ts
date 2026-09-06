import { defineRoute } from '@/lib/api/handler';
import { buildPagination, created, paginated } from '@/lib/api/response';
import { createCustomerSchema } from '@/lib/validation/crm';
import { customerListQuery } from '@/lib/validation/queries';
import { createCustomer, listCustomers } from '@/server/services/crm.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/customers — Kundenliste mit Suche und Blätterung. */
export const GET = defineRoute({
  permissions: ['customer:read'],
  query: customerListQuery,
  rateLimit: 'apiRead',
  handler: async ({ query }) => {
    const organizationId = await getOrganizationId();

    const { items, total } = await listCustomers({
      organizationId,
      q: query.q,
      type: query.type,
      page: query.page,
      pageSize: query.pageSize,
      sort: query.sort,
      order: query.order,
    });

    return paginated(items, buildPagination(query.page, query.pageSize, total));
  },
});

/**
 * POST /api/customers — Kundendatensatz anlegen.
 *
 * Die Doppelprüfung auf die E-Mail-Adresse liegt im Service, nicht hier: sie
 * gehört zur Geschäftsregel, nicht zum Transport. Ein doppelter Datensatz
 * kostet später Stunden bei der Zusammenführung von Rechnungen.
 */
export const POST = defineRoute({
  permissions: ['customer:create'],
  body: createCustomerSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session }) => {
    const organizationId = await getOrganizationId();

    const customer = await createCustomer({
      organizationId,
      input: body,
      actorId: session.id,
    });

    return created({ id: customer.id, number: customer.number });
  },
});
