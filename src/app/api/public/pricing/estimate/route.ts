import { definePublicRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { prisma } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';
import { calculatePrice } from '@/lib/pricing/engine';
import { publicEstimateSchema } from '@/lib/validation/booking';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/public/pricing/estimate
 *
 * Sofort-Preisberechnung ohne Anmeldung.
 *
 * Architekturentscheid: Der Endpunkt akzeptiert wahlweise `serviceId` oder
 * `serviceSlug`. Die Website arbeitet mit Slugs (lesbar, stabil in URLs), die
 * Applikation intern mit IDs — beides hier aufzulösen erspart dem Frontend
 * einen zusätzlichen Roundtrip.
 *
 * Das Rate-Limit ist grosszügig (90/Minute), weil der Rechner bei jeder
 * Eingabe neu rechnet; es bremst nur automatisiertes Absaugen der Preislogik.
 */

export const POST = definePublicRoute({
  body: publicEstimateSchema,
  rateLimit: 'priceEstimate',
  handler: async ({ body }) => {
    const organizationId = await getOrganizationId();

    let serviceId = body.serviceId;
    if (!serviceId && body.serviceSlug) {
      const service = await prisma.service.findUnique({
        where: { organizationId_slug: { organizationId, slug: body.serviceSlug } },
        select: { id: true, active: true },
      });
      if (!service?.active) throw new NotFoundError('Dienstleistung');
      serviceId = service.id;
    }

    const breakdown = await calculatePrice(
      {
        serviceId: serviceId!,
        squareMeters: body.squareMeters,
        rooms: body.rooms,
        bathrooms: body.bathrooms,
        windows: body.windows,
        propertyKind: body.propertyKind,
        frequency: body.frequency,
        extras: body.extras,
        scheduledStart: body.scheduledStart,
        postalCode: body.postalCode,
        hasPets: body.hasPets,
        manualHours: body.manualHours,
        couponCode: body.couponCode,
        urgent: body.urgent,
      },
      organizationId,
    );

    return ok(breakdown);
  },
});
