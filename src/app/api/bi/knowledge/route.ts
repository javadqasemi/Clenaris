import { defineRoute } from '@/lib/api/handler';
import { buildPagination, created, paginated } from '@/lib/api/response';
import { articleListQuery, createArticleSchema } from '@/lib/validation/bi-knowledge';
import { createArticle, listArticles } from '@/server/services/knowledge.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/bi/knowledge — Wissensartikel im Rahmen der Sichtbarkeit. */
export const GET = defineRoute({
  permissions: ['knowledge:read'],
  query: articleListQuery,
  rateLimit: 'apiRead',
  handler: async ({ query, session }) => {
    const { items, total } = await listArticles(session, await getOrganizationId(), query);
    return paginated(items, buildPagination(query.page, query.pageSize, total));
  },
});

/** POST /api/bi/knowledge */
export const POST = defineRoute({
  permissions: ['knowledge:create'],
  body: createArticleSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session }) => {
    const article = await createArticle(session, await getOrganizationId(), body);
    return created({ id: article.id, slug: article.slug });
  },
});
