import type { Permission } from '../src/lib/auth/permissions';
import * as suche from '../src/lib/validation/search';

import type { Guard, RouteDoc } from './openapi-routes';

/** Globale Suche (Wave 17). */

const perm = (mode: 'all' | 'any', ...permissions: Permission[]): Guard => ({
  kind: 'permissions',
  permissions,
  mode,
});

export const SUCHE_ROUTES: RouteDoc[] = [
  {
    method: 'get',
    path: '/api/search',
    tag: 'System',
    summary: 'Globale Suche',
    description:
      'Über die Bereiche, die die Rolle lesen darf, je höchstens fünf Treffer. Jeder Bereich nur mit ' +
      'seiner Leseberechtigung, die Organisation in jeder Abfrage, keine sensiblen Felder als ' +
      'Treffergrund (kein Lohn, keine IBAN, keine AHV-Nummer, keine Notizen). Mindestens zwei Zeichen.',
    guard: perm('all', 'dashboard:view'),
    rateLimit: 'apiRead',
    query: suche.globalSearchQuerySchema,
  },
];
