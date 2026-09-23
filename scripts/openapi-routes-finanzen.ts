import type { Permission } from '../src/lib/auth/permissions';
import * as finance from '../src/lib/validation/finance';
import { idParam } from '../src/lib/validation/queries';

import type { Guard, RouteDoc } from './openapi-routes';

/**
 * Gutschriften (Wave 13). Bis 2026-09-23 gab es `createCreditNote` im Dienst,
 * aber keinen Weg dorthin — der Storno einer teilweise bezahlten Rechnung
 * verwies auf eine Gutschrift, die sich nicht erstellen liess.
 */

const perm = (mode: 'all' | 'any', ...permissions: Permission[]): Guard => ({
  kind: 'permissions',
  permissions,
  mode,
});

export const FINANZ_ROUTES: RouteDoc[] = [
  {
    method: 'get',
    path: '/api/credit-notes',
    tag: 'Finanzen',
    summary: 'Gutschriften',
    description: 'Optional je Kundschaft oder Rechnung.',
    guard: perm('all', 'creditnote:read'),
    rateLimit: 'apiRead',
    query: finance.creditNoteQuerySchema,
  },
  {
    method: 'post',
    path: '/api/credit-notes',
    tag: 'Finanzen',
    summary: 'Gutschrift ausstellen',
    description:
      'Nummer aus dem lückenlosen Nummernkreis in derselben Transaktion. Mit Bezugsrechnung: gleiche ' +
      'Kundschaft, ausgestellt und nicht storniert, über alle Gutschriften nie mehr als der ' +
      'Rechnungsbetrag (422); der offene Posten sinkt entsprechend. Danach unveränderlich.',
    guard: perm('all', 'creditnote:create'),
    rateLimit: 'apiWrite',
    body: finance.createCreditNoteSchema,
    extraErrors: [422],
  },
  {
    method: 'post',
    path: '/api/invoices/{id}/credit-note',
    tag: 'Finanzen',
    summary: 'Gutschrift zu einer Rechnung',
    description: 'Eine Zeile, Kundschaft aus der Rechnung; dieselben Regeln wie `POST /api/credit-notes`.',
    guard: perm('all', 'creditnote:create'),
    rateLimit: 'apiWrite',
    params: idParam,
    body: finance.invoiceCreditNoteSchema,
    extraErrors: [422],
  },
  {
    method: 'get',
    path: '/api/credit-notes/{id}/pdf',
    tag: 'Finanzen',
    summary: 'Gutschrift als PDF',
    description: 'Gerendert aus den unveränderlichen Daten der Gutschrift.',
    guard: perm('all', 'creditnote:read'),
    rateLimit: 'apiRead',
    params: idParam,
    produces: 'application/pdf',
  },
];
