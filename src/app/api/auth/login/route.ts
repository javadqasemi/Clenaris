import { definePublicRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { homeRouteFor, profileRouteFor } from '@/lib/auth/rbac';
import { loginSchema } from '@/lib/validation/auth';
import { login } from '@/server/services/auth.service';

export const runtime = 'nodejs';

/**
 * POST /api/auth/login
 *
 * Zwei Bremsen, die sich ergänzen: Das Rate-Limit hier zählt je IP-Adresse
 * und stoppt breites Durchprobieren von einem Rechner aus. Gegen einen
 * verteilten Angriff auf *ein* Konto mit vielen IPs hilft es nicht — dafür
 * sperrt der Dienst das Konto nach acht Fehlversuchen für eine Viertelstunde
 * (`MAX_FAILED_LOGINS` in `auth.service.ts`).
 */
export const POST = definePublicRoute({
  body: loginSchema,
  rateLimit: 'login',
  rateLimitKey: ({ ip }) => ip,
  handler: async ({ body, ip }) => {
    const { user, mustChangePassword, twoFactorRequired } = await login({ input: body, ip });

    /**
     * Zweiter Faktor ausstehend.
     *
     * Die Antwort enthält bewusst **keine** Angaben zur Person — weder Name
     * noch Rolle. Wer das Passwort erraten hat, soll daraus nicht schon
     * ablesen können, wen er getroffen hat. Ein Zugangstoken wurde ebenfalls
     * nicht gesetzt; im Cookie steht nur ein kurzlebiger Zwischenschein.
     */
    if (twoFactorRequired || !user) {
      return ok({
        twoFactorRequired: true,
        redirectTo: '/auth/bestaetigen',
      });
    }

    return ok({
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      mustChangePassword,
      twoFactorRequired: false,
      redirectTo: mustChangePassword ? profileRouteFor(user.role) : homeRouteFor(user.role),
    });
  },
});
