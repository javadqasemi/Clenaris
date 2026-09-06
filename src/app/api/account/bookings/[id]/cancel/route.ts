import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { cancelBookingSchema } from '@/lib/validation/booking';
import { assertBookingOwnership, cancelBooking } from '@/server/services/booking.service';
import { getOrganizationId } from '@/server/services/organization.service';
import { ForbiddenError } from '@/lib/errors';

export const runtime = 'nodejs';

/**
 * POST /api/account/bookings/:id/cancel
 *
 * Storno durch die Kundschaft. Anders als beim Büro-Endpunkt gilt hier die
 * 24-Stunden-Frist (`byStaff` bleibt aus) — sie steht so in den AGB.
 * Die Eigentümerprüfung erfolgt explizit vor der Aktion.
 */
export const POST = defineRoute({
  permissions: ['booking:write_own'],
  params: idParam,
  body: cancelBookingSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    if (!session.profileId) throw new ForbiddenError('Kein Kundenprofil verknüpft.');

    await assertBookingOwnership(params.id, session.profileId);
    const organizationId = await getOrganizationId();

    const booking = await cancelBooking({
      organizationId,
      bookingId: params.id,
      reason: body.reason,
      actorId: session.id,
    });

    return ok({ id: booking.id, status: booking.status });
  },
});
