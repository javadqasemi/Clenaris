import { definePublicRoute } from '@/lib/api/handler';
import { noContent } from '@/lib/api/response';
import { serverEnv } from '@/lib/env';
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
 *
 * ---------------------------------------------------------------------------
 *  Ausgeschaltet (`CLENARIS_BESUCHSMESSUNG` nicht „an", 2026-09-30)
 * ---------------------------------------------------------------------------
 *
 * Dann antwortet die Route ebenfalls 204 — und speichert nichts, fragt die
 * Datenbank nicht einmal nach der Organisation. Kein 404 und kein 503: Ein
 * Tab, der noch vor dem Ausschalten geladen wurde, meldet weiter, und eine
 * Fehlerantwort brächte ihm nichts ausser einer roten Konsolenzeile. Dass die
 * Messung aus ist, erfährt der Browser aus der Laufzeitkonfiguration
 * (`besuchsmessung`) und sendet dann gar nicht erst.
 *
 * **Entschieden: Das Kontingent zählt auch im ausgeschalteten Zustand.** Der
 * Schalter wird erst im Handler gelesen, nach Herkunftsprüfung, Kontingent
 * und Schema der Fabrik. Erwogen und verworfen wurde, ihn davorzuziehen. Das
 * ginge nur, indem diese Route ihr Kontingent selbst zählt — kein
 * `rateLimit` an der Fabrik, `enforceRateLimit` im Handler, nur wenn
 * eingeschaltet. Dann aber läse die **eingeschaltete** Messung jeden Körper
 * vollständig, bevor sie ablehnt, auch weit über dem Kontingent; heute weist
 * die Fabrik die 121. Meldung einer Minute ab, ohne ihren Körper anzusehen.
 * Und diese Route wäre die einzige öffentliche, deren Schutz von Hand
 * geschrieben ist — genau die Art Ausnahme, die beim nächsten Umbau verloren
 * geht. Der Gewinn stünde dagegen fast bei null: Ein Zählschlüssel lebt
 * sechzig Sekunden, trägt keinen Inhalt, und dieselbe Adresse zählt die
 * Fabrik ohnehin bei jedem öffentlichen Aufruf, auch beim Holen der
 * Laufzeitkonfiguration. „Aus" heisst deshalb: kein Besuch gespeichert,
 * keine Datenbankabfrage — nicht: kein Zähler.
 */
export const POST = definePublicRoute({
  body: trafficBatchSchema,
  rateLimit: 'traffic',
  handler: async ({ body, request }) => {
    if (!serverEnv().CLENARIS_BESUCHSMESSUNG) return noContent();

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
