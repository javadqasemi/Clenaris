import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { rescheduleBookingSchema } from '@/lib/validation/booking';
import { rescheduleBooking } from '@/server/services/booking.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** POST /api/bookings/:id/reschedule */
export const POST = defineRoute({
  permissions: ['booking:update'],
  params: idParam,
  body: rescheduleBookingSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const organizationId = await getOrganizationId();
    const booking = await rescheduleBooking({
      organizationId,
      bookingId: params.id,
      newStart: body.scheduledStart,
      actorId: session.id,
      byStaff: true,
    });
    return ok({
      id: booking.id,
      scheduledStart: booking.scheduledStart,
      scheduledEnd: booking.scheduledEnd,
    });
  },
});