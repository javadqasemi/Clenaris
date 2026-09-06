import { definePublicRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { prisma, toNumber } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';
import { availabilityCheckQuery } from '@/lib/validation/queries';
import { getAvailableSlots } from '@/server/services/availability.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * GET /api/public/availability?serviceId=…&date=2026-09-12
 *
 * Liefert die buchbaren Zeitfenster eines Tages. Die Einsatzdauer wird aus den
 * Stammdaten der Dienstleistung abgeleitet, sofern sie nicht mitgegeben wird —
 * so muss das Frontend die Kapazitätslogik nicht kennen.
 */
export const GET = definePublicRoute({
  query: availabilityCheckQuery,
  rateLimit: 'apiRead',
  handler: async ({ query }) => {
    const organizationId = await getOrganizationId();

    const service = await prisma.service.findFirst({
      where: { id: query.serviceId, organizationId, active: true },
      select: {
        defaultDurationMin: true,
        minutesPerSqm: true,
        minHours: true,
        defaultCrewSize: true,
      },
    });
    if (!service) throw new NotFoundError('Dienstleistung');

    // Dauer schätzen, damit die Slot-Breite realistisch ist.
    const estimated = query.squareMeters
      ? Math.round(query.squareMeters * toNumber(service.minutesPerSqm))
      : service.defaultDurationMin;

    const durationMin =
      query.durationMin ?? Math.max(Math.round(toNumber(service.minHours) * 60), estimated);

    const result = await getAvailableSlots({
      organizationId,
      date: query.date,
      durationMin,
      crewSize: query.crewSize ?? service.defaultCrewSize,
    });

    return ok(result);
  },
});
