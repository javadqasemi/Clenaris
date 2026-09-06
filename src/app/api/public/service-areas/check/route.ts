import { definePublicRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { prisma, toNumber } from '@/lib/db';
import { postalCodeQuery } from '@/lib/validation/queries';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * GET /api/public/service-areas/check?postalCode=3011
 *
 * Beantwortet die häufigste Frage vor der Buchung. Bewusst ohne Rate-Limit-
 * Härte: die Abfrage ist billig, cachefähig und enthält keine schützenswerten
 * Daten.
 */
export const GET = definePublicRoute({
  query: postalCodeQuery,
  rateLimit: 'apiRead',
  handler: async ({ query }) => {
    const organizationId = await getOrganizationId();

    const area = await prisma.serviceArea.findFirst({
      where: { organizationId, postalCode: query.postalCode, active: true },
      select: { city: true, travelFee: true, travelMinutes: true },
    });

    if (!area) return ok({ covered: false });

    return ok({
      covered: true,
      city: area.city,
      travelFee: toNumber(area.travelFee),
      travelMinutes: area.travelMinutes,
    });
  },
});
