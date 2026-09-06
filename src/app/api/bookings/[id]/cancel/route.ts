import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { cancelBookingSchema } from '@/lib/validation/booking';
import { cancelBooking } from '@/server/services/booking.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/bookings/:id/cancel
 *
 * Mitarbeitende dürfen auch innerhalb der 24-Stunden-Frist stornieren
 * (`byStaff`), Kundschaft nicht — die Frist steht in den AGB.
 */
export const POST = defineRoute({
  permissions: ['booking:update'],
  params: idParam,
  body: cancelBookingSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const organizationId = await getOrganizationId();
    const booking = await cancelBooking({
      organizationId,
      bookingId: params.id,
      reason: body.reason,
      actorId: session.id,
      byStaff: true,
    });
    return ok({ id: booking.id, status: booking.status });
  },
});