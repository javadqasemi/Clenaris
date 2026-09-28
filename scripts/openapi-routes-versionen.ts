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

  // --- Release-Ausführer (2026-09-27) --------------------------------------
  {
    method: 'get',
    path: '/api/cron/release-auftraege',
    tag: 'System',
    summary: 'Fällige Aktualisierungsaufträge (Ausführer)',
    description:
      'Nur für den Release-Ausführer ausserhalb der Anwendung: Bearer `RELEASE_EXECUTOR_TOKEN` **und** ' +
      'HMAC-Signatur (`x-clenaris-zeit`, `x-clenaris-signatur`, höchstens 5 Minuten alt). Liefert ' +
      'terminierte, fällige Aufträge der eigenen Umgebung mit Commit, Artefakt-Prüfsumme, CI-Stand, ' +
      'Migrationen, Rücksprungangaben und gegebenenfalls dem Hindernis. 422 bei fremder Umgebung, ' +
      '503 ohne `CLENARIS_UMGEBUNG`/Signaturschlüssel.',
    guard: { kind: 'cron' },
    query: system.releaseAuftraegeQuery,
    extraErrors: [422, 503],
  },
  {
    method: 'post',
    path: '/api/cron/release-auftraege/uebernehmen',
    tag: 'System',
    summary: 'Auftrag übernehmen (Ausführer)',
    description:
      'SCHEDULED → DEPLOYING. Nur fällige Aufträge der eigenen Umgebung, Version neuer als die laufende, ' +
      'CI bestanden, gemessene Prüfsumme = Prüfsumme des Release. Idempotent über `ausfuehrungsSchluessel`; ' +
      'ein anderer Schlüssel → 409. Steht im Prüfprotokoll. Die Anwendung führt nichts aus.',
    guard: { kind: 'cron' },
    body: system.releaseUebernahmeSchema,
    extraErrors: [409, 422, 503],
  },
  {
    method: 'post',
    path: '/api/cron/release-auftraege/ergebnis',
    tag: 'System',
    summary: 'Ergebnis melden (Ausführer)',
    description:
      'DEPLOYING → SUCCEEDED, FAILED oder ROLLED_BACK, nur mit dem Schlüssel der Übernahme. SUCCEEDED ' +
      'verlangt die Zielversion als `laufendeVersion`. Dieselbe Meldung erneut → 200; eine abweichende → 409.',
    guard: { kind: 'cron' },
    body: system.releaseErgebnisSchema,
    extraErrors: [409, 422],
  },
];
