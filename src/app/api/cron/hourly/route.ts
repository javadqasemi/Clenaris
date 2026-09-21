import { defineCronRoute } from '@/lib/api/handler';
import { getOrganizationId } from '@/server/services/organization.service';
import { sendBookingReminders, sendCrewReminders } from '@/server/services/automation.service';
import { runDueAutomations } from '@/server/services/automation-engine.service';

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

    const [customerReminders, crewReminders, automatisierungen] = await Promise.allSettled([
      sendBookingReminders(organizationId),
      sendCrewReminders(organizationId),
      /**
       * Die fälligen Automatisierungen.
       *
       * **Stündlich und nicht minütlich**, weil `delayMinutes` in Minuten
       * gerechnet wird und eine Regel mit „nach 5 Minuten" damit bis zu einer
       * Stunde wartet. Das ist die bewusste Grenze dieser Bauart: Sie kommt
       * ohne eigenen Arbeitsprozess und ohne Warteschlangendienst aus, und
       * der Preis ist die Genauigkeit. Für „Erinnerung 24 Stunden vorher"
       * und „Nachfassen in drei Tagen" — also für das, wofür Regeln in einem
       * Reinigungsbetrieb da sind — ist eine Stunde ohne Bedeutung.
       *
       * Wer Minutengenauigkeit braucht, braucht einen Arbeitsprozess, und
       * das ist eine Betriebsentscheidung.
       */
      runDueAutomations({ organizationId, limit: 200 }),
    ]);

    return Response.json({
      ok:
        customerReminders.status === 'fulfilled' &&
        crewReminders.status === 'fulfilled' &&
        automatisierungen.status === 'fulfilled',
      durationMs: Date.now() - startedAt,
      customerReminders:
        customerReminders.status === 'fulfilled'
          ? customerReminders.value
          : { error: String(customerReminders.reason) },
      crewReminders:
        crewReminders.status === 'fulfilled'
          ? { sent: crewReminders.value }
          : { error: String(crewReminders.reason) },
      automatisierungen:
        automatisierungen.status === 'fulfilled'
          ? automatisierungen.value
          : { error: String(automatisierungen.reason) },
    });
  },
});
