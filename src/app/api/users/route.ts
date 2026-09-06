import { z } from 'zod';

import { defineRoute } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { ForbiddenError } from '@/lib/errors';
import { assignableRoles } from '@/lib/auth/rbac';
import { inviteUserSchema, USER_ROLES, USER_STATUS } from '@/lib/validation/users';
import { inviteUser } from '@/server/services/auth.service';
import { listUsers } from '@/server/services/user.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

const listQuery = z.object({
  q: z.string().trim().max(120).optional(),
  role: z.enum(USER_ROLES).optional(),
  status: z.enum(USER_STATUS).optional(),
  papierkorb: z
    .enum(['0', '1'])
    .default('0')
    .transform((v) => v === '1'),
});

/** GET /api/users — Benutzerkonten der Organisation. */
export const GET = defineRoute({
  permissions: ['user:read'],
  query: listQuery,
  rateLimit: 'apiRead',
  handler: async ({ query }) =>
    ok(
      await listUsers({
        organizationId: await getOrganizationId(),
        q: query.q,
        role: query.role,
        status: query.status,
        includeDeleted: query.papierkorb,
      }),
    ),
});

/**
 * POST /api/users — Konto per Einladung anlegen.
 *
 * Kein Passwortfeld: die Person vergibt es selbst über einen einmaligen Link.
 * Ein von der Administration getipptes Startpasswort wandert sonst per E-Mail
 * oder Chat weiter und bleibt dort liegen.
 *
 * Die Rolle wird zusätzlich gegen `assignableRoles` geprüft — sonst könnte
 * jemand mit `user:create`, aber ohne `role:assign`, sich über den Umweg einer
 * Einladung eine Systemverantwortung erzeugen.
 */
export const POST = defineRoute({
  permissions: ['user:create'],
  body: inviteUserSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session }) => {
    const allowed = assignableRoles(session.role);
    if (!allowed.includes(body.role)) {
      throw new ForbiddenError(
        'Für diese Rolle fehlt Ihnen die Berechtigung. Rollen vergibt die Systemverantwortung.',
      );
    }

    const result = await inviteUser({
      organizationId: await getOrganizationId(),
      email: body.email,
      firstName: body.firstName,
      lastName: body.lastName,
      role: body.role,
      actorId: session.id,
    });

    return created({ id: result.userId });
  },
});
