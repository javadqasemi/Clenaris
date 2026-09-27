import * as suche from '../src/lib/validation/search';

import type { RouteDoc } from './openapi-routes';

/** Globale Suche (Wave 17). */

export const SUCHE_ROUTES: RouteDoc[] = [
  {
    method: 'get',
    path: '/api/search',
    tag: 'System',
    summary: 'Globale Suche',
    description:
      'Über die Bereiche, die die Rolle lesen darf, je höchstens fünf Treffer; `mehr` nennt die ' +
      'Bereiche mit weiteren, `hinweis` die Meldung des Scanners zu einem Etikettcode (etwa „gesperrt"). ' +
      'Jeder Bereich nur mit seiner Leseberechtigung, die Organisation in jeder Abfrage, keine sensiblen ' +
      'Felder als Treffergrund (kein Lohn, keine IBAN, keine AHV-Nummer, keine Notizen). Mindestens zwei ' +
      'Zeichen. Nur für die Rollen der Verwaltung — jeder Treffer führt nach /admin.',
    guard: { kind: 'role', roles: ['SUPER_ADMIN', 'ADMIN', 'MANAGER'] },
    rateLimit: 'search',
    query: suche.globalSearchQuerySchema,
  },
];
