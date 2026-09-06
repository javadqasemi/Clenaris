import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { confirmBooking } from '@/server/services/booking.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** POST /api/bookings/:id/confirm — Buchung bestätigen und Einsatz erzeugen. */
export const POST = defineRoute({
  permissions: ['booking:update'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session }) => {
    const organizationId = await getOrganizationId();
    const booking = await confirmBooking({
      organizationId,
      bookingId: params.id,
      actorId: session.id,
    });
    return ok({ id: booking.id, status: booking.status });
  },
});