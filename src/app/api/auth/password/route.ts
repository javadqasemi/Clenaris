import { defineRoute, definePublicRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { changePasswordSchema, passwordActionSchema } from '@/lib/validation/auth';
import {
  acceptInvite,
  changePassword,
  requestPasswordReset,
  resetPassword,
} from '@/server/services/auth.service';

export const runtime = 'nodejs';

/**
 * POST /api/auth/password
 *
 * Ein Endpunkt für vier Vorgänge — unterschieden über `action`. Das hält die
 * Route-Struktur schlank; die Vorgänge teilen sich Rate-Limit und
 * Fehlerbehandlung, unterscheiden sich aber im Berechtigungsbedarf.
 *
 * `forgot` und `reset` antworten bewusst immer erfolgreich: die Antwort darf
 * nicht verraten, ob eine E-Mail-Adresse registriert ist.
 */

export const POST = definePublicRoute({
  body: passwordActionSchema,
  rateLimit: 'passwordReset',
  handler: async ({ body, ip }) => {
    if (body.action === 'forgot') {
      await requestPasswordReset(body.email!, ip);
      // Immer dieselbe Antwort — unabhängig davon, ob das Konto existiert.
      return ok({
        message:
          'Falls ein Konto mit dieser Adresse besteht, haben wir Ihnen einen Link zum Zurücksetzen geschickt.',
      });
    }

    if (body.action === 'reset') {
      await resetPassword({ token: body.token!, password: body.password!, ip });
      return ok({ message: 'Ihr Passwort wurde geändert.', redirectTo: '/auth/anmelden' });
    }

    await acceptInvite({ token: body.token!, password: body.password! });
    return ok({ message: 'Ihr Zugang ist aktiv.', redirectTo: '/' });
  },
});

/** PATCH /api/auth/password — Passwortwechsel im angemeldeten Zustand. */
export const PATCH = defineRoute({
  body: changePasswordSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) => {
    await changePassword({
      userId: session.id,
      currentPassword: body.currentPassword,
      newPassword: body.password,
      ip,
    });
    return ok({ message: 'Ihr Passwort wurde geändert.' });
  },
});
