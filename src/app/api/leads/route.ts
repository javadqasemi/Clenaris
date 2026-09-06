import { defineRoute } from '@/lib/api/handler';
import { buildPagination, created, paginated } from '@/lib/api/response';
import { createLeadSchema } from '@/lib/validation/crm';
import { leadListQuery } from '@/lib/validation/queries';
import { createLead, listLeads } from '@/server/services/crm.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/leads — Anfragen mit Filter nach Status und Zuständigkeit. */
export const GET = defineRoute({
  permissions: ['lead:read'],
  query: leadListQuery,
  rateLimit: 'apiRead',
  handler: async ({ query }) => {
    const organizationId = await getOrganizationId();

    const { items, total } = await listLeads({
      organizationId,
      status: query.status,
      ownerId: query.ownerId,
      q: query.q,
      page: query.page,
      pageSize: query.pageSize,
    });

    return paginated(items, buildPagination(query.page, query.pageSize, total));
  },
});

/**
 * POST /api/leads — Anfrage von Hand erfassen.
 *
 * Der Weg für Telefonanrufe und Laufkundschaft. Anfragen über das
 * Kontaktformular laufen über `/api/public/contact`, damit sie Honeypot und
 * strengeres Rate-Limiting durchlaufen.
 */
export const POST = defineRoute({
  permissions: ['lead:create'],
  body: createLeadSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session }) => {
    const organizationId = await getOrganizationId();

    const lead = await createLead({
      organizationId,
      input: body,
      actorId: session.id,
    });

    return created({ id: lead.id, number: lead.number });
  },
});
