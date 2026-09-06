import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { ForbiddenError } from '@/lib/errors';
import { rescheduleBookingSchema } from '@/lib/validation/booking';
import { assertBookingOwnership, rescheduleBooking } from '@/server/services/booking.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/account/bookings/:id/reschedule
 *
 * Umbuchung durch die Kundschaft. Der Service prüft Kapazität und Frist —
 * ist der Wunschtermin belegt, kommt eine sprechende Fehlermeldung zurück,
 * die das Formular direkt anzeigt.
 */
export const POST = defineRoute({
  permissions: ['booking:write_own'],
  params: idParam,
  body: rescheduleBookingSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    if (!session.profileId) throw new ForbiddenError('Kein Kundenprofil verknüpft.');

    await assertBookingOwnership(params.id, session.profileId);
    const organizationId = await getOrganizationId();

    const booking = await rescheduleBooking({
      organizationId,
      bookingId: params.id,
      newStart: body.scheduledStart,
      actorId: session.id,
    });

    return ok({
      id: booking.id,
      scheduledStart: booking.scheduledStart,
      scheduledEnd: booking.scheduledEnd,
    });
  },
});
