import { defineRoute, idParam } from '@/lib/api/handler';
import { prisma } from '@/lib/db';
import { ForbiddenError, NotFoundError } from '@/lib/errors';
import { renderInvoicePdf } from '@/lib/pdf/render';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/invoices/:id/pdf
 *
 * Kundschaft darf nur die eigenen Rechnungen herunterladen. Die Prüfung
 * passiert hier explizit, weil die Berechtigung `invoice:read_own` allein
 * nichts über die Zugehörigkeit des Dokuments aussagt.
 */
export const GET = defineRoute({
  permissions: ['invoice:read', 'invoice:read_own'],
  anyPermission: true,
  params: idParam,
  rateLimit: 'apiRead',
  handler: async ({ params, session }) => {
    const organizationId = await getOrganizationId();

    const invoice = await prisma.invoice.findFirst({
      where: { id: params.id, organizationId, deletedAt: null },
      select: { id: true, customerId: true, status: true },
    });
    if (!invoice) throw new NotFoundError('Rechnung');

    if (session.role === 'CUSTOMER' && invoice.customerId !== session.profileId) {
      throw new ForbiddenError('Diese Rechnung gehört nicht zu Ihrem Konto.');
    }
    if (session.role === 'CUSTOMER' && invoice.status === 'DRAFT') {
      throw new NotFoundError('Rechnung');
    }

    const { buffer, filename } = await renderInvoicePdf(invoice.id);

    return new Response(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  },
});
