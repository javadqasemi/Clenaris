import { binaerAntwort } from '@/lib/api/binary-response';
import { definePublicRoute } from '@/lib/api/handler';
import { renderBookingConfirmationPdf } from '@/lib/pdf/render';
import { absoluteUrl } from '@/lib/utils';
import { publicTokenParams } from '@/lib/validation/queries';
import { getBookingByToken } from '@/server/services/booking.service';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/public/bookings/:token/pdf
 *
 * Buchungsbestätigung als PDF über den Verwaltungslink aus der E-Mail.
 * Der Token ersetzt die Anmeldung — Gastbuchungen haben kein Konto, und der
 * Ausdruck nach dem Abschluss darf nicht an einer Registrierung scheitern.
 *
 * Aufgelöst wird über denselben Weg wie die Verwaltungsseite
 * (`getBookingByToken` → `resolvePublicToken`): Hash, Zweck, Ablauf und
 * Widerruf. Bis 2026-09-27 suchte die Route direkt in der Klartextspalte
 * `confirmationToken` und kannte deshalb weder Ablauf noch Widerruf.
 */
export const GET = definePublicRoute({
  params: publicTokenParams,
  // Engeres Kontingent als `apiRead` — siehe `rate-limit.ts`.
  rateLimit: 'publicTokenRead',
  handler: async ({ params, request }) => {
    const booking = await getBookingByToken(params.token);

    // Der vorgelegte Link gehört ins Dokument — ein neuer entstünde nur, um
    // ausgedruckt zu werden, und stünde als zusätzlicher Zugang im Protokoll.
    const { buffer, filename } = await renderBookingConfirmationPdf(booking.id, {
      manageUrl: absoluteUrl(`/buchung/${params.token}`),
    });

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
