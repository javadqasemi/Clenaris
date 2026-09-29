import type { Permission } from '../src/lib/auth/permissions';
import * as traffic from '../src/lib/validation/traffic';

import type { Guard, RouteDoc } from './openapi-routes';

/** Eigene Besuchsmessung der Website (2026-09-28). */

const perm = (mode: 'all' | 'any', ...permissions: Permission[]): Guard => ({
  kind: 'permissions',
  permissions,
  mode,
});

export const TRAFFIC_ROUTES: RouteDoc[] = [
  {
    method: 'post',
    path: '/api/public/traffic',
    tag: 'Öffentlich',
    summary: 'Besuchsereignisse melden',
    description:
      'Seitenansichten und Konversionen der öffentlichen Website, höchstens zwanzig je Anfrage. Der ' +
      'Browser sendet nur mit Einwilligung „Statistik". Der Server bereinigt: Pfad ohne Abfrage (nur ' +
      '`utm_source`/`utm_medium`/`utm_campaign` bleiben, in eigenen Spalten), Token-Segmente als ' +
      '`:token`, App-Bereiche (/admin, /portal, /konto, /api, /auth, /signieren) verworfen, Referrer ' +
      'nur als fremder Host, Gerät und Browser als Familie aus dem User-Agent (der selbst nicht ' +
      'gespeichert wird), Sitzung nur als tagesgebundener HMAC. `Sec-GPC: 1` oder `DNT: 1` verwirft ' +
      'alles. Die IP dient nur dem Kontingent. Antwort immer 204, auch wenn nichts gespeichert wurde.',
    guard: { kind: 'public' },
    rateLimit: 'traffic',
    body: traffic.trafficBatchSchema,
    status: 204,
  },
  {
    method: 'get',
    path: '/api/traffic',
    tag: 'Website',
    summary: 'Besuchsauswertung',
    description:
      'Seitenansichten, Sitzungen (je Tab und Zürcher Tag, keine Personen), Einstiegs- und ' +
      'meistbesuchte Seiten, Herkunft, UTM-Quelle/-Medium/-Kampagne, Geräte, Browser und ' +
      'Konversionen mit Rate je Sitzung für einen Zeitraum in Zürcher Tagen; dazu die Grundzahlen ' +
      'des gleich langen Zeitraums davor. Ranglisten höchstens zehn Zeilen, alles je Organisation.',
    guard: perm('all', 'traffic:read'),
    rateLimit: 'apiRead',
    query: traffic.trafficAuswertungQuerySchema,
  },
];
