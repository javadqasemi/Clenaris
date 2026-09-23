import { defineCronRoute } from '@/lib/api/handler';
import { getOrganizationId } from '@/server/services/organization.service';
import { cronZustand, pruefeAusgeblieben, zustandIstGesund } from '@/server/services/cron-monitor.service';

export const runtime = 'nodejs';

/**
 * GET /api/cron/status — der Zustand der geplanten Läufe, für eine
 * Überwachung **von aussen**.
 *
 * Die Läufe prüfen sich gegenseitig (der stündliche meldet einen
 * ausgebliebenen Nachtlauf und umgekehrt). Bleiben **beide** aus — die
 * Crontab fehlt nach einer Neuinstallation, die Plattform ruft nicht mehr an
 * —, meldet von innen niemand etwas. Dafür diese Adresse: Ein
 * Überwachungsdienst ruft sie alle paar Minuten mit `CRON_SECRET` auf und
 * schlägt bei 503 an.
 *
 * 200 = alle Aufträge frisch, keiner hängt, keiner scheitert wiederholt.
 * 503 = mindestens eines davon nicht. Der Rumpf nennt Zeitpunkte und Zahlen,
 * keine Inhalte.
 *
 * Hinter `CRON_SECRET` und nicht öffentlich: Wann welcher Lauf zuletzt
 * gescheitert ist, ist eine Auskunft über den Betrieb, die niemanden ausser
 * den Betrieb etwas angeht.
 */
export const GET = defineCronRoute({
  handler: async () => {
    const organizationId = await getOrganizationId();
    // Die Prüfung auf Ausbleiben meldet auch — einmal je Überfälligkeit.
    for (const job of ['hourly', 'daily']) await pruefeAusgeblieben(organizationId, job);
    const zustaende = await cronZustand(organizationId);
    const gesund = zustandIstGesund(zustaende);
    return Response.json({ gesund, auftraege: zustaende }, { status: gesund ? 200 : 503 });
  },
});
