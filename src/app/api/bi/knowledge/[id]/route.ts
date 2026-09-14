import { defineRoute, idParam } from '@/lib/api/handler';
import { noContent, ok } from '@/lib/api/response';
import { prisma } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';
import { updateArticleSchema } from '@/lib/validation/bi-knowledge';
import { articleVisibilityWhere, deleteArticle, updateArticle } from '@/server/services/knowledge.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/bi/knowledge/:id */
export const GET = defineRoute({
  permissions: ['knowledge:read'],
  params: idParam,
  rateLimit: 'apiRead',
  handler: async ({ params, session }) => {
    const article = await prisma.knowledgeArticle.findFirst({
      where: { ...articleVisibilityWhere(session, await getOrganizationId()), id: params.id },
      include: { author: { select: { firstName: true, lastName: true } } },
    });
    if (!article) throw new NotFoundError('Artikel');
    return ok(article);
  },
});

/** PATCH /api/bi/knowledge/:id */
export const PATCH = defineRoute({
  permissions: ['knowledge:update'],
  params: idParam,
  body: updateArticleSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const article = await updateArticle(session, await getOrganizationId(), params.id, body);
    return ok({ id: article.id, slug: article.slug, status: article.status });
  },
});

/** DELETE /api/bi/knowledge/:id — Papierkorb. */
export const DELETE = defineRoute({
  permissions: ['knowledge:delete'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session }) => {
    await deleteArticle(session, await getOrganizationId(), params.id);
    return noContent();
  },
});
