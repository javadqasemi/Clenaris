import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { assignRoleSchema } from '@/lib/validation/users';
import { assignRole } from '@/server/services/user.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * PATCH /api/users/:id/role — Rolle zuweisen.
 *
 * Eigener Endpunkt mit eigener Berechtigung, die nur die Systemverantwortung
 * hat. Drei Sperren im Dienst dahinter, alle mit demselben Zweck: verhindern,
 * dass sich jemand Rechte verschafft oder die Installation unbedienbar macht —
 * nur bis zur eigenen Stufe, nicht die eigene Rolle, und nie die letzte aktive
 * Systemverantwortung.
 */
export const PATCH = defineRoute({
  permissions: ['role:assign'],
  params: idParam,
  body: assignRoleSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) => {
    const user = await assignRole({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      actorRole: session.role,
      ip,
      userId: params.id,
      role: body.role,
    });
    return ok({ id: user.id, role: user.role });
  },
});
