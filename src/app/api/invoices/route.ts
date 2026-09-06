import { defineRoute } from '@/lib/api/handler';
import { buildPagination, created, ok } from '@/lib/api/response';
import { createInvoiceSchema } from '@/lib/validation/finance';
import { invoiceListQuery } from '@/lib/validation/queries';
import { createInvoice, listInvoices } from '@/server/services/invoice.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/invoices — Rechnungsliste mit Totalen für die Kopfzeile. */
export const GET = defineRoute({
  permissions: ['invoice:read'],
  query: invoiceListQuery,
  rateLimit: 'apiRead',
  handler: async ({ query }) => {
    const organizationId = await getOrganizationId();

    const { items, total, totals } = await listInvoices({
      organizationId,
      status: query.status,
      customerId: query.customerId,
      from: query.from,
      to: query.to,
      q: query.q,
      page: query.page,
      pageSize: query.pageSize,
    });

    // `totals` (offen, überfällig, bezahlt) reist im Meta-Teil mit: die
    // Kopfzeile der Liste braucht sie, und ein zweiter Roundtrip nur für drei
    // Summen wäre Verschwendung.
    return ok(items, {
      meta: { ...buildPagination(query.page, query.pageSize, total), totals },
    });
  },
});

/**
 * POST /api/invoices — Rechnung erstellen.
 *
 * Standardmässig als Entwurf. Erst `issueImmediately` bzw. der separate
 * Ausstellungsschritt vergibt die Rechnungsnummer — eine Nummer, die nie
 * benutzt wird, reisst eine Lücke in die Nummernfolge, und lückenlose
 * Nummerierung verlangt Art. 957a OR.
 */
export const POST = defineRoute({
  permissions: ['invoice:create'],
  body: createInvoiceSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session }) => {
    const organizationId = await getOrganizationId();

    const invoice = await createInvoice({
      organizationId,
      input: body,
      actorId: session.id,
    });

    return created({ id: invoice.id, number: invoice.number, status: invoice.status });
  },
});
