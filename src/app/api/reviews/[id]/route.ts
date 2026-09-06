import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { prisma } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';
import { cache, cacheKeys } from '@/lib/redis';
import { audit } from '@/lib/audit';
import { moderateReviewSchema } from '@/lib/validation/content';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * PATCH /api/reviews/:id
 *
 * Moderation: veröffentlichen, ablehnen, hervorheben, antworten.
 *
 * Nach jeder Änderung wird der Bewertungs-Cache geleert — sonst zeigt die
 * Website noch bis zu 30 Minuten den alten Durchschnitt.
 */
export const PATCH = defineRoute({
  permissions: ['review:moderate'],
  params: idParam,
  body: moderateReviewSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const organizationId = await getOrganizationId();

    const review = await prisma.review.findFirst({
      where: { id: params.id, organizationId },
    });
    if (!review) throw new NotFoundError('Bewertung');

    const updated = await prisma.review.update({
      where: { id: review.id },
      data: {
        ...(body.status ? { status: body.status } : {}),
        ...(body.featured !== undefined ? { featured: body.featured } : {}),
        ...(body.reply ? { reply: body.reply, repliedAt: new Date() } : {}),
      },
    });

    await cache.del(cacheKeys.reviewsSummary(organizationId));

    await audit.updated({
      organizationId,
      userId: session.id,
      entity: 'Review',
      entityId: review.id,
      summary: body.reply
        ? 'Öffentliche Antwort auf Bewertung veröffentlicht'
        : `Bewertung ${body.status ?? (body.featured ? 'hervorgehoben' : 'bearbeitet')}`,
    });

    return ok({ id: updated.id, status: updated.status, featured: updated.featured });
  },
});
