import type { Permission } from '../src/lib/auth/permissions';
import { idParam } from '../src/lib/validation/queries';
import * as scan from '../src/lib/validation/scan';

import type { Guard, RouteDoc } from './openapi-routes';

/** Scanplattform (2026-09-26). */

const perm = (mode: 'all' | 'any', ...permissions: Permission[]): Guard => ({
  kind: 'permissions',
  permissions,
  mode,
});

export const SCAN_ROUTES: RouteDoc[] = [
  {
    method: 'post',
    path: '/api/scan/resolve',
    tag: 'System',
    summary: 'Scan auflösen',
    description:
      'Einen gescannten oder eingefügten Text (Etikettcode, EAN/GTIN, QR-Rechnung in alter und neuer ' +
      'Referenzform, Material-, Inventar-, Einsatz-, Rechnungs-, Kunden- oder Vertragsnummer) einordnen und ' +
      'im Leserecht der Rolle auflösen. Liest nur: die Antwort nennt Treffer, die Schlüssel der ' +
      'Schnellaktionen und Verweise zum Lesen (PDF, Rapport), ausgeführt wird nichts — jede Aktion läuft ' +
      'über ihren bestehenden Endpunkt. Unbekannt, fremde Organisation, gelöscht und ohne Recht ' +
      'ergeben dieselbe leere Antwort. Adressen werden weder aufgelöst noch als Link zurückgegeben. ' +
      'Kontingent je Person: 60 pro Minute.',
    guard: perm('all', 'dashboard:view'),
    rateLimit: 'scanResolve',
    body: scan.scanResolveSchema,
  },
  {
    method: 'post',
    path: '/api/scan/codes',
    tag: 'System',
    summary: 'Etikettcode erzeugen',
    description:
      'Den aktiven Etikettcode eines Datensatzes liefern (200) oder erzeugen (201). Ein aktiver Code je ' +
      'Datensatz, erzwungen durch einen Teilindex. Verlangt das Pflegerecht der Art: Material ' +
      '`inventory:manage`, Gerät `equipment:manage`, Objekt `property:update`, Einsatz `job:update` (sonst 403). ' +
      'Fremde oder unbekannte IDs: 404.',
    guard: perm('any', 'inventory:manage', 'equipment:manage', 'property:update', 'job:update'),
    rateLimit: 'apiWrite',
    body: scan.scanCodeCreateSchema,
    extraErrors: [403],
  },
  {
    method: 'delete',
    path: '/api/scan/codes/{id}',
    tag: 'System',
    summary: 'Etikettcode sperren',
    description:
      'Endgültig. Der Eintrag bleibt als Nachweis; der Code löst danach nichts mehr auf. Ohne ' +
      'Pflegerecht für die Art des Datensatzes: 404 wie bei einer fremden ID.',
    guard: perm('any', 'inventory:manage', 'equipment:manage', 'property:update', 'job:update'),
    rateLimit: 'apiWrite',
    params: idParam,
  },
];
