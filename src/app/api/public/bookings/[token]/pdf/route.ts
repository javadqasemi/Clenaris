import { binaerAntwort } from '@/lib/api/binary-response';
import { definePublicRoute } from '@/lib/api/handler';
import { prisma } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';
import { renderBookingConfirmationPdf } from '@/lib/pdf/render';
import { publicTokenParams } from '@/lib/validation/queries';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/public/bookings/:token/pdf
 *
 * Buchungsbestätigung als PDF über den Verwaltungslink aus der E-Mail.
 * Der Token ersetzt die Anmeldung — Gastbuchungen haben kein Konto, und der
 * Ausdruck nach dem Abschluss darf nicht an einer Registrierung scheitern.
 * Aufgelöst wird der Token gegen die Datenbank; erraten lässt er sich nicht.
 */
export const GET = definePublicRoute({
  params: publicTokenParams,
  // Engeres Kontingent als `apiRead` — siehe `rate-limit.ts`.
  rateLimit: 'publicTokenRead',
  handler: async ({ params, request }) => {
    const booking = await prisma.booking.findUnique({
      where: { confirmationToken: params.token },
      select: { id: true, deletedAt: true },
    });
    if (!booking || booking.deletedAt) throw new NotFoundError('Buchung');

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
