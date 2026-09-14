import { defineRoute } from '@/lib/api/handler';
import { noContent } from '@/lib/api/response';
import { twoFactorDisableSchema } from '@/lib/validation/auth';
import { disableTwoFactor } from '@/server/services/two-factor.service';

export const runtime = 'nodejs';

/**
 * POST /api/auth/2fa/disable — Zwei-Faktor-Anmeldung ausschalten.
 *
 * Verlangt Passwort **und** einen gültigen Code. Nur das Passwort würde
 * genügen, wenn jemand eine offene Sitzung übernimmt — und dann wäre der
 * zweite Faktor genau in dem Moment weg, in dem er gebraucht wird. Ein
 * Wiederherstellungscode wird ebenfalls akzeptiert.
 */
export const POST = defineRoute({
  body: twoFactorDisableSchema,
  rateLimit: 'login',
  rateLimitKey: ({ session }) => session?.id ?? 'anonym',
  handler: async ({ body, session, ip }) => {
    await disableTwoFactor({
      userId: session.id,
      password: body.password,
      token: body.token,
      ip,
    });
    return noContent();
  },
});
