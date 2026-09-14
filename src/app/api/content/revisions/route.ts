import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { contentRevisionsQuery, restoreRevisionSchema } from '@/lib/validation/cms';
import {
  listContentRevisions,
  restoreContentRevision,
} from '@/server/services/content.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * GET /api/content/revisions?key=home.hero.title — Fassungsverlauf.
 *
 * Enthält ausschliesslich Stände, die tatsächlich einmal öffentlich waren.
 * Zwischenstände eines Entwurfs stehen nicht darin — sie zu sammeln hiesse,
 * jedes Tippen zu archivieren, und machte die Liste unbrauchbar für die Frage,
 * die sie beantworten soll: „Was stand vorher auf der Website?"
 */
export const GET = defineRoute({
  permissions: ['content:read', 'content:update'],
  anyPermission: true,
  query: contentRevisionsQuery,
  rateLimit: 'apiRead',
  handler: async ({ query }) => {
    const revisions = await listContentRevisions({
      organizationId: await getOrganizationId(),
      key: query.key,
    });

    return ok(revisions);
  },
});

/**
 * POST /api/content/revisions — eine frühere Fassung zurückholen.
 *
 * Sie landet als Entwurf, nicht auf der Website. Wiederherstellen ist eine
 * Absicht, kein Ergebnis: Man will den alten Text erst sehen und prüfen.
 */
export const POST = defineRoute({
  permissions: ['content:update'],
  body: restoreRevisionSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session }) => {
    const result = await restoreContentRevision({
      organizationId: await getOrganizationId(),
      revisionId: body.revisionId,
      actorId: session.id,
    });

    return ok(result);
  },
});
