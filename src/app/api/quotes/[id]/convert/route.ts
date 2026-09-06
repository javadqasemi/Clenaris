import { defineRoute, idParam } from '@/lib/api/handler';
import { created } from '@/lib/api/response';
import { convertQuoteSchema } from '@/lib/validation/operations';
import { convertQuoteToBooking, convertQuoteToInvoice } from '@/server/services/quote.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/quotes/:id/convert
 *
 * Wandelt eine angenommene Offerte in eine Buchung oder eine Rechnung um.
 * Die Offerte wechselt dabei auf `CONVERTED` und behält die Verknüpfung zum
 * erzeugten Beleg — so bleibt der Weg vom Angebot zum Umsatz nachvollziehbar.
 */
export const POST = defineRoute({
  permissions: ['quote:convert'],
  params: idParam,
  body: convertQuoteSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const organizationId = await getOrganizationId();

    if (body.target === 'BOOKING') {
      const booking = await convertQuoteToBooking({
        organizationId,
        quoteId: params.id,
        scheduledStart: body.scheduledStart!,
        addressId: body.addressId,
        actorId: session.id,
      });
      return created({ id: booking.id, number: booking.number, type: 'booking' });
    }

    const invoice = await convertQuoteToInvoice({
      organizationId,
      quoteId: params.id,
      actorId: session.id,
    });
    return created({ id: invoice.id, number: invoice.number, type: 'invoice' });
  },
});
