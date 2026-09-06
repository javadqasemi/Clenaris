import { defineRoute, idParam } from '@/lib/api/handler';
import { prisma } from '@/lib/db';
import { ForbiddenError, NotFoundError } from '@/lib/errors';
import { renderQuotePdf } from '@/lib/pdf/render';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** GET /api/quotes/:id/pdf — Offerte als PDF, inkl. Unterschrift falls vorhanden. */
export const GET = defineRoute({
  permissions: ['quote:read', 'quote:read_own'],
  anyPermission: true,
  params: idParam,
  rateLimit: 'apiRead',
  handler: async ({ params, session }) => {
    const organizationId = await getOrganizationId();

    const quote = await prisma.quote.findFirst({
      where: { id: params.id, organizationId, deletedAt: null },
      select: { id: true, customerId: true },
    });
    if (!quote) throw new NotFoundError('Offerte');

    if (session.role === 'CUSTOMER' && quote.customerId !== session.profileId) {
      throw new ForbiddenError('Diese Offerte gehört nicht zu Ihrem Konto.');
    }

    const { buffer, filename } = await renderQuotePdf(quote.id);

    return new Response(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  },
});
