import { definePublicRoute } from '@/lib/api/handler';
import { prisma } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';
import { renderQuotePdf } from '@/lib/pdf/render';
import { publicTokenParams } from '@/lib/validation/queries';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/public/quotes/:token/pdf
 *
 * Offerte als PDF über den öffentlichen Link. Der Token ersetzt die
 * Anmeldung; er wird gegen die Datenbank aufgelöst, nicht geraten.
 */
export const GET = definePublicRoute({
  params: publicTokenParams,
  rateLimit: 'apiRead',
  handler: async ({ params }) => {
    const quote = await prisma.quote.findUnique({
      where: { publicToken: params.token },
      select: { id: true, deletedAt: true },
    });
    if (!quote || quote.deletedAt) throw new NotFoundError('Offerte');

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
