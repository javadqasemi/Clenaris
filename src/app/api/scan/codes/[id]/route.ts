import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { can } from '@/lib/auth/rbac';
import { getOrganizationId } from '@/server/services/organization.service';
import { codeSperren, ETIKETT_RECHT } from '@/server/services/scan.service';

export const runtime = 'nodejs';

/**
 * DELETE /api/scan/codes/:id — ein Etikett sperren (verloren, beschädigt,
 * ersetzt). Der Eintrag bleibt als Nachweis stehen; danach löst der Code
 * nichts mehr auf, und ein neues Etikett bekommt einen neuen Code. Wer die
 * Art des Datensatzes nicht pflegen darf, bekommt 404 wie bei einer fremden ID.
 */
export const DELETE = defineRoute({
  permissions: ['inventory:manage', 'equipment:manage', 'property:update', 'job:update'],
  anyPermission: true,
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) => {
    const code = await codeSperren({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      codeId: params.id,
      darf: (art) => can(session.role, ETIKETT_RECHT[art]),
    });
    return ok({ id: code.id, revokedAt: code.revokedAt });
  },
});
