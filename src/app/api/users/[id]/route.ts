import { defineRoute, idParam } from '@/lib/api/handler';
import { noContent, ok } from '@/lib/api/response';
import { updateUserSchema } from '@/lib/validation/users';
import { deleteUser, updateUser } from '@/server/services/user.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * PATCH /api/users/:id — Stammdaten, Sprache, Sperrung.
 *
 * Die Rolle lässt sich hier **nicht** ändern; dafür gibt es
 * `PATCH /api/users/:id/role` mit eigener Berechtigung. Wären beide in einem
 * Endpunkt, müsste er das Feld auseinanderdividieren — und würde es
 * irgendwann vergessen.
 */
export const PATCH = defineRoute({
  permissions: ['user:update'],
  params: idParam,
  body: updateUserSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) => {
    const user = await updateUser({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      userId: params.id,
      input: body,
    });
    return ok({ id: user.id, status: user.status });
  },
});

/**
 * DELETE /api/users/:id — in den Papierkorb legen.
 *
 * Weich: ein Konto hängt an Aktivitäten, Nachrichten, Bewertungen und
 * Protokolleinträgen. Ein hartes Löschen risse dort überall Lücken.
 */
export const DELETE = defineRoute({
  permissions: ['user:delete'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) => {
    await deleteUser({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      userId: params.id,
    });
    return noContent();
  },
});
