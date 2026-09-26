import type { Permission } from '../src/lib/auth/permissions';
import * as q from '../src/lib/validation/queries';
import * as system from '../src/lib/validation/system';

import type { Guard, RouteDoc } from './openapi-routes';

/**
 * Versionsverwaltung — das Update Center der Systemverantwortung
 * (Produktsprint 2026-09-26). Keiner dieser Endpunkte führt etwas aus; sie
 * halten Entscheidungen fest, die ein externer Ausführer später liest.
 */

const perm = (mode: 'all' | 'any', ...permissions: Permission[]): Guard => ({
  kind: 'permissions',
  permissions,
  mode,
});

export const VERSIONEN_ROUTES: RouteDoc[] = [
  {
    method: 'get',
    path: '/api/system/releases',
    tag: 'System',
    summary: 'Bekannte Clenaris-Versionen',
    description:
      'Laufende Version und je bekannte Version ihr Zustand für diesen Betrieb: verfügbar, ' +
      'freigegeben, terminiert, installiert oder älter. Nur die Systemverantwortung.',
    guard: perm('all', 'release:read'),
    rateLimit: 'apiRead',
  },
  {
    method: 'get',
    path: '/api/system/releases/{id}',
    tag: 'System',
    summary: 'Eine Version mit Änderungsprotokoll',
    description: 'Änderungsprotokoll in Administrationssprache und der Verlauf der Entscheidungen dazu.',
    guard: perm('all', 'release:read'),
    rateLimit: 'apiRead',
    params: q.idParam,
  },
  {
    method: 'post',
    path: '/api/system/releases/{id}/freigabe',
    tag: 'System',
    summary: 'Version freigeben',
    description:
      'Legt einen Aktualisierungsauftrag (APPROVED) an und schreibt ihn im selben Commit ins ' +
      'Prüfprotokoll. Führt nichts aus. 422, wenn die Version installiert, älter oder bereits ' +
      'freigegeben ist; 409, wenn gleichzeitig entschieden wurde.',
    guard: perm('all', 'release:manage'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    extraErrors: [409],
  },
  {
    method: 'put',
    path: '/api/system/releases/{id}/termin',
    tag: 'System',
    summary: 'Aktualisierung terminieren oder verschieben',
    description:
      'Aus „verfügbar" schliesst das die Freigabe ein. Termin frühestens in 15 Minuten, ' +
      'spätestens in 90 Tagen. Alter und neuer Termin stehen im Prüfprotokoll.',
    guard: perm('all', 'release:manage'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    body: system.releaseScheduleSchema,
    extraErrors: [409],
  },
  {
    method: 'post',
    path: '/api/system/releases/{id}/termin/stornieren',
    tag: 'System',
    summary: 'Termin stornieren',
    description:
      'Nur aus „terminiert". Der Auftrag wird CANCELLED und bleibt als Nachweis; die Version ist ' +
      'danach wieder verfügbar.',
    guard: perm('all', 'release:manage'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    body: system.releaseCancelSchema,
  },
  {
    method: 'post',
    path: '/api/system/releases/{id}/zurueckstellen',
    tag: 'System',
    summary: 'Version zurückstellen („Nicht jetzt")',
    description: 'Blendet eine verfügbare Version für einige Tage aus. Keine Freigabe, kein Auftrag.',
    guard: perm('all', 'release:manage'),
    rateLimit: 'apiWrite',
    params: q.idParam,
    body: system.releaseDeferSchema,
  },
];
