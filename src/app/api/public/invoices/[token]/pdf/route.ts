import { definePublicRoute } from '@/lib/api/handler';
import { prisma } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';
import { renderInvoicePdf } from '@/lib/pdf/render';
import { publicTokenParams } from '@/lib/validation/queries';
import { resolveWithLegacy, tokenRejectionError } from '@/server/services/access-token.service';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/public/invoices/:token/pdf
 *
 * Rechnung als PDF inklusive Schweizer QR-Zahlteil. Entwürfe werden nicht
 * ausgeliefert — sie haben noch keine Nummer.
 *
 * Verlangt `INVOICE_VIEW`; der übliche Zahllink (`INVOICE_PAY`) erfüllt das
 * über die Capability-Hierarchie mit. Vorher stand hier die cuid-Spalte als
 * Berechtigung.
 */
export const GET = definePublicRoute({
  params: publicTokenParams,
  // Engeres Kontingent als `apiRead` — siehe `rate-limit.ts`.
  rateLimit: 'publicTokenRead',
  handler: async ({ params }) => {
    const aufgeloest = await resolveWithLegacy({
      raw: params.token,
      purpose: 'INVOICE_VIEW',
      legacyLookup: async (raw) =>
        prisma.invoice.findUnique({
          where: { publicToken: raw },
          select: { id: true, organizationId: true },
        }),
    });
    if (!aufgeloest.ok) throw tokenRejectionError(aufgeloest.reason, 'Rechnung');

    const invoice = await prisma.invoice.findFirst({
      where: { id: aufgeloest.resourceId, organizationId: aufgeloest.organizationId },
      select: { id: true, status: true, deletedAt: true },
    });

    if (!invoice || invoice.deletedAt || invoice.status === 'DRAFT') {
      throw new NotFoundError('Rechnung');
    }

    const { buffer, filename } = await renderInvoicePdf(invoice.id);

    return new Response(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/pdf',
        // `inline`, damit sich das PDF im Fenster öffnen lässt.
        'Content-Disposition': `inline; filename="${filename}"`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
      },
    });
  },
});
