import { definePublicRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { homeRouteFor } from '@/lib/auth/rbac';
import { loginSchema } from '@/lib/validation/auth';
import { login } from '@/server/services/auth.service';

export const runtime = 'nodejs';

/**
 * POST /api/auth/login
 *
 * Das Rate-Limit greift zusätzlich zur IP auch auf die E-Mail-Adresse: sonst
 * könnte ein verteilter Angriff mit vielen IPs ein einzelnes Konto beliebig
 * oft testen.
 */
export const POST = definePublicRoute({
  body: loginSchema,
  rateLimit: 'login',
  rateLimitKey: ({ ip }) => ip,
  handler: async ({ body, ip }) => {
    const { user, mustChangePassword } = await login({ input: body, ip });

    return ok({
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      mustChangePassword,
      redirectTo: mustChangePassword ? '/auth/passwort-aendern' : homeRouteFor(user.role),
    });
  },
});
