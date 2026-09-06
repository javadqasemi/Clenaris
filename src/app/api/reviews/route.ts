import type { ServiceKind } from '@prisma/client';

import { defineRoute } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { prisma } from '@/lib/db';
import { BusinessRuleError, ForbiddenError, NotFoundError } from '@/lib/errors';
import { createReviewSchema } from '@/lib/validation/crm';
import { getOrganizationId } from '@/server/services/organization.service';
import { notifyStaff } from '@/server/services/notification.service';

export const runtime = 'nodejs';

/** GET /api/reviews — eigene Bewertungen der angemeldeten Kundschaft. */
export const GET = defineRoute({
  permissions: ['review:write_own', 'review:read'],
  anyPermission: true,
  rateLimit: 'apiRead',
  handler: async ({ session }) => {
    const organizationId = await getOrganizationId();

    const customer = await prisma.customer.findFirst({
      where: { userId: session.id },
      select: { id: true },
    });
    if (!customer) throw new ForbiddenError('Kein Kundenkonto verknüpft.');

    const reviews = await prisma.review.findMany({
      where: { organizationId, customerId: customer.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        rating: true,
        title: true,
        body: true,
        status: true,
        reply: true,
        repliedAt: true,
        createdAt: true,
        booking: { select: { id: true, number: true, scheduledStart: true } },
      },
    });

    return ok(reviews);
  },
});

/**
 * POST /api/reviews — Bewertung abgeben.
 *
 * Bewertet werden darf nur, was tatsächlich stattgefunden hat: die Buchung
 * muss der Kundschaft gehören und abgeschlossen sein. Und pro Buchung genau
 * einmal — sonst hebt ein einzelner verärgerter Abend den Schnitt aus den
 * Angeln.
 *
 * Jede Bewertung geht in die Moderation (`PENDING`). Das ist keine Zensur:
 * veröffentlicht wird auch die schlechte, aber erst nachdem der Betrieb sie
 * gesehen und beantwortet hat.
 */
export const POST = defineRoute({
  permissions: ['review:write_own'],
  body: createReviewSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session }) => {
    const organizationId = await getOrganizationId();

    const customer = await prisma.customer.findFirst({
      where: { userId: session.id },
      select: { id: true, firstName: true, lastName: true, companyName: true },
    });
    if (!customer) throw new ForbiddenError('Kein Kundenkonto verknüpft.');

    let serviceKind: ServiceKind | null = null;
    let bookingId: string | null = null;

    if (body.bookingId) {
      const booking = await prisma.booking.findFirst({
        where: { id: body.bookingId, customerId: customer.id },
        select: {
          id: true,
          status: true,
          // Die Leistungsart stammt aus der ersten Position — sie bestimmt,
          // unter welchem Filter die Bewertung auf der Website erscheint.
          items: {
            orderBy: { position: 'asc' },
            take: 1,
            select: { service: { select: { kind: true } } },
          },
          reviews: { select: { id: true }, take: 1 },
        },
      });
      if (!booking) throw new NotFoundError('Buchung');

      if (booking.status !== 'COMPLETED') {
        throw new BusinessRuleError(
          'Bewerten lässt sich ein Termin erst, wenn er abgeschlossen ist.',
        );
      }
      if (booking.reviews.length > 0) {
        throw new BusinessRuleError('Für diesen Termin liegt bereits eine Bewertung vor.');
      }

      bookingId = booking.id;
      serviceKind = booking.items[0]?.service.kind ?? null;
    }

    const authorName =
      body.authorName ??
      customer.companyName ??
      `${customer.firstName} ${customer.lastName.charAt(0)}.`;

    const review = await prisma.review.create({
      data: {
        organizationId,
        customerId: customer.id,
        userId: session.id,
        bookingId,
        authorName,
        rating: body.rating,
        title: body.title ?? null,
        body: body.body,
        serviceKind,
        status: 'PENDING',
        source: 'internal',
      },
      select: { id: true, rating: true, status: true },
    });

    await notifyStaff({
      organizationId,
      title: `Neue Bewertung: ${review.rating} von 5`,
      body: body.title ?? body.body.slice(0, 140),
      link: '/admin/bewertungen',
    });

    return created(review);
  },
});
