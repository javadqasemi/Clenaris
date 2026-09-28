import { defineRoute } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { createCreditNoteSchema, creditNoteQuerySchema } from '@/lib/validation/finance';
import { createCreditNote, listCreditNotes } from '@/server/services/invoice.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/credit-notes — Gutschriften, optional je Kundschaft oder Rechnung. */
export const GET = defineRoute({
  permissions: ['creditnote:read'],
  query: creditNoteQuerySchema,
  rateLimit: 'apiRead',
  handler: async ({ query }) =>
    ok(await listCreditNotes({ organizationId: await getOrganizationId(), customerId: query.customerId, invoiceId: query.invoiceId })),
});

/**
 * POST /api/credit-notes — eine Gutschrift ausstellen (mehrere Positionen).
 *
 * Nummer aus dem lückenlosen Nummernkreis in derselben Transaktion; mit
 * Bezugsrechnung: gleiche Kundschaft, ausgestellt und nicht storniert, und
 * über alle Gutschriften nie mehr als der Rechnungsbetrag (422). Danach
 * unveränderlich (Trigger `gutschrift_unveraenderlich`).
 */
export const POST = defineRoute({
  permissions: ['creditnote:create'],
  body: createCreditNoteSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session }) =>
    created(
      await createCreditNote({
        organizationId: await getOrganizationId(),
        customerId: body.customerId,
        invoiceId: body.invoiceId,
        reason: body.reason,
        issueDate: body.issueDate ? new Date(`${body.issueDate}T00:00:00Z`) : undefined,
        items: body.items,
        actorId: session.id,
      }),
    ),
});
