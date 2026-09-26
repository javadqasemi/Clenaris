import { defineCronRoute } from '@/lib/api/handler';
import { getOrganizationId } from '@/server/services/organization.service';
import { cronZustand, pruefeAusgeblieben, zustandIstGesund } from '@/server/services/cron-monitor.service';
import { scannerZustand } from '@/server/services/security.service';
import { sicherungsFrische } from '@/server/services/security-report.service';

export const runtime = 'nodejs';

/**
 * GET /api/cron/status — der Zustand der geplanten Läufe, für eine
 * Überwachung **von aussen**.
 *
 * Die Läufe prüfen sich gegenseitig (der stündliche meldet einen
 * ausgebliebenen Nachtlauf und umgekehrt). Bleiben **beide** aus — die
 * Crontab fehlt nach einer Neuinstallation, die Plattform ruft nicht mehr an
 * —, meldet von innen niemand etwas. Dafür diese Adresse: Ein
 * Überwachungsdienst ruft sie alle paar Minuten auf und schlägt bei 503 an.
 *
 * 200 = alle Aufträge frisch, keiner hängt, keiner scheitert wiederholt.
 * 503 = mindestens eines davon nicht. Der Rumpf nennt Zeitpunkte und Zahlen,
 * keine Inhalte.
 *
 * **Betrieb (2026-09-26).** Zusätzlich — ohne Einfluss auf Statuscode und
 * `gesund`, deren Bedeutung sich nicht ändert — `betrieb`: erreicht die
 * Anwendung ihren Schadsoftwareprüfer, wann lief die letzte Sicherung und die
 * letzte bestandene Wiederherstellungsprobe. Die Bewertung („zu alt",
 * „nicht erreichbar") macht der Überwachungsrechner
 * (`ops/security-monitor/security_check.sh`) und alarmiert je Punkt; ein
 * einziger Statuscode für vier verschiedene Probleme hiesse, beim Alarm erst
 * suchen zu müssen, welches.
 *
 * **Zwei Geheimnisse, beide nur zum Lesen hier.** `CRON_SECRET` wie bisher,
 * dazu `SECURITY_REPORT_TOKEN`: Der Überwachungsrechner kennt nur dieses und
 * kann damit keinen Lauf auslösen (`/api/cron/hourly` und `/daily` nehmen
 * weiterhin nur `CRON_SECRET`). Ohne dieses Token müsste der
 * Überwachungsrechner das Geheimnis besitzen, mit dem sich die nächtlichen
 * Aufträge starten lassen.
 *
 * Nicht öffentlich: Wann welcher Lauf zuletzt gescheitert ist, ist eine
 * Auskunft über den Betrieb, die niemanden ausser den Betrieb etwas angeht.
 */
export const GET = defineCronRoute({
  secretEnv: ['CRON_SECRET', 'SECURITY_REPORT_TOKEN'],
  handler: async () => {
    const organizationId = await getOrganizationId();
    // Die Prüfung auf Ausbleiben meldet auch — einmal je Überfälligkeit.
    for (const job of ['hourly', 'daily']) await pruefeAusgeblieben(organizationId, job);
    const [zustaende, pruefer, sicherung] = await Promise.all([cronZustand(organizationId), scannerZustand(), sicherungsFrische(organizationId)]);
    const gesund = zustandIstGesund(zustaende);
    return Response.json(
      {
        gesund,
        auftraege: zustaende,
        betrieb: {
          schadsoftwarepruefer: { eingerichtet: pruefer.eingerichtet, art: pruefer.art, erreichbar: pruefer.erreichbar },
          sicherung: sicherung.sicherung,
          wiederherstellung: sicherung.wiederherstellung,
        },
      },
      { status: gesund ? 200 : 503 },
    );
  },
});
