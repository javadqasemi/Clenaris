import type { Permission } from '../src/lib/auth/permissions';
import * as verkauf from '../src/lib/validation/verkauf';
import { idParam } from '../src/lib/validation/queries';

import type { Guard, RouteDoc } from './openapi-routes';

/**
 * Besichtigung / Objektaufnahme (Wave 12). Die Rechte sind die der Offerte:
 * Eine Besichtigung ist die Vorstufe einer Offerte, kein eigener Bereich mit
 * eigener Zuständigkeit.
 */

const perm = (mode: 'all' | 'any', ...permissions: Permission[]): Guard => ({
  kind: 'permissions',
  permissions,
  mode,
});

export const VERKAUF_ROUTES: RouteDoc[] = [
  {
    method: 'get',
    path: '/api/site-visits',
    tag: 'Offerten',
    summary: 'Besichtigungen',
    description: 'Optional je Status, Anfrage oder Kundschaft.',
    guard: perm('all', 'quote:read'),
    rateLimit: 'apiRead',
    query: verkauf.siteVisitQuerySchema,
  },
  {
    method: 'post',
    path: '/api/site-visits',
    tag: 'Offerten',
    summary: 'Besichtigung planen',
    description: 'Zu einer Anfrage oder Kundschaft; alle Bezüge müssen der Organisation gehören (404/422).',
    guard: perm('all', 'quote:create'),
    rateLimit: 'apiWrite',
    body: verkauf.siteVisitCreateSchema,
    extraErrors: [422],
  },
  {
    method: 'get',
    path: '/api/site-visits/{id}',
    tag: 'Offerten',
    summary: 'Eine Besichtigung',
    description: 'Mit Flächen, Leistungen und der letzten Berechnung.',
    guard: perm('all', 'quote:read'),
    rateLimit: 'apiRead',
    params: idParam,
  },
  {
    method: 'patch',
    path: '/api/site-visits/{id}',
    tag: 'Offerten',
    summary: 'Besichtigung ändern',
    description: 'Nicht mehr nach der Offerte (422); verwirft die gespeicherte Berechnung.',
    guard: perm('all', 'quote:update'),
    rateLimit: 'apiWrite',
    params: idParam,
    body: verkauf.siteVisitUpdateSchema,
    extraErrors: [422],
  },
  {
    method: 'put',
    path: '/api/site-visits/{id}/areas',
    tag: 'Offerten',
    summary: 'Flächen aufnehmen',
    description: 'Als Ganzes; Leistungen aus dem aktiven Katalog, Zusatzleistungen nur die der Leistung. Kein Preisfeld.',
    guard: perm('all', 'quote:update'),
    rateLimit: 'apiWrite',
    params: idParam,
    body: verkauf.siteVisitAreasSchema,
    extraErrors: [422],
  },
  {
    method: 'post',
    path: '/api/site-visits/{id}/areas',
    tag: 'Offerten',
    summary: 'Eine Fläche anhängen',
    description: 'Dieselben Prüfungen wie beim Setzen aller Flächen.',
    guard: perm('all', 'quote:update'),
    rateLimit: 'apiWrite',
    params: idParam,
    body: verkauf.siteVisitAreaSchema,
    extraErrors: [422],
  },
  {
    method: 'delete',
    path: '/api/site-visits/{id}/areas/{areaId}',
    tag: 'Offerten',
    summary: 'Eine Fläche entfernen',
    description: 'Nicht nach der Offerte (422); verwirft die gespeicherte Berechnung.',
    guard: perm('all', 'quote:update'),
    rateLimit: 'apiWrite',
    params: verkauf.siteVisitAreaParams,
    extraErrors: [422],
  },
  {
    method: 'post',
    path: '/api/site-visits/{id}/complete',
    tag: 'Offerten',
    summary: 'Besichtigung abschliessen',
    description: 'Mindestens eine Fläche (422).',
    guard: perm('all', 'quote:update'),
    rateLimit: 'apiWrite',
    params: idParam,
    body: verkauf.siteVisitCompleteSchema,
    extraErrors: [422],
  },
  {
    method: 'post',
    path: '/api/site-visits/{id}/cancel',
    tag: 'Offerten',
    summary: 'Besichtigung absagen',
    description: 'Mit Grund; nicht nach der Offerte.',
    guard: perm('all', 'quote:update'),
    rateLimit: 'apiWrite',
    params: idParam,
    body: verkauf.siteVisitCancelSchema,
    extraErrors: [422],
  },
  {
    method: 'post',
    path: '/api/site-visits/{id}/calculate',
    tag: 'Offerten',
    summary: 'Besichtigung berechnen',
    description: 'Jede Fläche durch dieselbe Preisberechnung wie die Online-Buchung; Ergebnis als Vorschau festgehalten.',
    guard: perm('all', 'quote:update'),
    rateLimit: 'apiWrite',
    params: idParam,
    extraErrors: [422],
  },
  {
    method: 'post',
    path: '/api/site-visits/{id}/quote',
    tag: 'Offerten',
    summary: 'Offerte aus Besichtigung',
    description:
      'Neu gerechnet, eine Position je Fläche, Preise aus der Berechnung; höchstens eine Offerte je ' +
      'Besichtigung, „Preis auf Anfrage" wird nicht geraten (422).',
    guard: perm('all', 'quote:create'),
    rateLimit: 'apiWrite',
    params: idParam,
    body: verkauf.siteVisitQuoteSchema,
    extraErrors: [422],
  },
];
