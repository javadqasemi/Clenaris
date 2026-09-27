import { definePublicRoute } from '@/lib/api/handler';
import { created } from '@/lib/api/response';
import { createBookingSchema } from '@/lib/validation/booking';
import { createBooking } from '@/server/services/booking.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/public/bookings
 *
 * Online-Buchung — funktioniert mit und ohne Anmeldung.
 *
 * Der Endpunkt vertraut keiner einzigen Preisangabe aus der Anfrage: der
 * Betrag wird im Service neu berechnet. Der Client schickt nur, *was* gebucht
 * wird, nie *was es kostet*.
 */
export const POST = definePublicRoute({
  body: createBookingSchema,
  rateLimit: 'bookingCreate',
  handler: async ({ body, session, ip }) => {
    const organizationId = await getOrganizationId();

    const { booking, confirmationUrl, isNewCustomer } = await createBooking({
      organizationId,
      input: body,
      session,
      ip,
    });

    return created({
      id: booking.id,
      number: booking.number,
      status: booking.status,
      scheduledStart: booking.scheduledStart,
      scheduledEnd: booking.scheduledEnd,
      grossTotal: booking.grossTotal,
      /*
        Leer statt `null`, wenn der Dienst den Link zurückhält (Gastbuchung
        auf eine bestehende Kundenakte, F-03). Der Buchungsassistent liest
        das letzte Pfadsegment als Token; aus einer leeren Zeichenkette wird
        kein Token, und die Abschlussseite zeigt die knappe Fassung ohne
        Stammdaten („Die Angaben finden Sie in der Bestätigungs-E-Mail").
        `null` liesse den Assistenten nach einer gelungenen Buchung mit einem
        Fehler abbrechen — und die Kundschaft ein zweites Mal buchen.
      */
      confirmationUrl: confirmationUrl ?? '',
      isNewCustomer,
    });
  },
});
