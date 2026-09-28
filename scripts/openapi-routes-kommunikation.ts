import type { Permission } from '../src/lib/auth/permissions';
import * as kommunikation from '../src/lib/validation/kommunikation';

import type { Guard, RouteDoc } from './openapi-routes';

/** Zustellstatus und -protokoll (Wave 14). */

const perm = (mode: 'all' | 'any', ...permissions: Permission[]): Guard => ({
  kind: 'permissions',
  permissions,
  mode,
});

export const KOMMUNIKATION_ROUTES: RouteDoc[] = [
  {
    method: 'post',
    path: '/api/webhooks/resend',
    tag: 'System',
    summary: 'Resend-Zustellmeldungen',
    description:
      'Svix-Signatur gegen den Rohtext, Zeitstempel höchstens fünf Minuten alt; ohne ' +
      '`RESEND_WEBHOOK_SECRET` 503, ungültige Signatur 401. Aktualisiert das E-Mail-Protokoll ' +
      'über die Anbieterkennung — ordnungsfest und idempotent (ein Abprall überschreibt eine ' +
      'Zustellung, eine späte „gesendet"-Meldung nicht). Fehler beim Verarbeiten: 500.',
    guard: { kind: 'public' },
  },
  {
    method: 'post',
    path: '/api/webhooks/twilio',
    tag: 'System',
    summary: 'Twilio-Zustellmeldungen',
    description:
      'Status-Callback für SMS. Signatur `X-Twilio-Signature` über die öffentliche Adresse und die ' +
      'Formularfelder, geprüft mit `TWILIO_AUTH_TOKEN`; ohne Token 503, ungültig 401.',
    guard: { kind: 'public' },
  },
  {
    method: 'get',
    path: '/api/communication/logs',
    tag: 'Kommunikation',
    summary: 'Zustellprotokoll',
    description: 'E-Mail oder SMS mit Status laut Anbieter, Zustell- und Öffnungszeitpunkt; ohne Inhalt.',
    guard: perm('all', 'template:read'),
    rateLimit: 'apiRead',
    query: kommunikation.zustellprotokollQuerySchema,
  },
];
