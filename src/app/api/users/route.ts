import { defineRoute } from '@/lib/api/handler';
import { userListQuery } from '@/lib/validation/queries';
import { buildPagination, created, paginated } from '@/lib/api/response';
import { ForbiddenError } from '@/lib/errors';
import { assignableRoles } from '@/lib/auth/rbac';
import { inviteUserSchema } from '@/lib/validation/users';
import { inviteUser } from '@/server/services/auth.service';
import { listUsers } from '@/server/services/user.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';


/**
 * GET /api/users — Benutzerkonten der Organisation, seitenweise.
 *
 * `data` bleibt eine Liste; Seite und Gesamtzahl stehen in `meta`
 * (2026-09-27, vorher ungebremst die ganze Tabelle).
 */
export const GET = defineRoute({
  permissions: ['user:read'],
  query: userListQuery,
  rateLimit: 'apiRead',
  handler: async ({ query }) => {
    const { items, total } = await listUsers({
      organizationId: await getOrganizationId(),
      q: query.q,
      role: query.role,
      status: query.status,
      includeDeleted: query.papierkorb,
      page: query.page,
      pageSize: query.pageSize,
    });
    return paginated(items, buildPagination(query.page, query.pageSize, total));
  },
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
