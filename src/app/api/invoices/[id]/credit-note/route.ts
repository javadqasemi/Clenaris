import { defineRoute, idParam } from '@/lib/api/handler';
import { created } from '@/lib/api/response';
import { prisma } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';
import { invoiceCreditNoteSchema } from '@/lib/validation/finance';
import { createCreditNote } from '@/server/services/invoice.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/invoices/:id/credit-note — Gutschrift zu dieser Rechnung, eine
 * Zeile, Kundschaft aus der Rechnung. Der Weg, auf den der Storno einer
 * teilweise bezahlten Rechnung verweist.
 */
export const POST = defineRoute({
  permissions: ['creditnote:create'],
  params: idParam,
  body: invoiceCreditNoteSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const organizationId = await getOrganizationId();
    const rechnung = await prisma.invoice.findFirst({
      where: { id: params.id, organizationId, deletedAt: null },
      select: { id: true, customerId: true },
    });
    if (!rechnung) throw new NotFoundError('Rechnung');
    return created(
      await createCreditNote({
        organizationId,
        customerId: rechnung.customerId,
        invoiceId: rechnung.id,
        reason: body.reason,
        items: [{ name: body.name, quantity: body.quantity, unit: 'Stk.', unitPrice: body.unitPrice, vatRate: body.vatRate }],
        actorId: session.id,
      }),
    );
  },
});
