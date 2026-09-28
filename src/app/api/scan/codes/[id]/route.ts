import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { can } from '@/lib/auth/rbac';
import { getOrganizationId } from '@/server/services/organization.service';
import { codeSperren, ETIKETT_RECHT } from '@/server/services/scan.service';

export const runtime = 'nodejs';

/**
 * DELETE /api/scan/codes/:id — ein Etikett sperren (verloren, beschädigt,
 * ersetzt). Der Eintrag bleibt als Nachweis stehen, und ein neues Etikett
 * bekommt einen neuen Code. Wer die Art des Datensatzes nicht pflegen darf,
 * bekommt 404 wie bei einer fremden ID.
 *
 * **Was ein gesperrter Code danach tut** (`nachInternemCode` in
 * `scan.service.ts`): Er löst weiterhin auf — aber nur lesend, mit dem
 * Hinweis „gesperrt" und **ohne Schnellaktionen**. Bis 2026-09-27 stand hier,
 * er löse „nichts mehr auf"; das war nie die Regel. Ein Code, der stumm ins
 * Leere liefe, sähe am Einsatzort aus wie ein Lesefehler: Man scannt noch
 * einmal, tippt die Nummer von Hand ein und arbeitet mit dem alten Aufkleber
 * weiter. Der Hinweis sagt stattdessen, *warum* nichts zu buchen ist, und
 * wer den Datensatz lesen darf, findet ihn. Ohne Leserecht bleibt auch der
 * gesperrte Code stumm (`scan.test.ts`: „gesperrt: Hinweis für wer lesen
 * darf, keine Schnellaktionen mehr; …").
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
