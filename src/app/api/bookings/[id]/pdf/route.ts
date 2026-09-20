import { binaerAntwort } from '@/lib/api/binary-response';
import { defineRoute, idParam } from '@/lib/api/handler';
import { prisma } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';
import { renderBookingConfirmationPdf } from '@/lib/pdf/render';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/bookings/:id/pdf — Buchungsbestätigung als PDF.
 *
 * Kundschaft erhält nur die eigene Buchung: die Einschränkung steht als
 * `customerId` in der Abfrage, nicht im Handler — eine fremde Buchung wird
 * schlicht nicht gefunden (404), statt gefunden und dann verweigert.
 */
export const GET = defineRoute({
  permissions: ['booking:read', 'booking:read_own'],
  anyPermission: true,
  params: idParam,
  rateLimit: 'apiRead',
  handler: async ({ params, session, request }) => {
    const booking = await prisma.booking.findFirst({
      where: {
        id: params.id,
        organizationId: await getOrganizationId(),
        deletedAt: null,
        ...(session.role === 'CUSTOMER' ? { customerId: session.profileId ?? '' } : {}),
      },
      select: { id: true },
    });
    if (!booking) throw new NotFoundError('Buchung');

    const { buffer, filename } = await renderBookingConfirmationPdf(booking.id);

    return binaerAntwort({
      bytes: buffer,
      mimeType: 'application/pdf',
      filename,
      disposition: 'attachment',
      request,
      cacheControl: 'private, no-store',
    });
  },
});
