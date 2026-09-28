import { defineRoute, idParam } from '@/lib/api/handler';
import { noContent, ok } from '@/lib/api/response';
import { updateSupplierSchema } from '@/lib/validation/finance';
import { getOrganizationId } from '@/server/services/organization.service';
import { deleteSupplier, updateSupplier } from '@/server/services/supplier.service';

export const runtime = 'nodejs';

/** PATCH /api/suppliers/:id */
export const PATCH = defineRoute({
  permissions: ['supplier:update'],
  params: idParam,
  body: updateSupplierSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) => {
    const organizationId = await getOrganizationId();
    const supplier = await updateSupplier({ organizationId, actorId: session.id, ip, supplierId: params.id, input: body });
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
 * Die Sperre selbst steht in `deleteSupplier` (`supplier.service.ts`).
 */
export const DELETE = defineRoute({
  permissions: ['supplier:delete'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) => {
    const organizationId = await getOrganizationId();
    await deleteSupplier({ organizationId, actorId: session.id, ip, supplierId: params.id });
    return noContent();
  },
});
