import { definePublicRoute } from '@/lib/api/handler';
import { created } from '@/lib/api/response';
import { registerSchema } from '@/lib/validation/auth';
import { register } from '@/server/services/auth.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** POST /api/auth/register — Kundenkonto anlegen und direkt anmelden. */
export const POST = definePublicRoute({
  body: registerSchema,
  rateLimit: 'register',
  handler: async ({ body, ip }) => {
    const organizationId = await getOrganizationId();
    const user = await register({ organizationId, input: body, ip });

    return created({
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      role: user.role,
      redirectTo: '/konto',
    });
  },
});
