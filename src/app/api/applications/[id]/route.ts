import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { prisma } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';
import { audit } from '@/lib/audit';
import { updateApplicationSchema } from '@/lib/validation/content';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * PATCH /api/applications/:id — Bewerbung im Verfahren weiterbewegen.
 *
 * Bewusst ohne automatische Absage-E-Mail: eine Absage schreibt man selbst,
 * oder man lässt sie den KI-Assistenten entwerfen und liest sie vor dem
 * Versand. Automatisch generierte Absagen kosten Ruf, den ein Betrieb mit
 * ständigem Personalbedarf nicht verschenken kann.
 */
export const PATCH = defineRoute({
  permissions: ['application:update'],
  params: idParam,
  body: updateApplicationSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const organizationId = await getOrganizationId();

    const application = await prisma.jobApplication.findFirst({
      where: { id: params.id, posting: { organizationId } },
      select: { id: true, status: true, firstName: true, lastName: true },
    });
    if (!application) throw new NotFoundError('Bewerbung');

    const updated = await prisma.jobApplication.update({
      where: { id: application.id },
      data: {
        ...(body.status ? { status: body.status } : {}),
        ...(body.rating !== undefined ? { rating: body.rating } : {}),
        ...(body.internalNote !== undefined ? { internalNote: body.internalNote } : {}),
      },
      select: { id: true, status: true, rating: true },
    });

    await audit.updated({
      organizationId,
      userId: session.id,
      entity: 'JobApplication',
      entityId: application.id,
      summary: `Bewerbung ${application.firstName} ${application.lastName}: ${application.status} → ${updated.status}`,
    });

    return ok(updated);
  },
});
