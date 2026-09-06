import { defineRoute, idParam } from '@/lib/api/handler';
import { createPropertySchema } from '@/lib/validation/crm';
import { NotFoundError } from '@/lib/errors';
import { audit, diff } from '@/lib/audit';
import { prisma } from '@/lib/db';
import { noContent, ok } from '@/lib/api/response';
import { softDelete } from '@/server/services/trash.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * DELETE /api/properties/:id — in den Papierkorb legen.
 *
 * Objekte mit geplanten Einsätzen bleiben erhalten.
 *
 * Weich gelöscht: der Datensatz verschwindet aus allen Listen (jede Abfrage
 * filtert `deletedAt: null`), bleibt aber wiederherstellbar. Verknüpfte
 * Datensätze werden **nicht** mitgelöscht — ein Kaskadenlöschen wäre nicht
 * umkehrbar und widerspräche dem Zweck eines Papierkorbs.
 */
export const DELETE = defineRoute({
  permissions: ['property:delete'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) => {
    await softDelete(
      'property',
      { organizationId: await getOrganizationId(), actorId: session.id, ip },
      params.id,
    );
    return noContent();
  },
});

/** GET /api/properties/:id — Objektakte samt Adresse und Einsatzhistorie. */
export const GET = defineRoute({
  permissions: ['property:read'],
  params: idParam,
  rateLimit: 'apiRead',
  handler: async ({ params }) => {
    const organizationId = await getOrganizationId();
    const property = await prisma.property.findFirst({
      where: { id: params.id, deletedAt: null, customer: { organizationId } },
      include: {
        address: true,
        customer: {
          select: { id: true, number: true, firstName: true, lastName: true, companyName: true },
        },
        jobs: {
          where: { deletedAt: null },
          orderBy: { scheduledStart: 'desc' },
          take: 20,
          select: { id: true, number: true, title: true, status: true, scheduledStart: true },
        },
      },
    });
    if (!property) throw new NotFoundError('Objekt');
    return ok(property);
  },
});

/**
 * PATCH /api/properties/:id
 *
 * `customerId` fehlt bewusst: ein Objekt einer anderen Kundschaft zuzuordnen
 * würde seine Einsatzhistorie und die daran hängenden Rechnungen an die
 * falsche Akte binden. Wechselt tatsächlich der Eigentümer, wird ein neues
 * Objekt erfasst und das alte stillgelegt.
 */
export const PATCH = defineRoute({
  permissions: ['property:update'],
  params: idParam,
  body: createPropertySchema.innerType().partial(),
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) => {
    const organizationId = await getOrganizationId();
    const before = await prisma.property.findFirst({
      where: { id: params.id, deletedAt: null, customer: { organizationId } },
    });
    if (!before) throw new NotFoundError('Objekt');

    const property = await prisma.property.update({
      where: { id: params.id },
      data: {
        ...(body.label !== undefined ? { label: body.label } : {}),
        ...(body.kind !== undefined ? { kind: body.kind } : {}),
        ...(body.squareMeters !== undefined ? { squareMeters: body.squareMeters ?? null } : {}),
        ...(body.rooms !== undefined ? { rooms: body.rooms ?? null } : {}),
        ...(body.bathrooms !== undefined ? { bathrooms: body.bathrooms ?? null } : {}),
        ...(body.windows !== undefined ? { windows: body.windows ?? null } : {}),
        ...(body.floor !== undefined ? { floor: body.floor ?? null } : {}),
        ...(body.hasBalcony !== undefined ? { hasBalcony: body.hasBalcony } : {}),
        ...(body.hasGarden !== undefined ? { hasGarden: body.hasGarden } : {}),
        ...(body.hasPets !== undefined ? { hasPets: body.hasPets } : {}),
        ...(body.hasElevator !== undefined ? { hasElevator: body.hasElevator } : {}),
        ...(body.parkingInfo !== undefined ? { parkingInfo: body.parkingInfo ?? null } : {}),
        ...(body.keyLocation !== undefined ? { keyLocation: body.keyLocation ?? null } : {}),
        ...(body.accessNote !== undefined ? { accessNote: body.accessNote ?? null } : {}),
        ...(body.notes !== undefined ? { notes: body.notes ?? null } : {}),
      },
    });

    await audit.updated({
      organizationId,
      userId: session.id,
      entity: 'Property',
      entityId: params.id,
      summary: `Objekt „${property.label}" geändert`,
      changes: diff(before as Record<string, unknown>, property as Record<string, unknown>),
      ip,
    });

    return ok({ id: property.id, label: property.label });
  },
});
