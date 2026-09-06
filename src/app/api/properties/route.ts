import { z } from 'zod';

import { defineRoute } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { prisma } from '@/lib/db';
import { audit } from '@/lib/audit';
import { NotFoundError } from '@/lib/errors';
import { createPropertySchema } from '@/lib/validation/crm';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

const listQuery = z.object({
  customerId: z.string().min(1).optional(),
  q: z.string().trim().max(120).optional(),
});

/**
 * GET /api/properties — Objekte und Liegenschaften.
 *
 * `Property` trägt kein `organizationId` — die Zugehörigkeit erbt es von der
 * Kundschaft. Der Mandantenfilter läuft deshalb über die Beziehung; ein
 * pauschales `{ organizationId }` fände stillschweigend nichts.
 *
 * Der Alarmcode ist in der Datenbank verschlüsselt und erscheint nicht in der
 * Liste: er gehört auf den Einsatzrapport der zugewiesenen Person, nicht in
 * eine Übersicht.
 */
export const GET = defineRoute({
  permissions: ['property:read'],
  query: listQuery,
  rateLimit: 'apiRead',
  handler: async ({ query }) => {
    const organizationId = await getOrganizationId();
    return ok(
      await prisma.property.findMany({
        where: {
          deletedAt: null,
          customer: { organizationId },
          ...(query.customerId ? { customerId: query.customerId } : {}),
          ...(query.q ? { label: { contains: query.q, mode: 'insensitive' } } : {}),
        },
        orderBy: { label: 'asc' },
        select: {
          id: true,
          label: true,
          kind: true,
          squareMeters: true,
          rooms: true,
          bathrooms: true,
          windows: true,
          floor: true,
          hasPets: true,
          hasElevator: true,
          keyLocation: true,
          accessNote: true,
          notes: true,
          customer: {
            select: { id: true, number: true, firstName: true, lastName: true, companyName: true },
          },
          address: true,
          _count: { select: { jobs: true, bookings: true } },
        },
      }),
    );
  },
});

/**
 * Körper des Anlegens: das Objektschema plus die Kundschaft, zu der es gehört.
 *
 * `z.intersection` statt `.extend()`, weil `createPropertySchema` mit einem
 * `.refine()` endet (Adresse ist Pflicht) und damit kein einfaches
 * `ZodObject` mehr ist. Die Prüfung bleibt dadurch an genau einer Stelle —
 * die Adressregel gilt hier wie überall sonst.
 */
const createPropertyBody = z.intersection(
  createPropertySchema,
  z.object({ customerId: z.string().min(1, 'Eine Kundschaft ist erforderlich.') }),
);

/** POST /api/properties — Objekt erfassen. */
export const POST = defineRoute({
  permissions: ['property:create'],
  body: createPropertyBody,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) => {
    const organizationId = await getOrganizationId();

    // Die Kundschaft muss zum eigenen Mandanten gehören — sonst hinge ein
    // Objekt an einer fremden Akte.
    const owner = await prisma.customer.count({
      where: { id: body.customerId, organizationId, deletedAt: null },
    });
    if (!owner) throw new NotFoundError('Kundschaft');

    /**
     * Adresse: entweder eine bestehende der Kundschaft, oder eine neue.
     *
     * Bei einer bestehenden wird geprüft, dass sie *dieser* Kundschaft
     * gehört. Ohne diese Prüfung liesse sich ein Objekt an eine fremde
     * Adresse hängen — und der Einsatzrapport führte das Team dorthin.
     */
    let addressId = body.addressId ?? null;
    if (addressId) {
      const belongs = await prisma.address.count({
        where: { id: addressId, customerId: body.customerId },
      });
      if (!belongs) throw new NotFoundError('Adresse');
    } else if (body.address) {
      const address = await prisma.address.create({
        data: { ...body.address, customerId: body.customerId },
      });
      addressId = address.id;
    }

    const property = await prisma.property.create({
      data: {
        customerId: body.customerId,
        addressId,
        label: body.label,
        kind: body.kind,
        squareMeters: body.squareMeters ?? null,
        rooms: body.rooms ?? null,
        bathrooms: body.bathrooms ?? null,
        windows: body.windows ?? null,
        floor: body.floor ?? null,
        hasBalcony: body.hasBalcony,
        hasGarden: body.hasGarden,
        hasPets: body.hasPets,
        hasElevator: body.hasElevator,
        parkingInfo: body.parkingInfo ?? null,
        keyLocation: body.keyLocation ?? null,
        accessNote: body.accessNote ?? null,
        notes: body.notes ?? null,
      },
    });

    await audit.created({
      organizationId,
      userId: session.id,
      entity: 'Property',
      entityId: property.id,
      summary: `Objekt „${property.label}" erfasst`,
      ip,
    });

    return created({ id: property.id, label: property.label });
  },
});
