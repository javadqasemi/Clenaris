import { defineCronRoute } from '@/lib/api/handler';
import { cleanupExpiredTokens } from '@/server/services/auth.service';
import { generateRecurringBookings } from '@/server/services/booking.service';
import { processOverdueInvoices } from '@/server/services/invoice.service';
import { processExpiringQuotes } from '@/server/services/quote.service';
import { getOrganizationId } from '@/server/services/organization.service';
import {
  createFollowUpTasks,
  requestReviews,
  sendBirthdayGreetings,
  sendTaskReminders,
} from '@/server/services/automation.service';
import { logger } from '@/lib/logger';

const log = logger('cron/daily');

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * GET /api/cron/daily — einmal täglich um 06:00 Uhr (siehe vercel.json).
 *
 * Architekturentscheid: Ein Endpunkt für alle Tagesaufgaben statt sechs
 * einzelner Cron-Einträge. Die Aufgaben sind kurz, laufen sequenziell und
 * teilen sich denselben Kontext; ein einziger Lauf ist einfacher zu
 * überwachen und günstiger.
 *
 * Jede Teilaufgabe ist gekapselt: schlägt eine fehl, laufen die übrigen
 * trotzdem. Das Ergebnis meldet, was gelungen ist und was nicht.
 */
export const GET = defineCronRoute({
  handler: async () => {
    const organizationId = await getOrganizationId();
    const startedAt = Date.now();

    const results = await Promise.allSettled([
      generateRecurringBookings(organizationId),
      processOverdueInvoices(organizationId),
      processExpiringQuotes(organizationId),
      requestReviews(organizationId),
      sendBirthdayGreetings(organizationId),
      createFollowUpTasks(organizationId),
      sendTaskReminders(),
      cleanupExpiredTokens(),
    ]);

    const labels = [
      'recurringBookings',
      'overdueInvoices',
      'expiringQuotes',
      'reviewRequests',
      'birthdays',
      'followUpTasks',
      'taskReminders',
      'tokenCleanup',
    ];

    const summary: Record<string, unknown> = {};
    const failures: string[] = [];

    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        summary[labels[index]] = result.value;
      } else {
        failures.push(labels[index]);
        summary[labels[index]] = { error: String(result.reason) };
        log.error('Teilaufgabe fehlgeschlagen', { task: labels[index], error: result.reason });
      }
    });

    log.info('Lauf abgeschlossen', {
      durationMs: Date.now() - startedAt,
      failures: failures.length,
    });

    return Response.json({
      ok: failures.length === 0,
      durationMs: Date.now() - startedAt,
      failures,
      summary,
    });
  },
});
