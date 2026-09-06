import { definePublicRoute } from '@/lib/api/handler';
import { prisma } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';
import { renderInvoicePdf } from '@/lib/pdf/render';
import { publicTokenParams } from '@/lib/validation/queries';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/public/invoices/:token/pdf
 *
 * Rechnung als PDF inklusive Schweizer QR-Zahlteil. Zugriff über den
 * unerratbaren Token aus der Rechnungs-E-Mail. Entwürfe werden nicht
 * ausgeliefert — sie haben noch keine Nummer.
 */
export const GET = definePublicRoute({
  params: publicTokenParams,
  rateLimit: 'apiRead',
  handler: async ({ params }) => {
    const invoice = await prisma.invoice.findUnique({
      where: { publicToken: params.token },
      select: { id: true, status: true, deletedAt: true },
    });

    if (!invoice || invoice.deletedAt || invoice.status === 'DRAFT') {
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
