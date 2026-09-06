import { z } from 'zod';

import { defineRoute, idParam } from '@/lib/api/handler';
import { noContent, ok } from '@/lib/api/response';
import { prisma } from '@/lib/db';
import { audit, diff } from '@/lib/audit';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { createSupplierSchema } from '@/lib/validation/finance';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * Ändern = Anlegen mit lauter freiwilligen Feldern, plus `active`.
 *
 * `active` fehlt beim Anlegen bewusst: ein neu erfasster Lieferant ist aktiv,
 * alles andere wäre eine Einstellung ohne Anwendungsfall. Beim Ändern ist es
 * der Weg, einen Lieferanten stillzulegen, ohne seine Belege zu verlieren.
 */
const updateSupplierSchema = createSupplierSchema
  .partial()
  .extend({ active: z.boolean().optional() });

/** PATCH /api/suppliers/:id */
export const PATCH = defineRoute({
  permissions: ['supplier:update'],
  params: idParam,
  body: updateSupplierSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) => {
    const organizationId = await getOrganizationId();
    const before = await prisma.supplier.findFirst({
      where: { id: params.id, organizationId },
    });
    if (!before) throw new NotFoundError('Lieferant');

    const empty = (v: string | undefined) => (v && v.trim() !== '' ? v.trim() : null);

    const supplier = await prisma.supplier.update({
      where: { id: params.id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.contactName !== undefined ? { contactName: empty(body.contactName) } : {}),
        ...(body.email !== undefined ? { email: empty(body.email) } : {}),
        ...(body.phone !== undefined ? { phone: empty(body.phone) } : {}),
        ...(body.street !== undefined ? { street: empty(body.street) } : {}),
        ...(body.postalCode !== undefined ? { postalCode: empty(body.postalCode) } : {}),
        ...(body.city !== undefined ? { city: empty(body.city) } : {}),
        ...(body.country !== undefined ? { country: body.country } : {}),
        ...(body.vatNumber !== undefined ? { vatNumber: empty(body.vatNumber) } : {}),
        ...(body.iban !== undefined ? { iban: empty(body.iban) } : {}),
        ...(body.paymentTermDays !== undefined ? { paymentTermDays: body.paymentTermDays } : {}),
        ...(body.notes !== undefined ? { notes: empty(body.notes) } : {}),
        ...(body.active !== undefined ? { active: body.active } : {}),
      },
    });

    await audit.updated({
      organizationId,
      userId: session.id,
      entity: 'Supplier',
      entityId: params.id,
      summary: `Lieferant „${supplier.name}" geändert`,
      changes: diff(before as Record<string, unknown>, supplier as Record<string, unknown>),
      ip,
    });

    return ok({ id: supplier.id, active: supplier.active });
  },
});

/**
 * DELETE /api/suppliers/:id
 *
 * Nur ohne Belege. Eine Ausgabe verweist auf ihren Lieferanten; verschwände er,
 * liesse sich die Ausgabe in der Buchhaltung nicht mehr zuordnen. Ein
 * Lieferant, mit dem man nicht mehr arbeitet, wird auf inaktiv gesetzt — er
 * verschwindet dann aus den Auswahllisten, bleibt aber in alten Belegen lesbar.
 */
export const DELETE = defineRoute({
  permissions: ['supplier:delete'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) => {
    const organizationId = await getOrganizationId();
    const supplier = await prisma.supplier.findFirst({
      where: { id: params.id, organizationId },
      include: { _count: { select: { expenses: true } } },
    });
    if (!supplier) throw new NotFoundError('Lieferant');

    if (supplier._count.expenses > 0) {
      throw new BusinessRuleError(
        `Auf „${supplier.name}" sind ${supplier._count.expenses} Ausgaben gebucht. Setzen Sie den Lieferanten stattdessen ` +
          'auf inaktiv — er verschwindet dann aus den Auswahllisten, bleibt in den Belegen aber lesbar.',
      );
    }

    await prisma.supplier.delete({ where: { id: params.id } });

    await audit.deleted({
      organizationId,
      userId: session.id,
      entity: 'Supplier',
      entityId: params.id,
      summary: `Lieferant „${supplier.name}" gelöscht`,
      ip,
    });

    return noContent();
  },
});
