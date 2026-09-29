import { definePublicRoute } from '@/lib/api/handler';
import { noContent } from '@/lib/api/response';
import { laufzeitUrsprung } from '@/lib/laufzeit-konfiguration';
import { trafficBatchSchema } from '@/lib/validation/traffic';
import { getOrganizationId } from '@/server/services/organization.service';
import { trafficErfassen } from '@/server/services/traffic.service';

export const runtime = 'nodejs';

/**
 * POST /api/public/traffic — eigene Besuchsmessung der Website.
 *
 * Öffentlich, weil die Besucherinnen nicht angemeldet sind; geschützt durch
 * die Herkunftsprüfung der Routenfabrik (ein fremder `Origin` ist 403), das
 * Kontingent `traffic` je IP und ein enges, strenges Schema (höchstens zwanzig
 * Ereignisse, 422 bei Übergrösse oder unbekanntem Feld).
 *
 * Die Antwort ist **immer 204**, ob gespeichert, bereinigt oder verworfen
 * (App-Bereich, `Sec-GPC`, `DNT`, Automat). Der Browser wertet sie ohnehin
 * nicht aus — `sendBeacon` kennt keine Antwort —, und eine Antwort, die den
 * Grund einer Verwerfung nennte, wäre eine Anleitung, die Bereinigung zu
 * umgehen.
 *
 * Die IP-Adresse der Anfrage dient ausschliesslich als Zählschlüssel des
 * Kontingents (Vorgabe der Fabrik) und wird nie an den Dienst weitergereicht.
 */
export const POST = definePublicRoute({
  body: trafficBatchSchema,
  rateLimit: 'traffic',
  handler: async ({ body, request }) => {
    const eigeneHosts: string[] = [];
    const host = request.headers.get('host');
    if (host) eigeneHosts.push(host);
    try {
      eigeneHosts.push(new URL(laufzeitUrsprung()).host);
    } catch {
      /* Eine ungültige App-URL scheitert an anderer Stelle lauter. */
    }

    await trafficErfassen(body, {
      organizationId: await getOrganizationId(),
      kopf: (name) => request.headers.get(name),
      eigeneHosts,
    });
    return noContent();
  },
});
