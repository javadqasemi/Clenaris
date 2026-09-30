import { defineCronRoute } from '@/lib/api/handler';
import { getOrganizationId } from '@/server/services/organization.service';
import { sendBookingReminders, sendCrewReminders } from '@/server/services/automation.service';
import { automationEreignisseAbarbeiten, emitZeitbezogeneAusloeser, runDueAutomations } from '@/server/services/automation-engine.service';
import { mitUeberwachung } from '@/server/services/cron-monitor.service';
import { verwaisteAusfuehrungenAbschliessen } from '@/server/services/release-ausfuehrung.service';

export const runtime = 'nodejs';
export const maxDuration = 120;

/**
 * GET /api/cron/hourly — stündlich (siehe vercel.json).
 *
 * Hier laufen nur zeitkritische Erinnerungen: 24 Stunden vor dem Termin an die
 * Kundschaft, 2 Stunden vorher an Kundschaft und Team. Ein stündlicher Takt
 * genügt, weil die Zeitfenster grosszügig gewählt sind (20–28 bzw. 1–3
 * Stunden) — so fällt keine Erinnerung durch, auch wenn ein Lauf ausfällt.
 *
 * **Protokolliert und mit ehrlichem Statuscode** (seit 2026-09-23, RB-014):
 * Jeder Lauf hinterlässt ein `CronRun`; scheitert eine Teilaufgabe, antwortet
 * der Endpunkt mit 500, damit der Aufrufer (`curl -f` in der Crontab, die
 * Plattform) den Fehler sieht. Bis dahin war die Antwort 200, auch wenn jede
 * Teilaufgabe gescheitert war.
 */
export const GET = defineCronRoute({
  handler: async () => {
    const organizationId = await getOrganizationId();

    const ergebnis = await mitUeberwachung({
      organizationId,
      job: 'hourly',
      aufgaben: [
        { name: 'customerReminders', lauf: () => sendBookingReminders(organizationId) },
        { name: 'crewReminders', lauf: async () => ({ sent: await sendCrewReminders(organizationId) }) },
        {
          /**
           * Die Automatisierungen: zuerst die zeitbezogenen Auslöser melden
           * (Erinnerung, Fälligkeit, Geburtstag — bis 2026-09-23 entstanden
           * sie nie, RB-012), dann die fälligen Läufe ausführen. Nacheinander,
           * damit ein eben gemeldeter Lauf, der sofort fällig ist, im selben
           * Takt ausgeführt wird.
           *
           * **Stündlich und nicht minütlich**, weil `delayMinutes` in Minuten
           * gerechnet wird und eine Regel mit „nach 5 Minuten" damit bis zu
           * einer Stunde wartet. Das ist die bewusste Grenze dieser Bauart:
           * Sie kommt ohne eigenen Arbeitsprozess und ohne
           * Warteschlangendienst aus, und der Preis ist die Genauigkeit.
           */
          name: 'automatisierungen',
          lauf: async () => ({
            // Liegengebliebene Ereignisse aus der Transaktion der Vorgänge
            // (Outbox, 2026-09-27) — der Rückfall, falls die Verarbeitung
            // direkt nach dem Vorgang ausblieb.
            nachgeholt: await automationEreignisseAbarbeiten({ organizationId, limit: 500 }),
            ausgeloest: await emitZeitbezogeneAusloeser({ organizationId }),
            ausgefuehrt: await runDueAutomations({ organizationId, limit: 200 }),
          }),
        },
        {
          /**
           * Verwaiste Release-Ausführungen (2026-09-30): Ein Auftrag, zu dem
           * der Ausführer nach zwei Stunden nichts gemeldet hat, wird anhand
           * der Identität dieser Instanz abgeschlossen — erfolgreich, wenn
           * sie das Ziel belegt, sonst fehlgeschlagen. Ohne diesen Schritt
           * blieb er für immer „in Ausführung" und sperrte die Umgebung für
           * jede weitere Übernahme (`release-ausfuehrung.service.ts`).
           *
           * Stündlich reicht: Die Frist ist zwei Stunden, und bis dahin
           * wartet der Auftrag ohnehin auf die Rückmeldung. Der Endpunkt
           * läuft auf der Instanz selbst (Crontab gegen `127.0.0.1`), also
           * ist „diese Instanz" die, deren Stand belegt werden soll.
           */
          name: 'releaseAusfuehrungen',
          lauf: () => verwaisteAusfuehrungenAbschliessen(organizationId),
        },
      ],
    });

    return Response.json(
      {
        ok: ergebnis.status === 'SUCCESS',
        runId: ergebnis.runId,
        status: ergebnis.status,
        durationMs: ergebnis.durationMs,
        failures: ergebnis.fehlgeschlagen,
        summary: ergebnis.zusammenfassung,
      },
      { status: ergebnis.status === 'SUCCESS' ? 200 : 500 },
    );
  },
});
