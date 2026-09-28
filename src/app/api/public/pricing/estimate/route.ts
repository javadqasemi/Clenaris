import { definePublicRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { prisma } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';
import { calculateBookingPrice } from '@/lib/pricing/engine';
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
  handler: async ({ body, session }) => {
    const organizationId = await getOrganizationId();

    // Ein angemeldetes Kundenkonto bekommt die kundenbezogenen Gutschein-
    // regeln (nur erste Buchung, Einlösungen pro Kundschaft) schon in der
    // Schätzung zu sehen — sonst zeigte die Übersicht „eingelöst" und der
    // Abschluss antwortete mit 422. Personal und Gäste rechnen anonym.
    const customer =
      session?.role === 'CUSTOMER' && session.profileId
        ? await prisma.customer.findFirst({
            where: { id: session.profileId, organizationId },
            select: { id: true, totalBookings: true },
          })
        : null;

    let serviceId = body.serviceId;
    if (!serviceId && body.serviceSlug) {
      const service = await prisma.service.findUnique({
        where: { organizationId_slug: { organizationId, slug: body.serviceSlug } },
        select: { id: true, active: true },
      });
      if (!service?.active) throw new NotFoundError('Dienstleistung');
      serviceId = service.id;
    }

    /**
     * Mehrere Leistungen (Produktsprint 2026-09-26): `leistungen` ersetzt
     * `serviceId`; dieselbe Engine rechnet beide Formen, mit einer Leistung
     * Zeile für Zeile wie zuvor. Angaben auf oberster Ebene (Fläche, Zimmer,
     * Bäder, Fenster) beschreiben das Objekt und gelten für jede Leistung,
     * die keine eigene mitbringt — dieselbe Regel wie beim Buchen
     * (`leistungenAusEingabe`), sonst zeigte die Schätzung einen anderen
     * Preis als den, der gebucht wird.
     */
    const leistungen = body.leistungen?.length
      ? body.leistungen.map((l) => ({
          serviceId: l.serviceId,
          squareMeters: l.squareMeters ?? body.squareMeters ?? null,
          rooms: l.rooms ?? body.rooms ?? null,
          bathrooms: l.bathrooms ?? body.bathrooms ?? null,
          windows: l.windows ?? body.windows ?? null,
          manualHours: l.manualHours ?? null,
          extras: l.extras,
        }))
      : [
          {
            serviceId: serviceId!,
            squareMeters: body.squareMeters,
            rooms: body.rooms,
            bathrooms: body.bathrooms,
            windows: body.windows,
            manualHours: body.manualHours,
            extras: body.extras,
          },
        ];

    const breakdown = await calculateBookingPrice(
      {
        leistungen,
        propertyKind: body.propertyKind,
        frequency: body.frequency,
        scheduledStart: body.scheduledStart,
        postalCode: body.postalCode,
        hasPets: body.hasPets,
        couponCode: body.couponCode,
        customer,
        urgent: body.urgent,
      },
      organizationId,
    );

    return ok(breakdown);
  },
});
