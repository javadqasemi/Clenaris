import { z } from 'zod';

import { defineRoute, idParam } from '@/lib/api/handler';
import { noContent, ok } from '@/lib/api/response';
import { prisma } from '@/lib/db';
import { audit, diff } from '@/lib/audit';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { createBlogPostSchema } from '@/lib/validation/content';
import { getOrganizationId } from '@/server/services/organization.service';
import { revalidatePath } from 'next/cache';

export const runtime = 'nodejs';

const updateBlogPostSchema = createBlogPostSchema.partial().extend({
  status: z.enum(['DRAFT', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED']).optional(),
});

/** GET /api/blog/:id — ein Beitrag samt Entwurfsfassung. */
export const GET = defineRoute({
  permissions: ['blog:read'],
  params: idParam,
  rateLimit: 'apiRead',
  handler: async ({ params }) => {
    const post = await prisma.blogPost.findFirst({
      where: { id: params.id, organizationId: await getOrganizationId() },
      include: {
        category: { select: { id: true, name: true } },
        author: { select: { firstName: true, lastName: true } },
      },
    });
    if (!post) throw new NotFoundError('Beitrag');
    return ok(post);
  },
});

/**
 * PATCH /api/blog/:id
 *
 * Das Veröffentlichungsdatum entsteht beim ersten Veröffentlichen und ändert
 * sich danach nicht mehr: sonst rutschte ein Beitrag bei jeder Korrektur im
 * Feed und in Suchmaschinen nach oben, als wäre er neu.
 *
 * Der Statuswechsel verlangt `blog:publish`, alles andere `blog:update` —
 * wer Texte redigiert, muss nicht auch veröffentlichen dürfen.
 */
export const PATCH = defineRoute({
  permissions: ['blog:update'],
  params: idParam,
  body: updateBlogPostSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) => {
    const organizationId = await getOrganizationId();
    const before = await prisma.blogPost.findFirst({
      where: { id: params.id, organizationId },
    });
    if (!before) throw new NotFoundError('Beitrag');

    if (body.status && body.status !== before.status) {
      const { can } = await import('@/lib/auth/rbac');
      if (!can(session.role, 'blog:publish')) {
        throw new BusinessRuleError(
          'Für das Veröffentlichen oder Zurückziehen fehlt Ihnen die Berechtigung. Speichern können Sie trotzdem.',
        );
      }
    }

    const publishing = body.status === 'PUBLISHED' && before.status !== 'PUBLISHED';

    const post = await prisma.blogPost.update({
      where: { id: params.id },
      data: {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.excerpt !== undefined ? { excerpt: body.excerpt } : {}),
        ...(body.content !== undefined ? { content: body.content } : {}),
        ...(body.categorySlug !== undefined
          ? {
              // Die Kategorie kommt als Kurzname, nicht als ID: die Redaktion
              // tippt „umzug", nicht eine Zeichenkette aus der Datenbank.
              category: body.categorySlug
                ? { connect: { organizationId_slug: { organizationId, slug: body.categorySlug } } }
                : { disconnect: true },
            }
          : {}),
        ...(body.seoTitle !== undefined ? { seoTitle: body.seoTitle || null } : {}),
        ...(body.seoDescription !== undefined ? { seoDescription: body.seoDescription || null } : {}),
        ...(body.keywords !== undefined ? { keywords: body.keywords } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(publishing ? { publishedAt: before.publishedAt ?? new Date() } : {}),
      },
    });

    await audit.updated({
      organizationId,
      userId: session.id,
      entity: 'BlogPost',
      entityId: params.id,
      summary: `Beitrag „${post.title}" geändert`,
      changes: diff(before as Record<string, unknown>, post as Record<string, unknown>),
      ip,
    });

    revalidatePath('/blog');
    revalidatePath(`/blog/${post.slug}`);
    return ok({ id: post.id, slug: post.slug, status: post.status });
  },
});

/**
 * DELETE /api/blog/:id
 *
 * Ein **veröffentlichter** Beitrag wird archiviert, nicht gelöscht: seine
 * Adresse ist verlinkt und möglicherweise indexiert, und ein gelöschter
 * Beitrag hinterlässt einen toten Link, den niemand mehr findet. Entwürfe
 * lassen sich entfernen.
 */
export const DELETE = defineRoute({
  permissions: ['blog:delete'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) => {
    const organizationId = await getOrganizationId();
    const post = await prisma.blogPost.findFirst({ where: { id: params.id, organizationId } });
    if (!post) throw new NotFoundError('Beitrag');

    if (post.status === 'PUBLISHED') {
      throw new BusinessRuleError(
        `„${post.title}" ist veröffentlicht. Die Adresse /blog/${post.slug} ist verlinkt und möglicherweise indexiert — ` +
          'archivieren Sie den Beitrag stattdessen, dann bleibt der Link erklärbar.',
      );
    }

    await prisma.blogPost.delete({ where: { id: params.id } });

    await audit.deleted({
      organizationId,
      userId: session.id,
      entity: 'BlogPost',
      entityId: params.id,
      summary: `Beitrag „${post.title}" gelöscht (Status ${post.status})`,
      ip,
    });

    revalidatePath('/blog');
    return noContent();
  },
});
