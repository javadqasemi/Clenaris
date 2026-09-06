import { z } from 'zod';

import { defineRoute } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { prisma } from '@/lib/db';
import { slugify } from '@/lib/utils';
import { audit } from '@/lib/audit';
import { createBlogPostSchema } from '@/lib/validation/content';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/blog
 *
 * Legt einen Beitrag als Entwurf an. Der Slug wird aus dem Titel abgeleitet
 * und bei Kollision mit einem Suffix eindeutig gemacht — ein doppelter Slug
 * würde den Unique-Index verletzen und den Speichervorgang abbrechen.
 */
export const POST = defineRoute({
  permissions: ['blog:create'],
  body: createBlogPostSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session }) => {
    const organizationId = await getOrganizationId();

    const baseSlug = slugify(body.title);
    let slug = baseSlug;
    let suffix = 2;

    while (
      await prisma.blogPost.findUnique({
        where: { organizationId_slug_locale: { organizationId, slug, locale: 'DE' } },
        select: { id: true },
      })
    ) {
      slug = `${baseSlug}-${suffix}`;
      suffix++;
    }

    const category = body.categorySlug
      ? await prisma.blogCategory.findUnique({
          where: { organizationId_slug: { organizationId, slug: body.categorySlug } },
          select: { id: true },
        })
      : await prisma.blogCategory.findFirst({ where: { organizationId }, select: { id: true } });

    // Lesezeit aus der Wortzahl: rund 200 Wörter pro Minute.
    const words = body.content.split(/\s+/).length;
    const readingMinutes = Math.max(1, Math.round(words / 200));

    const post = await prisma.blogPost.create({
      data: {
        organizationId,
        categoryId: category?.id ?? null,
        authorId: session.id,
        slug,
        locale: 'DE',
        title: body.title,
        excerpt: body.excerpt,
        content: body.content,
        status: 'DRAFT',
        seoTitle: body.seoTitle ?? null,
        seoDescription: body.seoDescription ?? null,
        keywords: body.keywords,
        readingMinutes,
      },
    });

    await audit.created({
      organizationId,
      userId: session.id,
      entity: 'BlogPost',
      entityId: post.id,
      summary: `Blogentwurf „${post.title}" erstellt`,
    });

    return created({ id: post.id, slug: post.slug, status: post.status });
  },
});

const listQuery = z.object({
  status: z.enum(['DRAFT', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED']).optional(),
  q: z.string().trim().max(120).optional(),
});

/**
 * GET /api/blog — alle Beiträge, auch Entwürfe.
 *
 * Ohne Blätterung: ein Reinigungsbetrieb schreibt keine tausend Artikel, und
 * die Redaktion sucht meist den einen, an dem sie gerade arbeitet.
 */
export const GET = defineRoute({
  permissions: ['blog:read'],
  query: listQuery,
  rateLimit: 'apiRead',
  handler: async ({ query }) => {
    const organizationId = await getOrganizationId();
    return ok(
      await prisma.blogPost.findMany({
        where: {
          organizationId,
          ...(query.status ? { status: query.status } : {}),
          ...(query.q ? { title: { contains: query.q, mode: 'insensitive' } } : {}),
        },
        orderBy: [{ status: 'asc' }, { publishedAt: 'desc' }, { createdAt: 'desc' }],
        select: {
          id: true,
          slug: true,
          title: true,
          excerpt: true,
          status: true,
          coverImage: true,
          readingMinutes: true,
          viewCount: true,
          publishedAt: true,
          updatedAt: true,
          category: { select: { name: true } },
          author: { select: { firstName: true, lastName: true } },
        },
      }),
    );
  },
});
