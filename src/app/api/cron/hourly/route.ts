import { defineCronRoute } from '@/lib/api/handler';
import { getOrganizationId } from '@/server/services/organization.service';
import { sendBookingReminders, sendCrewReminders } from '@/server/services/automation.service';

export const runtime = 'nodejs';
export const maxDuration = 120;

/**
 * GET /api/cron/hourly — stündlich (siehe vercel.json).
 *
 * Hier laufen nur zeitkritische Erinnerungen: 24 Stunden vor dem Termin an die
 * Kundschaft, 2 Stunden vorher an Kundschaft und Team. Ein stündlicher Takt
 * genügt, weil die Zeitfenster grosszügig gewählt sind (20–28 bzw. 1–3
 * Stunden) — so fällt keine Erinnerung durch, auch wenn ein Lauf ausfällt.
 */
export const GET = defineCronRoute({
  handler: async () => {
    const organizationId = await getOrganizationId();
    const startedAt = Date.now();

    const [customerReminders, crewReminders] = await Promise.allSettled([
      sendBookingReminders(organizationId),
      sendCrewReminders(organizationId),
    ]);

    return Response.json({
      ok:
        customerReminders.status === 'fulfilled' && crewReminders.status === 'fulfilled',
      durationMs: Date.now() - startedAt,
      customerReminders:
        customerReminders.status === 'fulfilled'
          ? customerReminders.value
          : { error: String(customerReminders.reason) },
      crewReminders:
        crewReminders.status === 'fulfilled'
          ? { sent: crewReminders.value }
          : { error: String(crewReminders.reason) },
    });
  },
});
