import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { prisma } from '@/lib/db';
import { openingHoursSchema } from '@/lib/validation/settings';
import { updateOpeningHours } from '@/server/services/company.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/opening-hours */
export const GET = defineRoute({
  permissions: ['company:read'],
  rateLimit: 'apiRead',
  handler: async () =>
    ok(
      await prisma.openingHours.findMany({
        where: { organizationId: await getOrganizationId() },
        orderBy: { weekday: 'asc' },
      }),
    ),
});

/**
 * PUT /api/opening-hours — die Woche setzen.
 *
 * `PUT` statt `PATCH`, weil der Körper den *vollständigen* gewünschten Zustand
 * beschreibt und nicht eine Teiländerung.
 */
export const PUT = defineRoute({
  permissions: ['company:update'],
  body: openingHoursSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) => {
    const hours = await updateOpeningHours({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      hours: body.hours.map((hour) => ({
        weekday: hour.weekday,
        opensAt: hour.opensAt || null,
        closesAt: hour.closesAt || null,
        closed: hour.closed,
        serviceOpensAt: hour.serviceOpensAt || null,
        serviceClosesAt: hour.serviceClosesAt || null,
        serviceClosed: hour.serviceClosed,
      })),
    });
    return ok(hours);
  },
});
