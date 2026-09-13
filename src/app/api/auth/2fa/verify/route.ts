import { definePublicRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { twoFactorTokenSchema } from '@/lib/validation/auth';
import { homeRouteFor, profileRouteFor } from '@/lib/auth/rbac';
import { prisma } from '@/lib/db';
import { completeMfaLogin } from '@/server/services/two-factor.service';

export const runtime = 'nodejs';

/**
 * POST /api/auth/2fa/verify — zweiter Schritt der Anmeldung.
 *
 * Öffentlich, weil hier noch keine Sitzung besteht: der Aufrufer weist sich
 * über den kurzlebigen Zwischenschein aus, den der erste Schritt gesetzt hat.
 * Erst dieser Endpunkt erzeugt das Zugangstoken.
 *
 * Das Rate-Limit ist das der Anmeldung: sechs Ziffern sind eine Million
 * Möglichkeiten, und ohne Bremse wären sie in Minuten durchprobiert.
 */
export const POST = definePublicRoute({
  body: twoFactorTokenSchema,
  rateLimit: 'login',
  rateLimitKey: ({ ip }) => ip,
  handler: async ({ body, ip }) => {
    const result = await completeMfaLogin({ token: body.token, ip });

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: result.userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        mustChangePassword: true,
      },
    });

    return ok({
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
      // Ein aufgebrauchter Vorrat an Wiederherstellungscodes ist der Moment,
      // in dem man es erfahren will — nicht erst beim nächsten Gerätewechsel.
      usedRecoveryCode: result.usedRecoveryCode,
      remainingRecoveryCodes: result.remainingCodes,
      redirectTo: user.mustChangePassword ? profileRouteFor(user.role) : homeRouteFor(user.role),
    });
  },
});
